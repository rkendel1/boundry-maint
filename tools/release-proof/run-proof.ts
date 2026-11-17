// End-to-end release proof: Boundry Maintenance plans, approves and executes a release of a REAL package's REAL
// source, using the REAL execution substrate (Boundry CI: control plane, worker, hardened containers) and a REAL
// npm registry implementation (Verdaccio) seeded with the package's REAL published tarballs.
//
//   Git authority      : a bare repository seeded with rkendel1/resolver at its real commit (stand-in for GitHub git)
//   npm authority      : Verdaccio 6.2.4 (stand-in for registry.npmjs.org; nothing is published to npmjs.org)
//   Execution          : Boundry CI from ../boundry-ci (feltdb-server, control plane, worker, Docker executor)
//   GitHub Releases    : an in-process stand-in (this environment cannot write to GitHub)
//
// Usage: node tools/release-proof/run-proof.ts <resolver checkout> <boundry-ci checkout> <verdaccio bin> <out dir>
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PackageCatalog, InstallationsFile, ReleasePolicy, PrincipalCatalog } from "../../src/contracts.ts";
import { ReleaseManager } from "../../src/release/manager.ts";
import { NpmRegistry, GitCli, GitHubReleases, BoundryCiExecutor } from "../../src/release/adapters.ts";
import { approvalRequest } from "../../src/release/cli.ts";
import { fetchNpmPackage } from "../../src/collectors/npm.ts";
import { classify } from "../../src/version/compare.ts";

