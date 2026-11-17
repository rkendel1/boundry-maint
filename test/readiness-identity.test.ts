// Production identity with the REAL governance configuration (config/principals.json as committed): what it refuses
// today. Nothing here adds a principal or a key; the registry is a stand-in that is NOT declared a test registry, so
// the production rules apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReleaseManager, ReleaseError } from "../src/release/manager.ts";
import { GitCli } from "../src/release/adapters.ts";
import { PackageConfig, PrincipalCatalog } from "../src/contracts.ts";
import { signWithKeyFile } from "../src/governance/signatures.ts";
import { createMaintenanceApplication } from "../src/appport/application.ts";
import { makeRepo, FakeRegistry, FakeReleases, PackingExecutor } from "./release-fakes.ts";

const principals = PrincipalCatalog.parse(JSON.parse(readFileSync(new URL("../config/principals.json", import.meta.url), "utf8"))).principals;
const refused = (re: RegExp) => (e: unknown) => e instanceof ReleaseError && re.test(e.message);

function world(criticality: "medium" | "critical" = "medium") {
  const repo = makeRepo();
  const registry = new FakeRegistry(); // production: not in testRegistries
  registry.seed("@demo/core", ["0.2.0"]);
  const runtimeDir = mkdtempSync(join(tmpdir(), "ri-run-"));
  const d = {
    dataDir: mkdtempSync(join(tmpdir(), "ri-data-")), runtimeDir, principals, testRegistries: [],
    catalog: [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", criticality, release: { approvers: ["randy"] } })],
    registry: () => registry, releases: new FakeReleases(), executor: new PackingExecutor(repo.url), pollMs: 1,
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  };
  return { repo, registry, d, m: new ReleaseManager(d) };
}

test("committed principals: one person, no registered signing key, no independent reviewer", () => {
  const people = principals.filter((p) => p.type === "person");
  assert.deepEqual(people.map((p) => p.id), ["randy"]);
  assert.deepEqual(people.flatMap((p) => p.keys), [], "no SSH approval key registered");
});

test("production with the committed principals: unsigned, forged and token-only approvals are all refused; nothing is published", async () => {
  const w = world();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "maintenance-agent" });
  assert.equal(r.plan.packages[0]!.production, true);
  // 1. Missing identity evidence: an asserted name.
  await assert.rejects(w.m.approve(r.id, "randy", r.planDigest), refused(/unauthenticated-for-production/));
  // 2. Invalid identity evidence: a valid SSH signature by a key that is not registered to randy.
  const dir = mkdtempSync(join(tmpdir(), "ri-key-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")]);
  const forged = await signWithKeyFile(join(dir, "k"), await w.m.statement(r.id, "randy"));
  await assert.rejects(w.m.approve(r.id, "randy", r.planDigest, forged), refused(/does not verify against randy's registered keys/));
  // 3. A record edited to claim a signed approval: the executor re-verifies and refuses before any mutation.
  const raw = JSON.parse(readFileSync(w.m.path(r.id), "utf8"));
  raw.approvals = [{ by: "randy", principalType: "person", authentication: "signature", at: new Date().toISOString(), planDigest: r.planDigest, signature: forged }];
  raw.state = "approved";
  writeFileSync(w.m.path(r.id), JSON.stringify(raw));
  const head = w.repo.head();
  const out = await w.m.execute(r.id, "randy");
  assert.equal(out.state, "failed");
  assert.match(out.failure!.reason, /unauthenticated-for-production/);
  assert.equal(out.claim, null, "refused before the claim");
  assert.equal(w.repo.head(), head);
  assert.equal(w.registry.publishes, 0);
});

test("AppPort/MCP approvals carry asserted identity: refused for production unless they carry a valid signature", async () => {
  const w = world();
  const app = createMaintenanceApplication({ manager: w.m, principals, projects: [], installations: () => [], packageNames: {}, resolverControl: null });
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "maintenance-agent" });
  const res: any = await app.handleRequest({ protocol: "appport/1", type: "request", id: "1", capability: { name: "releases.approve", version: 1 }, input: { id: r.id, planDigest: r.planDigest } } as never, { session: { id: "s", applicationId: app.descriptor.id, createdAt: new Date().toISOString(), principal: { id: "randy", type: "user" }, permissions: ["maintenance.approve", "maintenance.approve.protected"] }, principal: { id: "randy", type: "user" } } as never);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(JSON.stringify(res.error), /unauthenticated-for-production/);
});

test("critical production releases cannot even be planned with the committed principals (two distinct people required)", async () => {
  const w = world("critical");
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "maintenance-agent" }), refused(/needs 2 approval\(s\).*only 1 eligible/));
});
