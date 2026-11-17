// End-to-end Rust release proof with a DISPOSABLE crate and an ISOLATED registry (nothing touches crates.io).
//
//   Git authority   : a bare repository holding a disposable Cargo workspace (boundry-proof-core + a consumer)
//   Cargo registry  : tools/release-proof/crates-standin.ts (sparse index + publish API), seeded with 0.1.0 and a
//                     YANKED 0.1.1; the first publish response is lost on purpose (an ambiguous publish)
//   Execution       : Boundry CI from ../boundry-ci (FeltDB, control plane, worker, Docker, Rust toolchain image),
//                     with a build-only token (executions:submit, runs:read, artifacts:read)
//   Approval        : signed with an SSH key registered to the approver for this proof only
//   Consumer        : a separate Cargo project resolving the release from the registry, built and run by Cargo
//
// Usage: node tools/release-proof/run-proof-crates.ts <boundry-ci checkout> <out dir>
import { spawn, execFileSync, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PackageConfig, Principal } from "../../src/contracts.ts";
import { ReleaseManager } from "../../src/release/manager.ts";
import { CratesRegistry, GitCli, BoundryCiExecutor, type ReleasesAdapter } from "../../src/release/adapters.ts";
import { approvalRequest } from "../../src/release/cli.ts";
import { signWithKeyFile } from "../../src/governance/signatures.ts";
import { startCratesStandIn } from "./crates-standin.ts";

const run = promisify(execFile);
const [ciDir, outDir] = process.argv.slice(2) as [string, string];
const REPO = "boundry-proof/crates";
const FELTDB_PORT = "7791", CONTROL = "127.0.0.1:21091";
const base = mkdtempSync(join(tmpdir(), "crates-proof-"));
const procs: ChildProcess[] = [];
const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const log = (s: string) => console.log(`[proof] ${s}`);
const wait = async (url: string, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout waiting for ${url}`); };
const secretFile = (name: string, value: string) => { const p = join(base, "secrets", name); mkdirSync(join(base, "secrets"), { recursive: true }); writeFileSync(p, value, { mode: 0o600 }); chmodSync(p, 0o600); return p; };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const workspace = (version: string) => ({
  "Cargo.toml": `[workspace]\nmembers = ["crates/core", "crates/app"]\nresolver = "2"\n`,
  "crates/core/Cargo.toml": `[package]\nname = "boundry-proof-core"\nversion = "${version}"\nedition = "2021"\nlicense = "MIT"\ndescription = "Disposable crate for the Boundry release proof"\nrepository = "https://example.invalid/boundry-proof"\n\n[dependencies]\n`,
  "crates/core/src/lib.rs": `/// The answer.\npub fn answer() -> u32 { 42 }\n\n#[cfg(test)]\nmod tests { #[test] fn answer_is_42() { assert_eq!(super::answer(), 42); } }\n`,
  "crates/app/Cargo.toml": `[package]\nname = "boundry-proof-app"\nversion = "0.1.0"\nedition = "2021"\nlicense = "MIT"\npublish = false\n\n[dependencies]\nboundry-proof-core = { version = "0.1", path = "../core" }\n`,
  "crates/app/src/main.rs": `fn main() { println!("{}", boundry_proof_core::answer()); }\n`,
});
const writeTree = (dir: string, files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); } };

