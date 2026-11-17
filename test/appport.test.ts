// Maintenance over AppPort (HTTP) and MCP: the same governed operations, the same refusals, for people and agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@appport/client";
import { createHttpTransport } from "@appport/transport-http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReleaseManager } from "../src/release/manager.ts";
import { GitCli } from "../src/release/adapters.ts";
import { PackageConfig, ProjectConfig } from "../src/contracts.ts";
import { createMaintenanceApplication, permissionsOf } from "../src/appport/application.ts";
import { serveMaintenance } from "../src/appport/serve.ts";
import { makeRepo, FakeRegistry, FakeReleases, PackingExecutor, PRINCIPALS } from "./release-fakes.ts";

const h = (t: string) => createHash("sha256").update(t).digest("hex");
const TOKENS = { [h("t-bot")]: "bot", [h("t-randy")]: "randy", [h("t-grace")]: "grace", [h("t-exe")]: "component:release-executor" };

async function setup() {
  const repo = makeRepo();
  const registry = new FakeRegistry();
  registry.seed("@demo/core", ["0.2.0"]);
  const runtimeDir = mkdtempSync(join(tmpdir(), "ap-run-"));
  let t = Date.UTC(2026, 10, 17, 9, 0, 0);
  const manager = new ReleaseManager({
    dataDir: mkdtempSync(join(tmpdir(), "ap-data-")), runtimeDir, principals: PRINCIPALS, testRegistries: [registry.url],
    catalog: [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: { approvers: ["randy"] } })],
    registry: () => registry, releases: new FakeReleases(), executor: new PackingExecutor(repo.url), pollMs: 1, now: () => new Date((t += 1000)).toISOString(),
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  });
  const projects = [ProjectConfig.parse({ id: "shop", name: "Shop", repository: "acme/shop", managedPackages: [] })];
  const app = createMaintenanceApplication({ manager, principals: PRINCIPALS, projects, installations: () => [], packageNames: { "demo-core": "@demo/core" }, resolverControl: null });
  const { server, url } = await serveMaintenance(app, { tokens: TOKENS, principals: PRINCIPALS });
  const as = (token?: string) => createClient({ transport: createHttpTransport({ url: `${url}/appport`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }) });
  return { server, url, as, registry };
}
const code = (c: string) => (e: any) => e?.code === c;

test("AppPort: permissions are the contract's effects; an agent proposes, only a person approves, only trigger holders trigger", async () => {
  const { server, as, registry } = await setup();
  try {
    assert.deepEqual(permissionsOf(PRINCIPALS.find((p) => p.id === "bot")!), ["maintenance.propose", "maintenance.read", "maintenance.withdraw"]);
    await assert.rejects(as().call("releases.list", {}), code("UNAUTHORIZED"), "anonymous");
    await assert.rejects(as("t-unknown").call("releases.list", {}), code("UNAUTHORIZED"), "unknown token");
    const bot = as("t-bot");
    const proposed: any = await bot.call("releases.propose", { packages: ["demo-core"], bump: "patch", reason: "drift" });
    assert.equal(proposed.release.proposedBy, "bot");
    assert.match(proposed.approvalRequest, /Release request: @demo\/core/);
    const id = proposed.release.id, digest = proposed.release.planDigest;
    await assert.rejects(bot.call("releases.approve", { id, planDigest: digest }), code("FORBIDDEN"), "AppPort refuses before the handler: the agent holds no approve effect");
    await assert.rejects(bot.call("releases.trigger", { id }), code("FORBIDDEN"));
    await assert.rejects(as("t-grace").call("releases.approve", { id, planDigest: digest }), code("FORBIDDEN"), "an engineer cannot approve");
    await assert.rejects(as("t-exe").call("releases.approve", { id, planDigest: digest }), code("FORBIDDEN"), "a component cannot approve");
    const randy = as("t-randy");
    await assert.rejects(randy.call("releases.approve", { id, planDigest: "0".repeat(64) }), (e: any) => e?.code === "FORBIDDEN" && /digest-mismatch/.test(e.message), "the handler's contract rules apply after AppPort's");
    const approved: any = await randy.call("releases.approve", { id, planDigest: digest });
    assert.deepEqual([approved.state, approved.approvals[0].authentication], ["approved", "asserted"], "a bearer token is not a person's authentication");
    await assert.rejects(bot.call("releases.abandon", { id, reason: "agent tries" }), code("FORBIDDEN"), "abandonment is never available to agents");
    const done: any = await randy.call("releases.trigger", { id });
    assert.equal(done.state, "released");
    assert.equal(registry.publishes, 1);
  } finally { server.close(); }
});

test("MCP: the same capabilities as tools, the same refusals; identity comes from the host, never from arguments", async () => {
  const { server, url } = await setup();
  const mcp = async (token: string) => {
    const c = new Client({ name: "test-agent", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  try {
    const agent = await mcp("t-bot");
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["releases.propose", "releases.approve", "releases.trigger", "applications.inspect"]) assert.ok(tools.some((t) => t.includes(n.replace(".", "_")) || t.includes(n)), `${n} in ${tools.join(", ")}`);
    const name = (n: string) => tools.find((t) => t.includes(n.replace(".", "_")) || t.includes(n))!;
    const p: any = await agent.callTool({ name: name("releases.propose"), arguments: { packages: ["demo-core"], bump: "patch" } });
    assert.ok(!p.isError, JSON.stringify(p));
    const out = JSON.parse(p.content[0].text);
    const release = out.release ?? out.output?.release;
    const ap: any = await agent.callTool({ name: name("releases.approve"), arguments: { id: release.id, planDigest: release.planDigest } });
    assert.equal(ap.isError, true, "an agent cannot approve over MCP");
    assert.match(JSON.stringify(ap.content), /FORBIDDEN|forbidden|permission/i);
    const spoof: any = await agent.callTool({ name: name("releases.approve"), arguments: { id: release.id, planDigest: release.planDigest, principal: "randy", _meta: { principal: "randy" } } as any });
    assert.equal(spoof.isError, true, "identity cannot be supplied in tool arguments");
    const view: any = await agent.callTool({ name: name("applications.inspect"), arguments: { id: "shop" } });
    assert.match(JSON.stringify(view.content), /no resolverApplication link/, "an unknown runtime side is stated, not assumed empty");
    await agent.close();
  } finally { server.close(); }
});
