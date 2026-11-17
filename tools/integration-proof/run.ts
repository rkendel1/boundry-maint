// Integration proof (Prompt 3): one consuming application ("shop") with a PACKAGE dependency governed by Boundry
// Maintenance and a RUNTIME dependency governed by Resolver Control, each with its own authority, proposal,
// approvals and evidence, seen together without merging them. Nothing touches a production registry or a
// production Resolver.
//
//   Resolver          : the real @appport/resolver (Resolver Control's vendored 0.4.0), enforcing a mutation policy on
//                       ref://prod/* (writes need an authorization from Resolver Control's approval signer)
//   Resolver Control  : `feltkit dev` from the resolver-control checkout; its component holds the only Resolver key
//   Approval signer   : resolver-control signer/, its own process and key
//   shop (running)    : resolver-control examples/consumer-app.mjs, registered with Resolver as consumer "shop"
//   Maintenance       : this repository's AppPort application (HTTP /appport and /mcp), Release Manager, real git,
//                       Verdaccio (a real npm registry implementation, declared as a test registry)
//
// Usage: node tools/integration-proof/run.ts <resolver-control checkout> <verdaccio bin> <out dir>
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@appport/client";
import { createHttpTransport } from "@appport/transport-http";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReleaseManager } from "../../src/release/manager.ts";
import { NpmRegistry, GitCli, type ReleasesAdapter } from "../../src/release/adapters.ts";
import { Installation, PackageConfig, Principal, ProjectConfig } from "../../src/contracts.ts";
import { createMaintenanceApplication } from "../../src/appport/application.ts";
import { serveMaintenance } from "../../src/appport/serve.ts";
import { ResolverControl } from "../../src/integrations/resolver-control.ts";
import { makeRepo, PackingExecutor } from "../../test/release-fakes.ts";

const [RC, verdaccioBin, outDir] = process.argv.slice(2) as [string, string, string];
const work = mkdtempSync(join(tmpdir(), "integration-proof-"));
const children: ChildProcess[] = [];
const log = (s: string) => console.log(`[proof] ${s}`);
const port = () => 42000 + Math.floor(Math.random() * 8000);
const until = async <T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms; let last: unknown;
  while (Date.now() < end) { try { const v = await f(); if (v) return v as T; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
};
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
  const c = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }) as ChildProcess & { output: string };
  c.output = ""; c.stdout!.on("data", (d) => (c.output += d)); c.stderr!.on("data", (d) => (c.output += d)); children.push(c); return c;
};
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
/** Every attempt to exercise another domain's authority, and what that authority answered. */
const authority: { actor: string; attempt: string; target: string; outcome: string }[] = [];
const attempt = async (actor: string, what: string, target: string, f: () => Promise<unknown>) => {
  try { await f(); authority.push({ actor, attempt: what, target, outcome: "ALLOWED" }); }
  catch (e: any) {
    // A child process's own error text (Resolver CLI, npm) is the authority's answer; keep it, not just "Command failed".
    const said = String(e?.stderr ?? "").split("\n").map((l: string) => l.trim()).filter((l: string) => /error|E40\d|forbidden|unauthori[sz]ed|authorization/i.test(l)).slice(0, 2).join(" | ");
    authority.push({ actor, attempt: what, target, outcome: `refused: ${e?.code && typeof e.code === "string" ? `${e.code} ` : ""}${said || String(e?.message ?? e).split("\n")[0]!.slice(0, 240)}` });
  }
};