const standIn = await startCratesStandIn(join(base, "registry"), "proof-registry-token");
try {
  // ── 1. Git authority: the disposable workspace at 0.1.0 with a real Cargo.lock ──
  const work = join(base, "src");
  writeTree(work, workspace("0.1.0"));
  sh("cargo", ["generate-lockfile", "--offline"], { cwd: work });
  sh("git", ["init", "-q", "-b", "main", work]);
  sh("git", ["-C", work, "add", "-A"]);
  sh("git", ["-C", work, "-c", "user.name=proof", "-c", "user.email=proof@boundry.invalid", "commit", "-q", "-m", "boundry-proof-core 0.1.0"]);
  const bare = join(base, "git", `${REPO}.git`);
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  sh("git", ["-C", work, "push", "-q", bare, "HEAD:refs/heads/main"]);
  const sourceCommit = sh("git", ["-C", bare, "rev-parse", "main"]).trim();
  log(`git authority: ${REPO} main=${sourceCommit.slice(0, 12)} (disposable workspace)`);

  // ── 2. Registry: seeded with 0.1.0 and 0.1.1 (packaged by cargo), then 0.1.1 yanked ──
  const reg = new CratesRegistry(standIn.url, `${standIn.url}/index`, "proof-registry-token");
  for (const v of ["0.1.0", "0.1.1"]) {
    const d = mkdtempSync(join(tmpdir(), "seed-"));
    writeTree(d, workspace(v));
    sh("cargo", ["generate-lockfile", "--offline"], { cwd: d });
    sh("cargo", ["package", "--offline", "--locked", "-p", "boundry-proof-core", "--allow-dirty", "-q"], { cwd: d });
    await reg.publish(join(d, "target", "package", `boundry-proof-core-${v}.crate`));
  }
  standIn.yank("boundry-proof-core", "0.1.1");
  const seeded = await reg.state("boundry-proof-core");
  const seededCksum = Object.fromEntries(await Promise.all(["0.1.0", "0.1.1"].map(async (v) => [v, (await reg.version("boundry-proof-core", v))!.integrity])));
  log(`registry: ${standIn.url} versions ${seeded!.versions.join(", ")}; yanked ${seeded!.yanked.join(", ")}`);

  // ── 3. Boundry CI ──
  const fdb = join(base, "feltdb");
  sh(join(ciDir, "tools/feltdb-dev.sh"), [fdb, FELTDB_PORT], { env: { ...process.env, FELTDB_SERVER_BIN: process.env.FELTDB_SERVER_BIN ?? "/home/user/flow_db/target/release/feltdb-server" } });
  chmodSync(join(fdb, "token"), 0o600);
  const verifier = randomBytes(24).toString("hex"), submitter = randomBytes(24).toString("hex");
  const ciEnv = {
    ...process.env, NODE_NO_WARNINGS: "1",
    BCI_FELTDB_URL: `http://127.0.0.1:${FELTDB_PORT}`, BCI_FELTDB_TOKEN_FILE: join(fdb, "token"),
    BCI_WEBHOOK_SECRET_FILE: secretFile("webhook", randomBytes(16).toString("hex")),
    BCI_OPERATOR_TOKENS_FILE: secretFile("operators", `${sha256(Buffer.from(verifier))} proof-verifier\n${sha256(Buffer.from(submitter))} boundry-maintenance executions:submit,runs:read,artifacts:read\n`),
    BCI_SECRETS_DIR: join(base, "repo-secrets"), BCI_DATA_DIR: join(base, "ci-data"), BCI_LISTEN: CONTROL, BCI_CAS_MIN_FREE_BYTES: "0",
    BCI_SCM: "git", BCI_GIT_URL_TEMPLATE: `file://${join(base, "git")}/{repo}.git`, BCI_LEASE_MS: "60000",
  };
  mkdirSync(join(base, "repo-secrets"), { recursive: true, mode: 0o750 });
  procs.push(spawn("node", [join(ciDir, "bin/boundry-ci.ts"), "control"], { env: ciEnv, stdio: ["ignore", "ignore", "inherit"] }));
  await wait(`http://${CONTROL}/readyz`);
  const workerToken = sh("node", [join(ciDir, "bin/boundry-ci.ts"), "admin", "create-worker", "proof-worker", "linux-small", "linux-build"], { env: ciEnv }).trim().split("\n").pop()!;
  mkdirSync(join(base, "work"), { recursive: true });
  procs.push(spawn("node", [join(ciDir, "bin/boundry-ci.ts"), "worker"], { env: { ...ciEnv, BCI_CONTROL_URL: `http://${CONTROL}`, BCI_WORKER_TOKEN_FILE: secretFile("worker", workerToken), BCI_CAPABILITIES: "linux-small,linux-build", BCI_WORK_ROOT: join(base, "work"), BCI_OCI_CLI: "docker", BCI_EGRESS_CA_FILE: process.env.BCI_EGRESS_CA_FILE ?? "" }, stdio: ["ignore", "ignore", "inherit"] }));
  log("execution: Boundry CI control plane + worker (git source, Docker, boundry-toolchain/rust:1)");

  // ── 4. Principals for this proof: the approver's key is generated here and registered ──
  const keyFile = join(base, "approver-key");
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "randy (proof key)", "-f", keyFile]);
  const principals = [
    Principal.parse({ id: "randy", name: "Randy", type: "person", roles: ["admin", "prod_approver"], keys: [readFileSync(`${keyFile}.pub`, "utf8").trim()] }),
    Principal.parse({ id: "maintenance-agent", name: "Maintenance agent", type: "agent", roles: ["agent"] }),
    Principal.parse({ id: "component:release-executor", name: "Release executor", type: "component", roles: ["executor"] }),
  ];
  const noGitHub: ReleasesAdapter = { find: async () => { throw new Error("not used"); }, create: async () => { throw new Error("not used"); } };
  const catalog = [PackageConfig.parse({ id: "boundry-proof-core", name: "boundry-proof-core", registry: "crates", ownership: "owned", repository: REPO, directory: "crates/core", release: { approvers: ["randy"], githubRelease: false } })];
  const m = new ReleaseManager({
    dataDir: join(base, "maintenance-data"), runtimeDir: join(base, "release-runtime"), catalog, principals, installations: [], pollMs: 2000, buildTimeoutMs: 20 * 60_000,
    testRegistries: [standIn.url],
    registry: () => reg,
    git: (repo) => new GitCli(`file://${join(base, "git")}/${repo}.git`, join(base, "release-runtime", "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
    releases: noGitHub,
    executor: new BoundryCiExecutor(`http://${CONTROL}`, submitter),
  });

  // ── 5. Plan (agent) → refusals → signed approval (person) → execution with a lost publish answer ──
  const planned = await m.plan({ packages: ["boundry-proof-core"], bump: "patch", requestedBy: "maintenance-agent", reason: "End-to-end proof of a Rust release (disposable crate, isolated registry)" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "1-approval-request.md"), approvalRequest(planned) + "\n");
  log(`planned ${planned.id}: ${planned.plan.packages[0]!.registryVersions.highest} (yanked ${planned.plan.packages[0]!.registryVersions.yanked.join(", ")}) → ${planned.plan.packages[0]!.proposedVersion}`);
  const refusals: string[] = [];
  for (const [what, f] of [["approval by maintenance-agent", () => m.approve(planned.id, "maintenance-agent", planned.planDigest)], ["execution triggered by maintenance-agent", () => m.execute(planned.id, "maintenance-agent")], ["approval by randy with a signature over a different statement", async () => m.approve(planned.id, "randy", planned.planDigest, await signWithKeyFile(keyFile, (await m.statement(planned.id, "randy")).replace(planned.planDigest, "0".repeat(64))))]] as const) {
    try { await f(); refusals.push(`${what}: NOT REFUSED`); } catch (e) { refusals.push(`${what}: refused: ${(e as Error).message}`); }
  }
  for (const x of refusals) log(x);
  const statement = await m.statement(planned.id, "randy");
  writeFileSync(join(outDir, "2-approval-statement.json"), statement);
  const signature = await signWithKeyFile(keyFile, statement);
  writeFileSync(join(outDir, "2-approval-statement.json.sig"), signature);
  await m.approve(planned.id, "randy", planned.planDigest, signature);
  standIn.loseNextPublishResponse();
  const t0 = Date.now();
  const done = await m.execute(planned.id, "randy");
  log(`execute → ${done.state} in ${Math.round((Date.now() - t0) / 1000)}s${done.failure ? ` (${done.failure.reason})` : ""}`);

  // ── 6. A consumer (separate Cargo project) resolves the release from the registry, builds and runs ──
  const consumer = join(base, "consumer");
  writeTree(consumer, {
    ".cargo/config.toml": `[registries.standin]\nindex = "sparse+${standIn.url}/index/"\n`,
    "Cargo.toml": `[package]\nname = "proof-consumer"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\nboundry-proof-core = { version = "0.1", registry = "standin" }\n`,
    "src/main.rs": `fn main() { println!("{}", boundry_proof_core::answer()); }\n`,
  });
  const cenv = { ...process.env, CARGO_HOME: join(consumer, ".cargo-home") };
  await run("cargo", ["generate-lockfile"], { cwd: consumer, env: cenv });
  const resolved = /name = "boundry-proof-core"\nversion = "([^"]+)"/.exec(readFileSync(join(consumer, "Cargo.lock"), "utf8"))?.[1] ?? null;
  const output = (await run("cargo", ["run", "-q"], { cwd: consumer, env: cenv })).stdout.trim();
  log(`consumer: Cargo resolved boundry-proof-core ${resolved}; the program printed ${output}`);
  // The consumer's own check (cargo run printing 42) as an evidence record for its commit, in the shape Maintenance's
  // scan writes for a project's configured workflows. A proof-local stand-in for the consumer's CI.
  const consumerCommit = "proof-consumer-local";
  const observed = done.state === "released" ? await m.observeConsumers(planned.id,
    [{ project: "proof-consumer", package: "boundry-proof-core", repository: "boundry-proof/consumer", manifest: "Cargo.toml", root: ".", registry: "crates", name: "boundry-proof-core", commit: consumerCommit, declaredVersion: "0.1", resolvedVersion: resolved, ecosystem: "rust", kind: "dependencies" } as any],
    "proof: cargo generate-lockfile in a separate consumer project",
    [{ project: "proof-consumer", repository: "boundry-proof/consumer", commit: consumerCommit, collectedAt: new Date().toISOString(), scanRun: null, passed: output === "42", checks: { resolution: "pass", workflows: output === "42" ? "pass" : "fail" }, runs: [{ workflow: "cargo run (proof stand-in for the consumer's CI)", runId: 1, url: "local:proof", status: "completed", conclusion: output === "42" ? "success" : "failure", headSha: consumerCommit }], resolved: { ".|crates:boundry-proof-core": resolved ?? "" } }]) : done;
  writeFileSync(join(outDir, "3-release-record.json"), JSON.stringify(observed, null, 2) + "\n");
  writeFileSync(join(outDir, "4-final-report.md"), approvalRequest(observed) + "\n");

  // ── 7. Independent verification: each authority asked directly ──
  const v: Record<string, unknown> = {};
  const pp = done.plan.packages[0]!;
  const art = done.facts.build?.artifacts[0];
  const head = sh("git", ["-C", bare, "rev-parse", "refs/heads/main"]).trim();
  const tagTarget = sh("git", ["-C", bare, "rev-parse", `${pp.tag}^{commit}`]).trim();
  v.git = {
    approvedSource: sourceCommit, branchHead: head, parentOfHead: sh("git", ["-C", bare, "rev-parse", `${head}^`]).trim(), releaseCommit: done.facts.releaseCommit,
    tag: pp.tag, tagTarget, tagIsReleaseCommit: tagTarget === done.facts.releaseCommit,
    cargoTomlVersionAtTag: /^version = "([^"]+)"/m.exec(sh("git", ["-C", bare, "show", `${pp.tag}:crates/core/Cargo.toml`]))?.[1],
    cargoLockVersionAtTag: /name = "boundry-proof-core"\nversion = "([^"]+)"/.exec(sh("git", ["-C", bare, "show", `${pp.tag}:Cargo.lock`]))?.[1],
    filesChanged: sh("git", ["-C", bare, "diff", "--name-only", `${sourceCommit}..${head}`]).trim().split("\n"),
  };
  const index = (await (await fetch(`${standIn.url}/index/bo/un/boundry-proof-core`)).text()).trim().split("\n").map((l) => JSON.parse(l));
  const entry = index.find((x) => x.vers === pp.proposedVersion);
  const served = Buffer.from(await (await fetch(`${standIn.url}/api/v1/crates/boundry-proof-core/${pp.proposedVersion}/download`)).arrayBuffer());
  v.registry = {
    versions: index.map((x) => `${x.vers}${x.yanked ? " (yanked)" : ""}`), published: !!entry, yanked: entry?.yanked,
    cksum: entry?.cksum, cksumMatchesBuiltCrate: entry?.cksum === art?.sha256, servedBytesSha256: sha256(served), servedBytesMatchBuiltCrate: sha256(served) === art?.sha256,
    earlierVersionsUntouched: ["0.1.0", "0.1.1"].every((x) => index.find((y) => y.vers === x)?.cksum === seededCksum[x]), yankedStillYanked: index.find((y) => y.vers === "0.1.1")?.yanked === true,
    publishRequestsReceived: standIn.publishes() - 2, // minus the two seeds
  };
  const ev: any = await (await fetch(`http://${CONTROL}/v1/runs/${done.facts.build?.runId}/evidence`, { headers: { authorization: `Bearer ${verifier}` } })).json();
  writeFileSync(join(outDir, "5-execution-evidence.json"), JSON.stringify(ev, null, 2) + "\n");
  v.execution = { runId: ev.run?.id, state: ev.run?.state, commitBuilt: ev.run?.sha, isReleaseCommit: ev.run?.sha === done.facts.releaseCommit, jobs: ev.jobs?.map((j: any) => ({ key: j.key, state: j.state, artifacts: j.attempts.at(-1)?.artifacts })) };
  v.consumer = { resolved, output, adoption: observed.consumers.at(-1)?.adoption, verification: observed.consumers.at(-1)?.verification };
  v.lifecycle = done.history.map((h) => h.state);
  v.attempts = done.attempts.map((a) => `${a.step} ${a.outcome}: ${a.detail}`);
  v.governance = { proposedBy: `${done.plan.requestedBy} (${done.plan.requestedByType})`, approvals: done.approvals.map((a) => ({ by: a.by, principalType: a.principalType, authentication: a.authentication })), refusals };
  v.checks = done.plan.checks;
  writeFileSync(join(outDir, "6-independent-verification.json"), JSON.stringify(v, null, 2) + "\n");
  console.log(JSON.stringify(v, null, 2));
} finally {
  standIn.server.close(); standIn.server.closeAllConnections();
  for (const p of procs) p.kill("SIGTERM");
  try { execFileSync("bash", ["-c", `kill $(cat ${join(base, "feltdb", "pid")}) 2>/dev/null || true`]); } catch { /* gone */ }
}
