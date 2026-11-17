// Operational failure exercise: refusal and recovery against REAL persisted state, with every Maintenance action a
// separate OS process of the real CLI (`node src/index.ts release …`) over a data directory on disk, real git, real
// Boundry CI (FeltDB, control plane, Docker worker), Verdaccio behind a network path whose failures we control, and
// Resolver + Resolver Control for the runtime scenario. The executor crash is a real SIGKILL.
//
// The CLI reads config/ from its own checkout, so the exercise runs a disposable copy of this repository's code with
// the COMMITTED config/principals.json unchanged and one disposable package added to the catalog. Test registry only.
//
// Usage: node tools/ops-exercise/run.ts <boundry-ci checkout> <resolver-control checkout> <verdaccio bin> <out dir>
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { makeRepo } from "../../test/release-fakes.ts";

const [ciDir, rcDir, verdaccioBin, outDir] = process.argv.slice(2) as [string, string, string, string];
const ROOT = new URL("../..", import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), "ops-exercise-"));
const children: ChildProcess[] = [];
const servers: Server[] = [];
const log = (s: string) => console.log(`[exercise] ${s}`);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const wait = async (what: string, f: () => Promise<unknown> | unknown, ms = 60_000) => { const end = Date.now() + ms; let last: unknown; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timeout: ${what} ${last ? (last as Error).message : ""}`); };
const spawnBg = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => { const c = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }) as ChildProcess & { output: string }; c.output = ""; c.stdout!.on("data", (d) => (c.output += d)); c.stderr!.on("data", (d) => (c.output += d)); children.push(c); return c; };
const port = () => 43000 + Math.floor(Math.random() * 7000);

type Row = { id: string; scenario: string; expected: string; observed: string; pass: boolean; evidence: string };
const rows: Row[] = [];
const record = (id: string, scenario: string, expected: string, observed: string, pass: boolean, evidence: string) => { rows.push({ id, scenario, expected, observed, pass, evidence }); log(`${pass ? "PASS" : "FAIL"} ${id} ${scenario}: ${observed}`); };

try {
  // ── Maintenance: a disposable copy of this checkout's code, committed principals, one disposable package ──
  const m = join(base, "maintenance");
  for (const e of ["src", "contracts", "schemas", "package.json", "tsconfig.json"]) cpSync(join(ROOT, e), join(m, e), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(m, "node_modules"), "dir");
  mkdirSync(join(m, "config"));
  for (const f of ["principals.json", "projects.json", "policies.json", "ci.json"]) cpSync(join(ROOT, "config", f), join(m, "config", f));
  const catalog = JSON.parse(readFileSync(join(ROOT, "config/packages.json"), "utf8"));
  catalog.packages.push({ id: "exercise-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: { approvers: ["randy"], validation: [], githubRelease: false } });
  writeFileSync(join(m, "config/packages.json"), JSON.stringify(catalog, null, 2));
  const data = join(m, "data");
  mkdirSync(join(data, "evidence"), { recursive: true });
  const principalsSha = sha(readFileSync(join(ROOT, "config/principals.json")));

  // ── Git authority: the disposable workspace (@demo/core 0.2.0) as acme/demo ──
  const seedRepo = makeRepo();
  const gitRoot = join(base, "git");
  mkdirSync(join(gitRoot, "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seedRepo.bare, join(gitRoot, "acme/demo.git")]);
  execFileSync("git", ["-C", join(gitRoot, "acme/demo.git"), "config", "uploadpack.allowAnySHA1InWant", "true"]);
  const bare = join(gitRoot, "acme/demo.git");
  const head = () => execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const tagAt = (t: string) => { try { return execFileSync("git", ["-C", bare, "rev-parse", `${t}^{commit}`], { encoding: "utf8", stdio: "pipe" }).trim(); } catch { return null; } };

  // ── npm authority: Verdaccio, reached through a network path whose failures the exercise controls ──
  const vPort = port(), pPort = port();
  const vd = join(base, "verdaccio");
  mkdirSync(join(vd, "storage"), { recursive: true });
  writeFileSync(join(vd, "config.yaml"), `storage: ${vd}/storage\nauth:\n  htpasswd:\n    file: ${vd}/htpasswd\n    max_users: 10\nuplinks: {}\npackages:\n  '@*/*':\n    access: $all\n    publish: $authenticated\nlog: { type: stdout, format: pretty, level: warn }\nlisten: 127.0.0.1:${vPort}\n`);
  spawnBg(verdaccioBin, ["--config", join(vd, "config.yaml")]);
  await wait("Verdaccio", async () => (await fetch(`http://127.0.0.1:${vPort}/-/ping`)).ok);
  const npmToken = ((await (await fetch(`http://127.0.0.1:${vPort}/-/user/org.couchdb.user:maintenance`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "maintenance", password: randomBytes(12).toString("hex") }) })).json()) as any).token as string;
  let network: "pass" | "cut-next-publish" | "refuse-publish" = "pass";
  const proxy = createServer((req, res) => {
    if (req.method === "PUT" && network === "refuse-publish") { req.resume(); res.writeHead(503); return res.end("registry unavailable (exercise)"); }
    const up = httpRequest({ host: "127.0.0.1", port: vPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      if (req.method === "PUT" && network === "cut-next-publish") { network = "pass"; ur.resume(); ur.on("end", () => req.socket.destroy()); return; }
      res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(pPort, "127.0.0.1", r)); servers.push(proxy);
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  execFileSync("git", ["clone", "-q", bare, seed]);
  execFileSync("npm", ["pack", "--pack-destination", seed, "--silent"], { cwd: join(seed, "packages/core") });
  writeFileSync(join(seed, ".npmrc"), `//127.0.0.1:${vPort}/:_authToken=${npmToken}\n`);
  execFileSync("npm", ["publish", join(seed, "demo-core-0.2.0.tgz"), "--registry", `http://127.0.0.1:${vPort}/`, "--ignore-scripts"], { cwd: seed, env: { ...process.env, npm_config_userconfig: join(seed, ".npmrc") }, stdio: "pipe" });
  const regDoc = async () => (await (await fetch(`http://127.0.0.1:${vPort}/@demo%2fcore`)).json()) as any;

  // ── Boundry CI ──
  const fdb = join(base, "feltdb"), fdbPort = String(port()), control = `127.0.0.1:${port()}`;
  execFileSync(join(ciDir, "tools/feltdb-dev.sh"), [fdb, fdbPort], { env: { ...process.env, FELTDB_SERVER_BIN: process.env.FELTDB_SERVER_BIN ?? "/home/user/flow_db/target/release/feltdb-server" }, stdio: "pipe" });
  chmodSync(join(fdb, "token"), 0o600);
  const secrets = join(base, "secrets"); mkdirSync(secrets, { mode: 0o700 });
  const secret = (n: string, v: string) => { const p = join(secrets, n); writeFileSync(p, v, { mode: 0o600 }); return p; };
  const submitter = randomBytes(24).toString("hex");
  const ciEnv = { ...process.env, NODE_NO_WARNINGS: "1", BCI_FELTDB_URL: `http://127.0.0.1:${fdbPort}`, BCI_FELTDB_TOKEN_FILE: join(fdb, "token"), BCI_WEBHOOK_SECRET_FILE: secret("webhook", randomBytes(16).toString("hex")), BCI_OPERATOR_TOKENS_FILE: secret("operators", `${sha(submitter)} boundry-maintenance executions:submit,runs:read,artifacts:read\n`), BCI_SECRETS_DIR: join(base, "repo-secrets"), BCI_DATA_DIR: join(base, "ci-data"), BCI_LISTEN: control, BCI_CAS_MIN_FREE_BYTES: "0", BCI_SCM: "git", BCI_GIT_URL_TEMPLATE: `file://${gitRoot}/{repo}.git`, BCI_LEASE_MS: "60000" };
  mkdirSync(join(base, "repo-secrets"), { mode: 0o750 });
  spawnBg("node", [join(ciDir, "bin/boundry-ci.ts"), "control"], { env: ciEnv });
  await wait("Boundry CI", async () => (await fetch(`http://${control}/readyz`)).ok);
  const workerToken = execFileSync("node", [join(ciDir, "bin/boundry-ci.ts"), "admin", "create-worker", "exercise-worker", "linux-small", "linux-build"], { env: ciEnv, encoding: "utf8" }).trim().split("\n").pop()!;
  mkdirSync(join(base, "work"));
  spawnBg("node", [join(ciDir, "bin/boundry-ci.ts"), "worker"], { env: { ...ciEnv, BCI_CONTROL_URL: `http://${control}`, BCI_WORKER_TOKEN_FILE: secret("worker", workerToken), BCI_CAPABILITIES: "linux-small,linux-build", BCI_WORK_ROOT: join(base, "work"), BCI_OCI_CLI: "docker", BCI_EGRESS_CA_FILE: process.env.BCI_EGRESS_CA_FILE ?? "" } });

  // ── The Maintenance CLI, one OS process per action, over the data directory on disk ──
  const cliEnv = { ...process.env, NODE_NO_WARNINGS: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", BOUNDRY_NPM_REGISTRY: `http://127.0.0.1:${pPort}`, BOUNDRY_TEST_REGISTRIES: `http://127.0.0.1:${pPort}`, BOUNDRY_NPM_TOKEN_FILE: secret("npm", npmToken), BOUNDRY_GIT_URL_TEMPLATE: `file://${gitRoot}/{repo}.git`, BOUNDRY_CI_URL: `http://${control}`, BOUNDRY_CI_OPERATOR_TOKEN_FILE: secret("ci", submitter), BOUNDRY_RELEASE_RUNTIME: join(base, "release-runtime") };
  // Asynchronous: the controllable network path runs in this process, so a synchronous child would block its answers.
  const cli = (...args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
    const c = spawn("node", [join(m, "src/index.ts"), ...args, "--data", data], { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => res({ code, out }));
  });
  const recordOf = (id: string) => { const at = id.lastIndexOf("@"); const f = join(data, "release-manager", id.slice(0, at), `${id.slice(at + 1)}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
  const plan = async (by: string) => { const r = await cli("release", "plan", "--package", "exercise-core", "--bump", "patch", "--as", by); const id = /approve (\S+@\S+) --as/.exec(r.out)?.[1] ?? null; return { ...r, id }; };
  const approve = (id: string, by: string) => cli("release", "approve", id, "--as", by, "--digest", recordOf(id).planDigest);
  const evidence: Record<string, unknown> = {};
  const keep = (name: string, id: string) => { evidence[name] = recordOf(id); };

  // S1–S3: R1 proposed by the agent, approval refused to it, a person approves, the agent withdraws before claim.
  const r1 = await plan("maintenance-agent");
  record("S1", "Agent proposes a release", "allowed", r1.code === 0 ? `planned ${r1.id}, proposedBy ${recordOf(r1.id!)?.plan.requestedBy} (${recordOf(r1.id!)?.plan.requestedByType})` : r1.out.slice(0, 200), r1.code === 0 && recordOf(r1.id!)?.plan.requestedByType === "agent", `release-manager/${r1.id}`);
  const s2 = await approve(r1.id!, "maintenance-agent");
  record("S2", "Agent attempts approval", "refused", s2.code !== 0 ? (s2.out.match(/\[[a-z-]+\]/)?.[0] ?? s2.out.slice(0, 160)) : "APPROVED", s2.code !== 0 && /person-only|forbidden-effect/.test(s2.out) && recordOf(r1.id!).approvals.length === 0, "CLI exit code and message; record has 0 approvals");
  await approve(r1.id!, "randy");
  const s3 = await cli("release", "revoke", r1.id!, "--as", "maintenance-agent", "--reason", "no longer wanted");
  record("S3", "Proposer withdraws before claim", "allowed", `${recordOf(r1.id!).state}; approvals kept: ${recordOf(r1.id!).approvals.map((a: any) => a.by).join(",")}; claim ${recordOf(r1.id!).claim}`, s3.code === 0 && recordOf(r1.id!).state === "cancelled" && recordOf(r1.id!).approvals.length === 1 && recordOf(r1.id!).claim === null, "record: state cancelled, revocation by maintenance-agent");
  keep("R1-withdrawn", r1.id!);

  // S5, S4, S6: R2 executes; the executor process is SIGKILLed after the claim and the pushed release commit.
  const r2 = await plan("maintenance-agent"); await approve(r2.id!, "randy");
  const exec = spawn("node", [join(m, "src/index.ts"), "release", "execute", r2.id!, "--as", "randy", "--data", data], { env: cliEnv, stdio: "ignore" });
  await wait("R2 prepared (release commit pushed)", () => recordOf(r2.id!)?.state === "prepared", 120_000);
  exec.kill("SIGKILL");
  await new Promise((r) => exec.once("exit", r));
  const crashed = recordOf(r2.id!);
  const commitAfterCrash = head();
  record("S5", "Executor crashes during release (SIGKILL after claim and release commit)", "state remains recoverable", `persisted state ${crashed.state}, claim by ${crashed.claim?.by}, release commit ${crashed.facts.releaseCommit?.slice(0, 12)} on main: ${commitAfterCrash === crashed.facts.releaseCommit}`, crashed.state === "prepared" && !!crashed.claim && commitAfterCrash === crashed.facts.releaseCommit, "record after SIGKILL; git main");
  const s4 = await cli("release", "revoke", r2.id!, "--as", "maintenance-agent", "--reason", "withdraw after claim");
  record("S4", "Proposer withdraws after claim", "refused", s4.code !== 0 ? (s4.out.match(/\[claimed\]/)?.[0] ?? s4.out.slice(0, 160)) : "WITHDRAWN", s4.code !== 0 && /\[claimed\]/.test(s4.out) && recordOf(r2.id!).state === "prepared", "CLI refusal; record unchanged");
  network = "cut-next-publish";
  const resumed = await cli("release", "execute", r2.id!, "--as", "randy");
  const rec2 = recordOf(r2.id!);
  const doc2 = await regDoc();
  const v2 = rec2.plan.packages[0].proposedVersion;
  const publishAttempts = rec2.attempts.filter((a: any) => a.step === "publish").map((a: any) => `${a.outcome}: ${a.detail}`);
  record("S6", "Publish response is lost (connection cut after the registry stored it)", "reconciliation determines the actual outcome", `${rec2.state}; ${publishAttempts.join(" | ")}; registry integrity = built: ${doc2.versions[v2]?.dist?.integrity === rec2.facts.build?.artifacts[0]?.integrity}; same release commit as before the crash: ${rec2.facts.releaseCommit === commitAfterCrash}`, resumed.code === 0 && rec2.state === "released" && publishAttempts.some((a: string) => a.startsWith("already-done")) && doc2.versions[v2]?.dist?.integrity === rec2.facts.build?.artifacts[0]?.integrity && rec2.facts.releaseCommit === commitAfterCrash, "record attempts; Verdaccio document");
  keep("R2-crash-then-lost-publish", r2.id!);

  // S8, S7, S8b: R3 gets stuck after claim (the registry refuses publishing); replacement too early; a person abandons.
  const r3 = await plan("maintenance-agent"); await approve(r3.id!, "randy");
  network = "refuse-publish";
  await cli("release", "execute", r3.id!, "--as", "randy");
  const stuck = recordOf(r3.id!);
  network = "pass";
  const early = await plan("maintenance-agent");
  record("S8", "Replacement release attempted too early (predecessor stuck, not abandoned)", "refused", early.code !== 0 ? (early.out.match(/release \S+ is \S+/)?.[0] ?? early.out.slice(0, 160)) : `PLANNED ${early.id}`, early.code !== 0 && /busy|finish, abandon or cancel/.test(early.out), `${r3.id} at ${stuck.state} (failure: ${stuck.failure?.reason?.slice(0, 80)})`);
  const agentAbandon = await cli("release", "abandon", r3.id!, "--as", "maintenance-agent", "--reason", "agent tries");
  const ab = await cli("release", "abandon", r3.id!, "--as", "randy", "--reason", "registry incident; replacing with the next patch");
  const rec3 = recordOf(r3.id!);
  record("S7", "Human abandons a stuck release", "audited; no fictional rollback", `agent refused: ${agentAbandon.code !== 0}; ${rec3.state} by ${rec3.abandonment?.by} (${rec3.abandonment?.byType}) at state ${rec3.abandonment?.atState}; remains real: ${rec3.abandonment?.remainsReal.join("; ")}; tag still at release commit: ${tagAt(stuck.plan.packages[0].tag) === stuck.facts.releaseCommit}`, agentAbandon.code !== 0 && ab.code === 0 && rec3.state === "abandoned" && rec3.abandonment.reconciliation.releaseCommitOnBranch && tagAt(stuck.plan.packages[0].tag) === stuck.facts.releaseCommit && !rec3.abandonment.reconciliation.registry[0].present, "record abandonment + reconciliation; git tag");
  const after = await plan("maintenance-agent");
  const v4 = after.id ? recordOf(after.id).plan.packages[0].proposedVersion : null;
  record("S8b", "Replacement after reconciled abandonment", "allowed; the abandoned version is never reused", `planned ${after.id} → ${v4}; abandoned version was ${stuck.plan.packages[0].proposedVersion}`, after.code === 0 && v4 !== stuck.plan.packages[0].proposedVersion, "plan decision text: Reserved …");
  keep("R3-abandoned", r3.id!); if (after.id) keep("R4-replacement-plan", after.id);

  // S9, S10: consumers of R2's version, from installations and CI evidence on disk.
  const inst = (project: string, resolved: string, commit: string) => ({ project, repository: `acme/${project}`, commit, root: ".", manifest: "package.json", lockfile: "package-lock.json", ecosystem: "javascript", package: "exercise-core", name: "@demo/core", registry: "npm", kind: "dependencies", optional: false, declaredVersion: "^0.2.0", resolvedVersion: resolved, source: "registry", sourceRevision: null, latestVersion: v2, latestSatisfiesDeclared: true, lockfileInSync: true, status: "current", verification: { verified: false, commit: null, evidenceAt: null }, stale: false, lastScanned: new Date().toISOString() });
  writeFileSync(join(data, "installations.json"), "{\"not\": \"installations\"}");
  const invalid = await cli("release", "consumers", r2.id!);
  record("S9a", "Consumer observation with invalid installation data", "refused explicitly; nothing recorded", invalid.code !== 0 ? (invalid.out.match(/does not match its schema[^.]*\./)?.[0] ?? invalid.out.slice(0, 160)) : "RECORDED", invalid.code !== 0 && recordOf(r2.id!).consumers.length === 0, "CLI exit code; record consumers[] empty");
  writeFileSync(join(data, "installations.json"), JSON.stringify({ generatedAt: new Date().toISOString(), installations: [inst("shop", "0.2.0", "shop-c1"), inst("billing", v2, "billing-c2")], discovered: [] }));
  const evRec = (project: string, commit: string, resolved: string) => ({ project, repository: `acme/${project}`, commit, collectedAt: new Date().toISOString(), scanRun: "exercise", passed: true, checks: { resolution: "pass", workflows: "pass" }, runs: [{ workflow: "ci.yml", runId: 1, url: "exercise", status: "completed", conclusion: "success", headSha: commit }], resolved: { ".|npm:@demo/core": resolved } });
  writeFileSync(join(data, "evidence", "billing.json"), JSON.stringify({ project: "billing", records: [evRec("billing", "billing-c1", "0.2.0")] })); // CI passed, but on the OLD version
  writeFileSync(join(data, "evidence", "shop.json"), JSON.stringify({ project: "shop", records: [evRec("shop", "shop-c1", "0.2.0")] }));
  await cli("release", "consumers", r2.id!);
  const obs = recordOf(r2.id!).consumers;
  const shop = obs.find((c: any) => c.consumer === "shop"), billing = obs.find((c: any) => c.consumer === "billing");
  record("S9", "Consumer has not adopted the version", "not adopted", `shop: resolved ${shop?.installation.resolved}, adoption ${shop?.adoption}, verification ${shop?.verification}`, shop?.adoption === "not-adopted" && shop?.verification === "unverified", "release record consumers[]");
  record("S10", "Consumer CI hasn't verified the exact version", "not verified", `billing: resolved ${billing?.installation.resolved} (adopted: ${billing?.adoption}); its only CI evidence resolved 0.2.0 → verification ${billing?.verification}`, billing?.adoption === "adopted" && billing?.verification === "unverified", "release record consumers[]; data/evidence/billing.json");
  keep("R2-with-consumers", r2.id!);

  // S11: Resolver mutation lacking its required approvals (Resolver Control + Resolver enforcing a policy).
  const { resolverService } = await import(pathToFileURL(join(rcDir, "tests/fixtures/resolver-service.mjs")).href);
  const { cli: rcli } = resolverService();
  const rPort = port(), rcPort = port();
  const rDir = join(base, "resolver");
  const adminKey = execFileSync(process.execPath, [rcli, "init", "--dir", rDir, "--tenant", "acme"], { encoding: "utf8" }).trim().split("\n").at(-1)!;
  const shared = { ...process.env, RESOLVER_STATE_SHARED: "1" };
  spawnBg(process.execPath, [rcli, "serve", "--dir", rDir, "--port", String(rPort)], { env: { ...shared, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" } });
  const rUrl = `http://127.0.0.1:${rPort}`;
  await wait("Resolver", async () => (await fetch(`${rUrl}/_resolver/ready`)).ok);
  const resolver = (args: string[]) => execFileSync(process.execPath, [rcli, ...args], { env: { ...process.env, RESOLVER_URL: rUrl, RESOLVER_API_KEY: adminKey }, encoding: "utf8", stdio: "pipe" });
  const executorKey = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1)!;
  resolver(["set", "ref://prod/search", "--kind", "endpoint", "--value", JSON.stringify({ url: "https://search-a.example.com" }), "--reason", "initial"]);
  const { publicKey } = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(rcDir, "signer/server.ts"), "--generate", join(base, "signer.pem")], { cwd: rcDir, encoding: "utf8" }));
  execFileSync(process.execPath, [rcli, "policy", "set", "prod", "--pattern", "ref://prod/*", "--operations", "put,put-secret,rollback,revoke", "--issuer", "resolver-control", "--max-validity", "600", "--reason", "exercise", "--dir", rDir, "--tenant", "acme"], { env: shared, stdio: "pipe" });
  execFileSync(process.execPath, [rcli, "signing-key", "add", "ex-1", "--issuer", "resolver-control", "--public-key", publicKey, "--reason", "exercise", "--dir", rDir, "--tenant", "acme"], { env: shared, stdio: "pipe" });
  const proj = join(base, "rc");
  for (const e of ["feltkit", "component", "src", "public", "index.html", "package.json", "tsconfig.json", "vite.config.ts"]) cpSync(join(rcDir, e), join(proj, e), { recursive: true });
  symlinkSync(join(rcDir, "node_modules"), join(proj, "node_modules"), "dir");
  const feltkit = join(rcDir, "node_modules/.bin/feltkit");
  spawnBg(feltkit, ["dev", "--port", String(rcPort)], { cwd: proj, env: { ...process.env, FELTKIT_CREDENTIAL_RESOLVER_API_KEY: executorKey, BROWSER: "none" } });
  const rcUrl = `http://127.0.0.1:${rcPort}`;
  await wait("Resolver Control", async () => (await fetch(`${rcUrl}/_feltkit/health`)).status < 500, 90_000);
  const session = (id: string, roles: string[], type = "user") => execFileSync(feltkit, ["session", "create", "--id", id, ...roles.flatMap((r) => ["--role", r]), "--type", type], { cwd: proj, encoding: "utf8" }).match(/fks_[A-Za-z0-9_-]+/)![0];
  const call = async (token: string, kind: string, name: string, args: unknown) => { const r: any = await (await fetch(`${rcUrl}/api/${kind}/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) })).json(); if (!r.ok) throw Object.assign(new Error(r.error?.message), { code: r.error?.code }); return r.value; };
  const ada = session("ada", ["admin", "prod_approver"]), linus = session("linus", ["prod_approver"]), agentS = session("ops-agent", ["agent"], "agent"), exeS = session("component:resolver", ["executor"], "service");
  await call(ada, "mutation", "settings:set", { resolverUrl: rUrl, namespaces: ["prod"], syncIntervalSeconds: 1 });
  await wait("observation", async () => (await call(ada, "query", "catalog:inventory", {})).find((x: any) => x.ref === "ref://prod/search" && x.revision === 1));
  await call(ada, "mutation", "catalog:register", { ref: "ref://prod/search", title: "Search", category: "search", criticality: "critical", changeClass: "runtime" });
  const ch = await call(agentS, "mutation", "changes:proposeRetarget", { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "exercise" });
  await wait("validation", async () => (await call(ada, "query", "changes:get", { id: ch.id })).change.status === "ready");
  let agentApprove = "ALLOWED"; try { await call(agentS, "mutation", "changes:approve", { id: ch.id }); } catch (e: any) { agentApprove = `${e.code}`; }
  await call(linus, "mutation", "changes:approve", { id: ch.id }); // 1 of the 2 a critical reference needs
  let claim = "ALLOWED"; try { const c = await call(exeS, "mutation", "changes:claim", { id: ch.id }); claim = c.status; } catch (e: any) { claim = `${e.code}: ${e.message.slice(0, 80)}`; }
  let direct = "ALLOWED"; try { resolver(["set", "ref://prod/search", "--value", JSON.stringify({ url: "https://search-x.example.com" }), "--reason", "direct"]); } catch (e: any) { direct = String(e.stderr ?? e.message).split("\n").find((l: string) => /error/i.test(l)) ?? "refused"; }
  await new Promise((r) => setTimeout(r, 3000)); // component ticks
  const revision = JSON.parse(resolver(["history", "ref://prod/search"])).entries.at(-1).revision;
  const status = (await call(ada, "query", "changes:get", { id: ch.id })).change.status;
  record("S11", "Resolver mutation lacks its required approvals (critical: 2; 1 given)", "refused", `agent approval: ${agentApprove}; executor claim: ${claim}; change status ${status}; direct admin-key write: ${direct.slice(0, 120)}; Resolver revision ${revision}`, agentApprove === "FORBIDDEN" && /FAILED_PRECONDITION|ready/.test(claim) && status === "ready" && /authorization-required/.test(direct) && revision === 1, "Resolver history; Resolver Control change");

  // ── Report ──
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ at: new Date().toISOString(), principalsSha256: principalsSha, rows }, null, 2) + "\n");
  writeFileSync(join(outDir, "records.json"), JSON.stringify(evidence, null, 2) + "\n");
  const md = ["| # | Scenario | Expected | Observed | Result |", "|---|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${r.scenario} | ${r.expected} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "**FAIL**"} |`)].join("\n");
  writeFileSync(join(outDir, "results.md"), md + "\n");
  console.log(md);
  if (rows.some((r) => !r.pass)) process.exitCode = 1;
} finally {
  for (const s of servers) { s.close(); s.closeAllConnections(); }
  for (const c of children.reverse()) c.kill("SIGTERM");
  try { execFileSync("bash", ["-c", `kill $(cat ${join(base, "feltdb", "pid")}) 2>/dev/null || true`]); } catch { /* gone */ }
}
