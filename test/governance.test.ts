// Governance rules applied to releases: who may propose, approve, withdraw and trigger execution.
// Same rules as Resolver Control (feltkit/changes.ts approve, _rules.ts requiredApprovals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseManager, ReleaseError } from "../src/release/manager.ts";
import { GitCli } from "../src/release/adapters.ts";
import { PackageConfig, Principal, PrincipalCatalog } from "../src/contracts.ts";
import { CAPABILITIES, ROLE_PERMISSIONS, authorize, checkApproval, requiredApprovals, GovernanceError } from "../src/governance/rules.ts";
import { makeRepo, FakeRegistry, FakeReleases, PackingExecutor, PRINCIPALS } from "./release-fakes.ts";

const pkg = (release: object, extra: object = {}) => [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: { approvers: ["randy", "ada", "barbara", "grace", "bot", "mallory"], ...release }, ...extra })];

function world(catalog: PackageConfig[]) {
  const repo = makeRepo({});
  const registry = new FakeRegistry();
  registry.seed("@demo/core", ["0.2.0"]);
  const runtimeDir = mkdtempSync(join(tmpdir(), "gov-run-"));
  let t = Date.UTC(2026, 10, 17, 9, 0, 0);
  const d = {
    dataDir: mkdtempSync(join(tmpdir(), "gov-data-")), runtimeDir, catalog, principals: PRINCIPALS, registry: () => registry, releases: new FakeReleases(), executor: new PackingExecutor(repo.url), pollMs: 1,
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
    now: () => new Date((t += 1000)).toISOString(),
  };
  return { repo, registry, d, m: new ReleaseManager(d) };
}
const refused = (re: RegExp) => (e: unknown) => e instanceof ReleaseError && e.code === "not-allowed" && re.test(e.message);

test("an agent can propose, but cannot approve or execute", async () => {
  const w = world(pkg({}));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot", reason: "dependency drift" });
  assert.equal(r.state, "awaiting-approval");
  assert.equal(r.plan.requestedByType, "agent");
  await assert.rejects(w.m.approve(r.id, "bot", r.planDigest), refused(/only a person may approve/));
  await assert.rejects(w.m.execute(r.id, "bot"), refused(/may not releases\.execute/));
  const after = await w.m.load(r.id);
  assert.equal(after.state, "awaiting-approval");
  assert.equal(after.approvals.length, 0);
  assert.equal(w.registry.publishes, 0);
  // A person approves the agent's proposal; it then runs.
  await w.m.approve(r.id, "randy", r.planDigest);
  assert.equal((await w.m.execute(r.id, "randy")).state, "released");
});

test("separation of duties: the proposer may not approve; nobody approves twice; unknown principals are refused", async () => {
  const w = world(pkg({ approvalsRequired: 2 }));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "randy" });
  await assert.rejects(w.m.approve(r.id, "randy", r.planDigest), refused(/proposed .* and may not approve/));
  await w.m.approve(r.id, "ada", r.planDigest);
  await assert.rejects(w.m.approve(r.id, "ada", r.planDigest), refused(/already approved/));
  await assert.rejects(w.m.approve(r.id, "eve", r.planDigest), refused(/unknown principal/));
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "minor", requestedBy: "eve" }), refused(/unknown principal/));
  assert.equal((await w.m.load(r.id)).state, "awaiting-approval", "one of two approvals");
  // An engineer cannot trigger execution; an admin can, but nothing runs until approved.
  await assert.rejects(w.m.execute(r.id, "grace"), refused(/may not releases\.execute/));
  assert.equal((await w.m.execute(r.id, "randy")).state, "awaiting-approval");
  await w.m.approve(r.id, "mallory", r.planDigest);
  const done = await w.m.execute(r.id, "randy");
  assert.equal(done.state, "released");
  assert.deepEqual(done.approvals.map((a) => [a.by, a.principalType, a.authentication]), [["ada", "person", "asserted"], ["mallory", "person", "asserted"]]);
});