try {
  const { resolverService } = await import(pathToFileURL(join(RC, "tests/fixtures/resolver-service.mjs")).href);
  const { cli } = resolverService();
  // ── 1. Resolver, governed: prod writes need an authorization from Resolver Control's approval signer ──
  const [resolverPort, rcPort, signerPort, verdPort] = [port(), port(), port(), port()];
  const resolverUrl = `http://127.0.0.1:${resolverPort}`, rcUrl = `http://127.0.0.1:${rcPort}`, signerUrl = `http://127.0.0.1:${signerPort}`;
  const resolverDir = join(work, "resolver");
  const adminKey = execFileSync(process.execPath, [cli, "init", "--dir", resolverDir, "--tenant", "acme"], { encoding: "utf8" }).trim().split("\n").at(-1)!;
  const shared = { ...process.env, RESOLVER_STATE_SHARED: "1" };
  run(process.execPath, [cli, "serve", "--dir", resolverDir, "--port", String(resolverPort)], { env: { ...shared, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" } });
  await until("Resolver", async () => (await fetch(`${resolverUrl}/_resolver/ready`)).ok);
  const resolver = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: adminKey }, encoding: "utf8" });
  const operator = (args: string[]) => execFileSync(process.execPath, [cli, ...args, "--dir", resolverDir, "--tenant", "acme"], { env: shared, encoding: "utf8" });
  const executorKey = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1)!;
  const shopKey = resolver(["keys", "create", "shop", "--grant", "read:ref://prod/*"]).trim().split("\n").at(-1)!;
  resolver(["set", "ref://prod/search", "--kind", "endpoint", "--value", JSON.stringify({ url: "https://search-a.example.com" }), "--reason", "initial"]);
  const signerKeyFile = join(work, "signer-key.pem");
  const { publicKey } = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(RC, "signer/server.ts"), "--generate", signerKeyFile], { cwd: RC, encoding: "utf8" }));
  operator(["policy", "set", "prod", "--pattern", "ref://prod/*", "--operations", "put,put-secret,rollback,revoke", "--issuer", "resolver-control", "--max-validity", "600", "--reason", "prod changes need an approved change"]);
  operator(["signing-key", "add", "proof-1", "--issuer", "resolver-control", "--public-key", publicKey, "--reason", "Resolver Control approval signer"]);
  log(`Resolver ${resolverUrl}: ref://prod/search at revision 1; prod governed by policy (issuer resolver-control)`);

  // ── 2. shop, running: resolves ref://prod/search through Resolver's client, registered as consumer "shop" ──
  const shop = run(process.execPath, [join(RC, "examples/consumer-app.mjs")], { cwd: RC, env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: shopKey, CONSUMER_REFS: "ref://prod/search", CONSUMER_INTERVAL_MS: "300", CONSUMER_APPLICATION: "shop", CONSUMER_ENVIRONMENT: "prod", CONSUMER_REPORT: "1" } });
  const shopSays = () => shop.output.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  await until("shop's first resolution", async () => shopSays().some((l: any) => l.revision === 1));

  // ── 3. Resolver Control (its component holds the executor key) and its approval signer ──
  const project = join(work, "rc");
  for (const e of ["feltkit", "component", "src", "public", "index.html", "package.json", "tsconfig.json", "vite.config.ts"]) cpSync(join(RC, e), join(project, e), { recursive: true });
  symlinkSync(join(RC, "node_modules"), join(project, "node_modules"), "dir");
  const signerClientToken = randomBytes(24).toString("base64url");
  const feltkit = join(RC, "node_modules/.bin/feltkit");
  const rc = run(feltkit, ["dev", "--port", String(rcPort)], { cwd: project, env: { ...process.env, FELTKIT_CREDENTIAL_RESOLVER_API_KEY: executorKey, FELTKIT_CREDENTIAL_APPROVAL_SIGNER_TOKEN: signerClientToken, BROWSER: "none" } });
  await until("Resolver Control", async () => (await fetch(`${rcUrl}/_feltkit/health`)).status < 500, 90_000);
  const session = (id: string, roles: string[], type = "user") => execFileSync(feltkit, ["session", "create", "--id", id, ...roles.flatMap((r) => ["--role", r]), "--type", type], { cwd: project, encoding: "utf8" }).match(/fks_[A-Za-z0-9_-]+/)![0];
  const rcCall = async (token: string, kind: string, name: string, args: unknown) => {
    const r: any = await (await fetch(`${rcUrl}/api/${kind}/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) })).json();
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? JSON.stringify(r)), { code: r.error?.code });
    return r.value;
  };
  const ada = session("ada", ["admin", "prod_approver"]), linus = session("linus", ["prod_approver"]), grace = session("grace", ["engineer"]);
  // Maintenance's own principal in Resolver Control: an agent. It may read and propose; nothing else.
  const maintenanceInRc = session("boundry-maintenance", ["agent"], "agent");
  const signerSession = session("approval-signer", ["signer"], "service");
  writeFileSync(join(work, "signer-client-token"), signerClientToken, { mode: 0o600 });
  writeFileSync(join(work, "signer-rc-token"), signerSession, { mode: 0o600 });
  run(process.execPath, ["--import", "tsx", join(RC, "signer/server.ts")], { cwd: RC, env: { ...process.env, PORT: String(signerPort), SIGNER_PRIVATE_KEY_FILE: signerKeyFile, SIGNER_KID: "proof-1", SIGNER_TENANT: "acme", SIGNER_SCOPE: "ref://prod/*", SIGNER_CLIENT_TOKEN_FILE: join(work, "signer-client-token"), RC_URL: rcUrl, RC_TOKEN_FILE: join(work, "signer-rc-token") } });
  await until("the signer", async () => (await fetch(`${signerUrl}/ready`)).ok);
  await rcCall(ada, "mutation", "settings:set", { resolverUrl, namespaces: ["prod"], syncIntervalSeconds: 1, signerUrl });
  await until("Resolver Control's first observation", async () => (await rcCall(ada, "query", "catalog:inventory", {})).find((r: any) => r.ref === "ref://prod/search" && r.revision === 1));
  await rcCall(ada, "mutation", "catalog:register", { ref: "ref://prod/search", title: "Product search", category: "search", criticality: "critical", changeClass: "runtime", owner: "platform-team", contract: "HTTP search API v1" });
  await rcCall(grace, "mutation", "catalog:declareConsumer", { ref: "ref://prod/search", application: "shop", usage: "product search on the storefront" });
  log(`Resolver Control ${rcUrl}: ref://prod/search registered (critical, owner platform-team); shop declared as its consumer`);

  // ── 4. Maintenance: its AppPort application, Release Manager, a test npm registry ──
  const vd = join(work, "verdaccio");
  mkdirSync(join(vd, "storage"), { recursive: true });
  writeFileSync(join(vd, "config.yaml"), `storage: ${vd}/storage\nauth:\n  htpasswd:\n    file: ${vd}/htpasswd\n    max_users: 10\nuplinks: {}\npackages:\n  '@*/*':\n    access: $all\n    publish: $authenticated\nlog: { type: stdout, format: pretty, level: warn }\nlisten: 127.0.0.1:${verdPort}\n`);
  run(verdaccioBin, ["--config", join(vd, "config.yaml")], {});
  const regUrl = `http://127.0.0.1:${verdPort}`;
  await until("Verdaccio", async () => (await fetch(`${regUrl}/-/ping`)).ok);
  const npmToken = ((await (await fetch(`${regUrl}/-/user/org.couchdb.user:maintenance`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "maintenance", password: randomBytes(12).toString("hex") }) })).json()) as any).token as string;
  const repo = makeRepo({ clientPin: "^0.2.0" });
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  execFileSync("git", ["clone", "-q", repo.bare, seed]);
  execFileSync("npm", ["pack", "--pack-destination", seed, "--silent"], { cwd: join(seed, "packages/core") });
  writeFileSync(join(seed, ".npmrc"), `//127.0.0.1:${verdPort}/:_authToken=${npmToken}\n`);
  execFileSync("npm", ["publish", join(seed, "demo-core-0.2.0.tgz"), "--registry", `${regUrl}/`, "--ignore-scripts"], { cwd: seed, env: { ...process.env, npm_config_userconfig: join(seed, ".npmrc") } });
  const principals = [
    Principal.parse({ id: "randy", name: "Randy", type: "person", roles: ["admin", "prod_approver"] }),
    Principal.parse({ id: "maintenance-agent", name: "Maintenance agent", type: "agent", roles: ["agent"] }),
    Principal.parse({ id: "component:release-executor", name: "Release executor", type: "component", roles: ["executor"] }),
  ];
  const shopProject = ProjectConfig.parse({ id: "shop", name: "Shop", repository: "acme/shop", managedPackages: ["demo-core"], resolverApplication: "shop" });
  const installations = [Installation.parse({ project: "shop", repository: "acme/shop", commit: null, root: ".", manifest: "package.json", lockfile: "package-lock.json", ecosystem: "javascript", package: "demo-core", name: "@demo/core", registry: "npm", kind: "dependencies", optional: false, declaredVersion: "0.2.0", resolvedVersion: "0.2.0", source: "registry", sourceRevision: null, latestVersion: "0.2.0", latestSatisfiesDeclared: true, lockfileInSync: true, status: "current", verification: { verified: false, commit: null, evidenceAt: null }, stale: false, lastScanned: new Date().toISOString() })]; // shop's manifest pins @demo/core exactly, as a scan would record it
  const noGitHub: ReleasesAdapter = { find: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); } };
  const manager = new ReleaseManager({
    dataDir: join(work, "maintenance-data"), runtimeDir: join(work, "release-runtime"), principals, installations, testRegistries: [regUrl], pollMs: 50,
    catalog: [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: { approvers: ["randy"], githubRelease: false } })],
    registry: () => new NpmRegistry(regUrl, npmToken), releases: noGitHub, executor: new PackingExecutor(repo.url),
    git: () => new GitCli(repo.url, join(work, "release-runtime", "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  });
  const rcReader = new ResolverControl(rcUrl, maintenanceInRc, "boundry-maintenance");
  const app = createMaintenanceApplication({ manager, principals, projects: [shopProject], installations: () => installations, packageNames: { "demo-core": "@demo/core" }, resolverControl: rcReader });
  const tokens = { agent: randomBytes(16).toString("hex"), randy: randomBytes(16).toString("hex") };
  const m = await serveMaintenance(app, { principals, tokens: { [sha(tokens.agent)]: "maintenance-agent", [sha(tokens.randy)]: "randy" } });
  const maint = (token?: string) => createClient({ transport: createHttpTransport({ url: `${m.url}/appport`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }) });
  log(`Maintenance ${m.url} (AppPort /appport, MCP /mcp); npm test registry ${regUrl}`);

  // ── 5. Package change, Maintenance's authority: proposed by the agent, approved and triggered by a person ──
  const proposed: any = await maint(tokens.agent).call("releases.propose", { packages: ["demo-core"], bump: "patch", reason: "Integration proof: package side" });
  const rel = proposed.release;
  await attempt("maintenance-agent (Maintenance AppPort)", "approve its own release", "Boundry Maintenance", () => maint(tokens.agent).call("releases.approve", { id: rel.id, planDigest: rel.planDigest }));
  await attempt("maintenance-agent (Maintenance AppPort)", "trigger execution", "Boundry Maintenance", () => maint(tokens.agent).call("releases.trigger", { id: rel.id }));
  await maint(tokens.randy).call("releases.approve", { id: rel.id, planDigest: rel.planDigest });
  const released: any = await maint(tokens.randy).call("releases.trigger", { id: rel.id });
  log(`package: ${rel.id} → ${released.state} (proposed by maintenance-agent, approved by randy)`);

  // ── 6. Runtime change, Resolver Control's authority: Maintenance proposes through RC's capability; people approve ──
  const rcAppPort = createClient({ transport: createHttpTransport({ url: `${rcUrl}/appport`, headers: { authorization: `Bearer ${maintenanceInRc}` } }) });
  const change: any = await rcAppPort.call("changes.propose", { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "Integration proof: shop's search moves to provider B (proposed by Boundry Maintenance)" });
  log(`runtime: CHG-${change.number} proposed by boundry-maintenance (agent) through Resolver Control's changes.propose; requires ${change.impact.requiredApprovals} approvals`);
  await until("validation", async () => (await rcCall(ada, "query", "changes:get", { id: change.id })).change.status === "ready");
  await attempt("boundry-maintenance (its Resolver Control session)", "approve the runtime change", "Resolver Control changes.approve (AppPort)", () => rcAppPort.call("changes.approve", { id: change.id }));
  await attempt("boundry-maintenance (its Resolver Control session)", "claim the change for execution", "Resolver Control changes:claim", () => rcCall(maintenanceInRc, "mutation", "changes:claim", { id: change.id }));
  await attempt("boundry-maintenance (its Resolver Control session)", "repoint Resolver Control at another Resolver", "Resolver Control settings:set", () => rcCall(maintenanceInRc, "mutation", "settings:set", { resolverUrl: "http://evil.invalid", namespaces: ["prod"] }));
  await attempt("boundry-maintenance (its Resolver Control session)", "lower the dependency's criticality", "Resolver Control dependencies.describe", () => rcAppPort.call("dependencies.describe", { ref: "ref://prod/search", title: "Product search", category: "search", criticality: "low", changeClass: "runtime" }));
  await attempt("boundry-maintenance (no Resolver key)", "write ref://prod/search directly", "Resolver resolver.put (AppPort)", () => createClient({ transport: createHttpTransport({ url: `${resolverUrl}/appport` }) }).call("resolver.put", { ref: "ref://prod/search", kind: "endpoint", binding: { value: { url: "https://search-x.example.com" } }, expectedRevision: 1, reason: "bypass" }));
  await attempt("Resolver's admin key (operator)", "write ref://prod/search without an authorization", "Resolver CLI set", async () => execFileSync(process.execPath, [cli, "set", "ref://prod/search", "--value", JSON.stringify({ url: "https://search-x.example.com" }), "--reason", "direct"], { env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: adminKey }, encoding: "utf8", stdio: "pipe" }));
  await rcCall(linus, "mutation", "changes:approve", { id: change.id, note: "integration proof" });
  await rcCall(ada, "mutation", "changes:approve", { id: change.id, note: "integration proof" });
  const verified = await until("verification", async () => { const c = (await rcCall(ada, "query", "changes:get", { id: change.id })).change; return ["verified", "failed", "superseded", "unknown"].includes(c.status) ? c : null; }, 90_000);
  log(`runtime: CHG-${change.number} → ${verified.status}`);
  await until("shop to follow revision 2", async () => shopSays().some((l: any) => l.revision === 2), 60_000);

  // ── 7. Resolver Control cannot publish packages; agents cannot approve over either MCP surface ──
  const rcCredentials = /credentials: \[([^\]]*)\]/.exec(readFileSync(join(RC, "feltkit/app.ts"), "utf8"))?.[1];
  authority.push({ actor: "Resolver Control (its component)", attempt: "hold a package-registry credential", target: "its declared component credentials", outcome: `declares only ${rcCredentials} (feltkit/app.ts); no registry credential exists in its boundary` });
  await attempt("Resolver Control (no Maintenance token)", "propose or approve a release", "Boundry Maintenance releases.approve (AppPort)", () => maint().call("releases.approve", { id: rel.id, planDigest: rel.planDigest }));
  // A valid, unpublished version with a valid tag: the only thing missing is the registry credential.
  const unauth = mkdtempSync(join(tmpdir(), "unauth-"));
  writeFileSync(join(unauth, "package.json"), JSON.stringify({ name: "@demo/core", version: "0.9.9", main: "index.js" }));
  writeFileSync(join(unauth, "index.js"), "module.exports = 9;\n");
  writeFileSync(join(unauth, "empty-npmrc"), "");
  await attempt("anyone without the registry token (e.g. Resolver Control)", "publish @demo/core@0.9.9 (unpublished version, valid tag)", `test registry ${regUrl}`, async () => execFileSync("npm", ["publish", "--registry", `${regUrl}/`, "--tag", "unauthenticated-attempt", "--ignore-scripts"], { cwd: unauth, env: { ...process.env, npm_config_userconfig: join(unauth, "empty-npmrc") }, encoding: "utf8", stdio: "pipe" }));
  // npm refuses locally without a token; ask the registry itself (the npm publish protocol, no credential).
  await attempt("anyone without the registry token (raw HTTP)", "PUT @demo/core@0.9.9 to the registry", `test registry ${regUrl}`, async () => {
    const tgz = readFileSync(join(seed, "demo-core-0.2.0.tgz")).toString("base64");
    const body = { _id: "@demo/core", name: "@demo/core", "dist-tags": { "unauthenticated-attempt": "0.9.9" }, versions: { "0.9.9": { name: "@demo/core", version: "0.9.9", dist: { tarball: `${regUrl}/@demo/core/-/core-0.9.9.tgz` } } }, _attachments: { "core-0.9.9.tgz": { content_type: "application/octet-stream", data: tgz, length: tgz.length } } };
    const r = await fetch(`${regUrl}/@demo%2fcore`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error(`registry answered ${r.status}: ${(await r.text()).slice(0, 160)}`), { code: String(r.status) });
  });
  const mcpAs = async (url: string, token: string) => { const c = new McpClient({ name: "proof-agent", version: "1.0.0" }); await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); return c; };
  for (const [label, url, token, toolPart, args] of [
    ["maintenance-agent over Maintenance MCP", `${m.url}/mcp`, tokens.agent, "releases", { id: rel.id, planDigest: rel.planDigest }],
    ["boundry-maintenance over Resolver Control MCP", `${rcUrl}/mcp`, maintenanceInRc, "changes", { id: change.id }],
  ] as const) {
    const c = await mcpAs(url, token);
    const tool = (await c.listTools()).tools.map((t) => t.name).find((n) => n.includes(toolPart) && n.includes("approve"));
    const r: any = tool ? await c.callTool({ name: tool, arguments: args as any }) : { isError: true, content: [{ text: "approve tool not offered to this principal" }] };
    authority.push({ actor: label, attempt: `call ${tool ?? "(approve tool)"}`, target: url, outcome: r.isError ? `refused: ${JSON.stringify(r.content).slice(0, 200)}` : "ALLOWED" });
    await c.close();
  }

  // ── 8. One application, both dependencies: read through Maintenance's applications.inspect ──
  const view: any = await maint(tokens.agent).call("applications.inspect", { id: "shop" });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "1-application-view.md"), view.markdown);
  writeFileSync(join(outDir, "1-application-view.json"), JSON.stringify(view.view, null, 2) + "\n");
  const relRecord: any = await maint(tokens.randy).call("releases.inspect", { id: rel.id });
  writeFileSync(join(outDir, "2-package-release.md"), relRecord.approvalRequest + "\n");
  writeFileSync(join(outDir, "3-runtime-change.json"), JSON.stringify(verified, null, 2) + "\n");
  writeFileSync(join(outDir, "4-authority-checks.json"), JSON.stringify(authority, null, 2) + "\n");

  // ── 9. Independent verification: each authority asked directly ──
  const history = JSON.parse(resolver(["history", "ref://prod/search"]));
  const regDoc: any = await (await fetch(`${regUrl}/@demo%2fcore`)).json();
  const rec = relRecord.record;
  const v = {
    package: {
      authority: "test npm registry + git (facts); Boundry Maintenance (governance)",
      registryVersions: Object.keys(regDoc.versions), registryIntegrity: regDoc.versions["0.2.1"]?.dist?.integrity ?? null,
      builtIntegrity: rec.facts.build?.artifacts[0]?.integrity ?? null, integrityMatches: regDoc.versions["0.2.1"]?.dist?.integrity === rec.facts.build?.artifacts[0]?.integrity,
      tagTarget: execFileSync("git", ["-C", repo.bare, "rev-parse", "@demo/core@0.2.1^{commit}"], { encoding: "utf8" }).trim(), releaseCommit: rec.facts.releaseCommit,
      proposedBy: `${rec.plan.requestedBy} (${rec.plan.requestedByType})`, approvals: rec.approvals.map((a: any) => `${a.by} (${a.principalType}, ${a.authentication})`),
      downstreamForShop: rec.downstream.filter((d: any) => d.consumer === "shop"),
    },
    runtime: {
      authority: "Resolver (bindings, history, enforcement); Resolver Control (governance)",
      resolverHistory: history.entries.map((e: any) => ({ revision: e.revision, governance: e.governance ? { mode: e.governance.mode, issuer: e.governance.issuer, decision: e.governance.decision, approvers: e.governance.approvers } : null, reason: e.reason })),
      change: { id: verified.id, number: verified.number, status: verified.status, proposedBy: `${verified.proposedBy} (${verified.proposedByType})`, approvals: verified.approvals.map((a: any) => a.by), required: verified.impact.requiredApprovals, verification: verified.verification?.passed, authorization: verified.verification?.governance?.mode },
      shopFollowed: shopSays().filter((l: any) => l.revision === 2).slice(0, 1),
    },
    noDuplicateTruth: {
      maintenanceStoresRuntimeBindings: false,
      evidence: "Maintenance's records (release-manager/*.json) contain no ref:// binding or revision; the runtime section of the application view is read from Resolver Control at request time and labelled with its read time.",
      maintenanceRecordsMentionRef: JSON.stringify(rec).includes("ref://"),
    },
    authority,
  };
  writeFileSync(join(outDir, "5-independent-verification.json"), JSON.stringify(v, null, 2) + "\n");
  console.log(JSON.stringify(v, null, 2));
  m.server.close();
  void rc; void chmodSync;
} finally {
  for (const c of children.reverse()) c.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
}