const [resolverDir, ciDir, verdaccioBin, outDir] = process.argv.slice(2) as [string, string, string, string];
const root = new URL("../..", import.meta.url).pathname;
// The resolver release train: the planner refuses core alone (workspace siblings pin it exactly).
const REPO = "rkendel1/resolver";
const PKGS = [
  { id: "appport-resolver-core", name: "@appport/resolver-core", dir: "packages/core" },
  { id: "appport-resolver-client", name: "@appport/resolver-client", dir: "packages/client" },
  { id: "appport-resolver", name: "@appport/resolver", dir: "packages/server" },
];
const base = mkdtempSync(join(tmpdir(), "release-proof-"));
const procs: ChildProcess[] = [];
// GitHub stand-in: its URLs say "stand-in" so no evidence can be mistaken for a real github.com release.
let gh: ReturnType<typeof createServer> | undefined;
const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const log = (s: string) => console.log(`[proof] ${s}`);
const wait = async (url: string, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout waiting for ${url}`); };
const secretFile = (name: string, value: string) => { const p = join(base, "secrets", name); mkdirSync(join(base, "secrets"), { recursive: true }); writeFileSync(p, value, { mode: 0o600 }); chmodSync(p, 0o600); return p; };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

try {
  // ── 1. Git authority: bare repository with the real source ──
  const sourceCommit = sh("git", ["-C", resolverDir, "rev-parse", "HEAD"]).trim();
  const bare = join(base, "git", `${REPO}.git`);
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", "-b", "main", bare]);
  for (const [k, v] of [["uploadpack.allowAnySHA1InWant", "true"], ["receive.shallowUpdate", "true"]]) sh("git", ["-C", bare, "config", k!, v!]);
  sh("git", ["-C", resolverDir, "push", "-q", bare, `${sourceCommit}:refs/heads/main`]);
  log(`git authority: ${bare} main=${sourceCommit.slice(0, 12)} (real rkendel1/resolver commit)`);

  // ── 2. npm authority: Verdaccio seeded with the real published tarballs ──
  const vd = join(base, "verdaccio");
  mkdirSync(join(vd, "storage"), { recursive: true });
  writeFileSync(join(vd, "config.yaml"), `storage: ${vd}/storage\nauth:\n  htpasswd:\n    file: ${vd}/htpasswd\n    max_users: 10\nuplinks: {}\npackages:\n  '@*/*':\n    access: $all\n    publish: $authenticated\n  '**':\n    access: $all\n    publish: $authenticated\nlog: { type: stdout, format: pretty, level: warn }\nlisten: 127.0.0.1:4874\n`);
  procs.push(spawn(verdaccioBin, ["--config", join(vd, "config.yaml")], { stdio: "ignore" }));
  await wait("http://127.0.0.1:4874/-/ping");
  const user = await (await fetch("http://127.0.0.1:4874/-/user/org.couchdb.user:releaser", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "releaser", password: randomBytes(12).toString("hex") }) })).json() as { token: string };
  const npmTokenFile = secretFile("npm-token", user.token);
  const seedRc = join(vd, "npmrc");
  writeFileSync(seedRc, `//127.0.0.1:4874/:_authToken=${user.token}\n`, { mode: 0o600 });
  const seeded: Record<string, Record<string, { npmjsIntegrity: string; standInIntegrity?: string }>> = {};
  for (const pkg of PKGS) {
    const real: any = await (await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}`)).json();
    const versions = Object.keys(real.versions).sort((a, b) => Date.parse(real.time[a]) - Date.parse(real.time[b]));
    seeded[pkg.name] = {};
    for (const v of versions) {
      const bytes = Buffer.from(await (await fetch(real.versions[v].dist.tarball)).arrayBuffer());
      const f = join(vd, `seed-${pkg.id}-${v}.tgz`);
      writeFileSync(f, bytes);
      const tag = v === real["dist-tags"].latest ? "latest" : `seed-${v.replace(/\./g, "-")}`;
      sh("npm", ["publish", f, "--registry", "http://127.0.0.1:4874/", "--tag", tag, "--ignore-scripts"], { env: { ...process.env, npm_config_userconfig: seedRc } });
      seeded[pkg.name]![v] = { npmjsIntegrity: real.versions[v].dist.integrity };
    }
    const standIn: any = await (await fetch(`http://127.0.0.1:4874/${pkg.name.replace("/", "%2f")}`)).json();
    for (const v of versions) seeded[pkg.name]![v]!.standInIntegrity = standIn.versions[v]?.dist?.integrity;
    log(`npm authority: ${pkg.name} seeded with ${versions.join(", ")} — integrity identical to npmjs.org: ${versions.every((v) => seeded[pkg.name]![v]!.npmjsIntegrity === seeded[pkg.name]![v]!.standInIntegrity)}; latest=${standIn["dist-tags"].latest}`);
  }

  // ── 3. Execution substrate: Boundry CI ──
  const fdb = join(base, "feltdb");
  const fdbOut = sh(join(ciDir, "tools/feltdb-dev.sh"), [fdb, "7790"], { env: { ...process.env, FELTDB_SERVER_BIN: process.env.FELTDB_SERVER_BIN ?? "/home/user/flow_db/target/release/feltdb-server" } });
  void fdbOut;
  chmodSync(join(fdb, "token"), 0o600);
  const operator = randomBytes(24).toString("hex"); // admin: used only by this script's independent verification
  const submitter = randomBytes(24).toString("hex"); // the Release Manager's token: build-only, its own runs
  const ciEnv = {
    ...process.env, NODE_NO_WARNINGS: "1",
    BCI_FELTDB_URL: "http://127.0.0.1:7790", BCI_FELTDB_TOKEN_FILE: join(fdb, "token"),
    BCI_WEBHOOK_SECRET_FILE: secretFile("webhook", randomBytes(16).toString("hex")),
    BCI_OPERATOR_TOKENS_FILE: secretFile("operators", `${createHash("sha256").update(operator).digest("hex")} proof-verifier\n${createHash("sha256").update(submitter).digest("hex")} boundry-maintenance executions:submit,runs:read,artifacts:read\n`),
    BCI_SECRETS_DIR: join(base, "repo-secrets"), BCI_DATA_DIR: join(base, "ci-data"), BCI_LISTEN: "127.0.0.1:21090", BCI_CAS_MIN_FREE_BYTES: "0",
    BCI_SCM: "git", BCI_GIT_URL_TEMPLATE: `file://${join(base, "git")}/{repo}.git`, BCI_LEASE_MS: "60000",
  };
  mkdirSync(join(base, "repo-secrets"), { recursive: true, mode: 0o750 });
  procs.push(spawn("node", [join(ciDir, "bin/boundry-ci.ts"), "control"], { env: ciEnv, stdio: ["ignore", "ignore", "inherit"] }));
  await wait("http://127.0.0.1:21090/readyz");
  const workerToken = sh("node", [join(ciDir, "bin/boundry-ci.ts"), "admin", "create-worker", "proof-worker", "linux-small", "linux-build"], { env: ciEnv }).trim().split("\n").pop()!;
  const workerEnv = { ...ciEnv, BCI_CONTROL_URL: "http://127.0.0.1:21090", BCI_WORKER_TOKEN_FILE: secretFile("worker", workerToken), BCI_CAPABILITIES: "linux-small,linux-build", BCI_WORK_ROOT: join(base, "work"), BCI_OCI_CLI: "docker", BCI_EGRESS_CA_FILE: process.env.BCI_EGRESS_CA_FILE ?? "" };
  mkdirSync(join(base, "work"), { recursive: true });
  procs.push(spawn("node", [join(ciDir, "bin/boundry-ci.ts"), "worker"], { env: workerEnv, stdio: ["ignore", "ignore", "inherit"] }));
  log("execution substrate: Boundry CI control plane + worker running (git source adapter, Docker executor)");

  // ── 4. GitHub Releases stand-in ──
  const ghReleases: { tag: string; name: string; body: string; at: string }[] = [];
  gh = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const m = /^\/repos\/([^/]+\/[^/]+)\/releases(?:\/tags\/(.+))?$/.exec(req.url ?? "");
    if (m && req.method === "GET" && m[2]) { const r = ghReleases.find((x) => x.tag === decodeURIComponent(m[2]!)); res.writeHead(r ? 200 : 404, { "content-type": "application/json" }); return res.end(JSON.stringify(r ? { tag_name: r.tag, html_url: `http://${req.headers.host}/stand-in/${m[1]}/releases/tag/${encodeURIComponent(r.tag)}` } : { message: "Not Found" })); }
    if (m && req.method === "POST") { const b = JSON.parse(raw); ghReleases.push({ tag: b.tag_name, name: b.name, body: b.body, at: new Date().toISOString() }); res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify({ html_url: `http://${req.headers.host}/stand-in/${m[1]}/releases/tag/${encodeURIComponent(b.tag_name)}` })); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => gh!.listen(0, "127.0.0.1", r));
  const ghUrl = `http://127.0.0.1:${(gh.address() as any).port}`;

  // ── 5. Boundry Maintenance: plan → approval request → approve → execute ──
  const dataDir = join(base, "maintenance-data");
  cpSync(join(root, "data"), dataDir, { recursive: true });
  const catalog = PackageCatalog.parse(JSON.parse(readFileSync(join(root, "config/packages.json"), "utf8"))).packages
    .map((p) => (PKGS.some((x) => x.id === p.id) ? { ...p, release: ReleasePolicy.parse({ approvers: ["randy"] }) } : p));
  const installations = InstallationsFile.parse(JSON.parse(readFileSync(join(dataDir, "installations.json"), "utf8"))).installations;
  const m = new ReleaseManager({
    dataDir, runtimeDir: join(base, "release-runtime"), catalog, installations, principals: PrincipalCatalog.parse(JSON.parse(readFileSync(join(root, "config/principals.json"), "utf8"))).principals, pollMs: 2000, buildTimeoutMs: 20 * 60_000,
    testRegistries: ["http://127.0.0.1:4874"], // declared test registry (asserted approvals are acceptable only here)
    registry: () => new NpmRegistry("http://127.0.0.1:4874", readFileSync(npmTokenFile, "utf8")),
    git: (repo) => new GitCli(`file://${join(base, "git")}/${repo}.git`, join(base, "release-runtime", "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
    releases: new GitHubReleases(ghUrl, "stand-in"),
    executor: new BoundryCiExecutor("http://127.0.0.1:21090", submitter),
  });
  try { await m.plan({ packages: [PKGS[0]!.id], bump: "patch", requestedBy: "maintenance-agent" }); }
  catch (e) { writeFileSync(join(outDir.replace(/\/$/, "") + "-lone-core-refused.md"), `# Lone release of @appport/resolver-core refused\n\n${(e as Error).message}\n`); log(`lone core release refused: ${(e as Error).message.split("\n")[0]}`); }
  const planned = await m.plan({ packages: PKGS.map((p) => p.id), bump: "patch", requestedBy: "maintenance-agent", reason: "End-to-end proof of the Release Manager (resolver release train)" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "1-approval-request.md"), approvalRequest(planned) + "\n");
  log(`planned ${planned.id}; plan digest ${planned.planDigest.slice(0, 16)}…`);
  const refusals: string[] = [];
  for (const [what, f] of [["approval by mallory (not a principal)", () => m.approve(planned.id, "mallory", planned.planDigest)], ["approval by maintenance-agent (its own proposal; an agent)", () => m.approve(planned.id, "maintenance-agent", planned.planDigest)], ["execution triggered by maintenance-agent", () => m.execute(planned.id, "maintenance-agent")]] as const) {
    try { await f(); refusals.push(`${what}: NOT REFUSED`); } catch (e) { refusals.push(`${what}: refused: ${(e as Error).message}`); }
  }
  for (const x of refusals) log(x);
  await m.approve(planned.id, "randy", planned.planDigest);
  const t0 = Date.now();
  const done = await m.execute(planned.id, "randy");
  log(`execute → ${done.state} in ${Math.round((Date.now() - t0) / 1000)}s${done.failure ? ` (${done.failure.reason})` : ""}`);
  writeFileSync(join(outDir, "2-release-record.json"), JSON.stringify(done, null, 2) + "\n");
  writeFileSync(join(outDir, "3-final-report.md"), approvalRequest(done) + "\n");

  // ── 6. Independent verification (asks each authority directly, not the record) ──
  const v: Record<string, unknown> = {};
  v.governance = { proposedBy: `${done.plan.requestedBy} (${done.plan.requestedByType})`, requiredApprovals: done.plan.requiredApprovals, protected: done.plan.protected, approvals: done.approvals, refusals };
  const head = sh("git", ["-C", bare, "rev-parse", "refs/heads/main"]).trim();
  v.git = {
    branchHead: head, parentOfHead: sh("git", ["-C", bare, "rev-parse", `${head}^`]).trim(), approvedSource: sourceCommit, releaseCommit: done.facts.releaseCommit,
    packages: PKGS.map((p) => {
      const pp = done.plan.packages.find((x) => x.package === p.id)!;
      const tagTarget = sh("git", ["-C", bare, "rev-parse", `refs/tags/${pp.tag}^{commit}`]).trim();
      return { tag: pp.tag, tagTarget, tagIsReleaseCommit: tagTarget === done.facts.releaseCommit, manifestVersionAtTag: JSON.parse(sh("git", ["-C", bare, "show", `${tagTarget}:${p.dir}/package.json`])).version };
    }),
    pinsAtReleaseCommit: Object.fromEntries(["packages/client", "packages/server"].map((d) => [d, JSON.parse(sh("git", ["-C", bare, "show", `${head}:${d}/package.json`])).dependencies?.["@appport/resolver-core"]])),
  };
  const regOut: unknown[] = [];
  for (const p of PKGS) {
    const pp = done.plan.packages.find((x) => x.package === p.id)!;
    const art = done.facts.build?.artifacts.find((a) => a.package === p.id);
    const doc: any = await (await fetch(`http://127.0.0.1:4874/${p.name.replace("/", "%2f")}`)).json();
    const pub = doc.versions[pp.proposedVersion];
    if (!pub) { regOut.push({ package: p.name, version: pp.proposedVersion, present: false }); continue; }
    const tarball = Buffer.from(await (await fetch(pub.dist.tarball)).arrayBuffer());
    regOut.push({ package: p.name, version: pp.proposedVersion, latest: doc["dist-tags"].latest, integrity: pub.dist.integrity, integrityMatchesBuiltArtifact: pub.dist.integrity === art?.integrity, tarballSha256: sha256(tarball), bytesMatchBuiltArtifact: sha256(tarball) === art?.sha256, earlierVersionsUntouched: Object.entries(seeded[p.name]!).every(([x, s]) => doc.versions[x]?.dist?.integrity === s.npmjsIntegrity) });
  }
  v.registry = regOut;
  const ev: any = await (await fetch(`http://127.0.0.1:21090/v1/runs/${done.facts.build?.runId}/evidence`, { headers: { authorization: `Bearer ${operator}` } })).json();
  v.execution = { runId: ev.run.id, state: ev.run.state, commitBuilt: ev.run.sha, isReleaseCommit: ev.run.sha === done.facts.releaseCommit, recipe: ev.definition.path, jobs: ev.jobs.map((j: any) => ({ key: j.key, state: j.state, capabilities: j.capabilities, artifacts: j.attempts.at(-1)?.artifacts })) };
  writeFileSync(join(outDir, "4-execution-evidence.json"), JSON.stringify(ev, null, 2) + "\n");
  v.githubReleases = ghReleases.map((r) => ({ tag: r.tag, name: r.name, citesEveryArtifact: (done.facts.build?.artifacts ?? []).every((a) => r.body.includes(a.sha256)), citesCommit: r.body.includes(done.facts.releaseCommit ?? "--") }));
  // Consumers: Maintenance's own observation code sees the new release (pointed at the stand-in registry).
  // (run with MAINTENANCE_NPM_REGISTRY=http://127.0.0.1:4874 so the unmodified collector reads the stand-in)
  const observed = await fetchNpmPackage("@appport/resolver-client", 20_000).catch(() => null);
  const feltkit = installations.find((i) => i.package === "appport-resolver-client" && i.project === "feltkit");
  v.consumers = observed ? {
    note: "Maintenance's unmodified npm collector and status classifier, pointed at the stand-in registry",
    observedLatest: observed.latestVersion,
    feltkit: feltkit ? { manifest: feltkit.manifest, declared: feltkit.declaredVersion, resolved: feltkit.resolvedVersion, classification: classify({ resolved: feltkit.resolvedVersion, latest: observed.latestStable, latestPrerelease: observed.latestPrerelease, trackPrereleases: false, registryAvailable: true, deprecated: null, yanked: false }) } : "feltkit installation not in data",
  } : "collector could not read the stand-in registry";
  writeFileSync(join(outDir, "5-independent-verification.json"), JSON.stringify(v, null, 2) + "\n");
  console.log(JSON.stringify(v, null, 2));
} finally {
  gh?.close(); gh?.closeAllConnections();
  for (const p of procs) p.kill("SIGTERM");
  try { execFileSync("bash", ["-c", `kill $(cat ${join(base, "feltdb", "pid")}) 2>/dev/null || true`]); } catch { /* gone */ }
}