test("a critical package needs two distinct people, whatever its policy says", async () => {
  const w = world(pkg({ approvalsRequired: 1 }, { criticality: "critical" }));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  assert.equal(r.plan.requiredApprovals, 2);
  assert.equal((await w.m.approve(r.id, "randy", r.planDigest)).state, "awaiting-approval");
  assert.equal((await w.m.approve(r.id, "ada", r.planDigest)).state, "approved");
});

test("protected releases need prod_approver; an approver suffices only when unprotected", async () => {
  const w = world(pkg({}));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  assert.equal(r.plan.protected, true, "publishing to a registry is protected by default");
  await assert.rejects(w.m.approve(r.id, "barbara", r.planDigest), refused(/protected/));
  const u = world(pkg({ protected: false }));
  const r2 = await u.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  assert.equal((await u.m.approve(r2.id, "barbara", r2.planDigest)).state, "approved");
});

test("frozen: no approval; an approved release waits; a tightened policy sends it back for approval", async () => {
  const w = world(pkg({}));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await w.m.approve(r.id, "randy", r.planDigest);
  // Freeze after approval: execution waits, nothing changes.
  const frozen = new ReleaseManager({ ...w.d, catalog: pkg({ frozen: true, freezeReason: "incident 42" }) });
  const waited = await frozen.execute(r.id, "randy");
  assert.equal(waited.state, "approved");
  assert.match(waited.attempts.at(-1)!.detail, /frozen: incident 42/);
  assert.equal(w.registry.publishes, 0);
  // Tighten to two approvals: back to awaiting approval; the existing approval still counts.
  const tight = new ReleaseManager({ ...w.d, catalog: pkg({ approvalsRequired: 2 }) });
  assert.equal((await tight.execute(r.id, "randy")).state, "awaiting-approval");
  assert.equal((await tight.approve(r.id, "ada", r.planDigest)).state, "approved");
  assert.equal((await tight.execute(r.id, "randy")).state, "released");
  // While frozen, approving is refused.
  const w2 = world(pkg({ frozen: true, freezeReason: "release freeze" }));
  const r2 = await w2.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await assert.rejects(w2.m.approve(r2.id, "randy", r2.planDigest), refused(/frozen/));
});

test("a plan nobody could approve is refused at proposal time", async () => {
  const w = world([PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", criticality: "critical", release: { approvers: ["randy", "grace"] } })]);
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" }), refused(/needs 2 approval\(s\).*only 1 eligible/));
});

test("withdraw: the proposer or an approver; nobody else", async () => {
  const w = world(pkg({}));
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot" });
  await assert.rejects(w.m.revoke(r.id, "grace", "no"), refused(/only its proposer or an approver/));
  assert.equal((await w.m.revoke(r.id, "bot", "superseded by a bigger change")).state, "cancelled");
});

test("principal catalog: only people approve or administer, only components execute", () => {
  assert.throws(() => Principal.parse({ id: "bot", name: "b", type: "agent", roles: ["approver"] }), /only people approve/);
  assert.throws(() => Principal.parse({ id: "x", name: "x", type: "person", roles: ["executor"] }), /only a component executes/);
  assert.throws(() => PrincipalCatalog.parse({ principals: [PRINCIPALS[0], PRINCIPALS[0]] }), /duplicate/);
  // Static guarantees of the role table.
  assert.ok(!ROLE_PERMISSIONS.agent.some((p) => p.startsWith("releases.approve") || p === "releases.execute" || p === "releases.trigger"));
  assert.ok(!ROLE_PERMISSIONS.executor.some((p) => p === "releases.propose" || p.startsWith("releases.approve")));
  assert.equal(CAPABILITIES["maintenance.scan"].effect, "observe");
  assert.equal(requiredApprovals(1, "critical"), 2);
  assert.equal(requiredApprovals(3, "critical"), 3);
  const comp = Principal.parse({ id: "component:release-executor", name: "e", type: "component", roles: ["executor"] });
  assert.throws(() => checkApproval(comp, { id: "x", proposedBy: "a", approvals: [], protected: false, frozen: null }), GovernanceError);
  assert.throws(() => authorize(comp, "releases.propose"), /needs releases.propose/);
});
