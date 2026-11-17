// Contract 1.2.0: withdrawal ends at claim; abandonment is a person's decision after reconciliation; a replacement
// needs that reconciliation and never reuses a version the abandoned release may have made real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReleaseManager, ReleaseError } from "../src/release/manager.ts";
import { GitCli, Unavailable } from "../src/release/adapters.ts";
import { PackageConfig, ReleaseRecord } from "../src/contracts.ts";
import { makeRepo, FakeRegistry, FakeReleases, PackingExecutor, PRINCIPALS } from "./release-fakes.ts";

function world() {
  const repo = makeRepo();
  const registry = new FakeRegistry();
  registry.seed("@demo/core", ["0.1.0", "0.2.0"]);
  const runtimeDir = mkdtempSync(join(tmpdir(), "ab-run-"));
  let t = Date.UTC(2026, 10, 17, 9, 0, 0);
  const d = {
    dataDir: mkdtempSync(join(tmpdir(), "ab-data-")), runtimeDir, principals: PRINCIPALS, testRegistries: [registry.url],
    catalog: [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: { approvers: ["randy", "ada"], githubRelease: false } })],
    registry: () => registry, releases: new FakeReleases(), executor: new PackingExecutor(repo.url), pollMs: 1, now: () => new Date((t += 1000)).toISOString(),
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  };
  return { repo, registry, d, m: new ReleaseManager(d) };
}
const refused = (re: RegExp) => (e: unknown) => e instanceof ReleaseError && re.test(e.message);
const tagAt = (bare: string, tag: string) => { try { return execFileSync("git", ["-C", bare, "rev-parse", `${tag}^{commit}`], { encoding: "utf8", stdio: "pipe" }).trim(); } catch { return null; } };

async function approvedByAgent(w: ReturnType<typeof world>) {
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot" });
  await w.m.approve(r.id, "randy", r.planDigest);
  return r;
}

test("an agent withdraws its own approved proposal before claim; approvals are kept", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  const out = await w.m.revoke(r.id, "bot", "no longer wanted");
  assert.equal(out.state, "cancelled");
  assert.deepEqual(out.approvals.map((a) => a.by), ["randy"]);
  assert.equal(out.claim, null);
});

test("claimed before any external mutation: withdrawal and rejection refused; abandonment needs a person, a reason and reconciliation", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  const head = w.repo.head();
  // The registry goes down right after the claim: #prepare stops before pushing anything.
  const state = w.registry.state.bind(w.registry);
  let calls = 0;
  // Call 1 is the reassessment before the claim; call 2 is the first read inside #prepare, after the claim.
  w.registry.state = async (n: string) => { if (++calls > 1) throw new Unavailable("registry down"); return state(n); };
  const version = w.registry.version.bind(w.registry);
  w.registry.version = async (n: string, v: string) => { if (calls > 1) throw new Unavailable("registry down"); return version(n, v); };
  const stuck = await w.m.execute(r.id, "randy");
  assert.equal(stuck.state, "approved");
  assert.ok(stuck.claim && !stuck.claim.inferred, "claimed");
  assert.equal(stuck.failure!.recoverable, true);
  assert.equal(w.repo.head(), head, "no external mutation happened");
  await assert.rejects(w.m.revoke(r.id, "bot", "withdraw"), refused(/\[claimed\]/), "the proposer (an agent)");
  await assert.rejects(w.m.revoke(r.id, "ada", "reject"), refused(/\[claimed\]/), "an approver's rejection");
  await assert.rejects(w.m.abandon(r.id, "bot", "agent tries"), refused(/person-only|forbidden-effect/));
  await assert.rejects(w.m.abandon(r.id, "grace", "engineer tries"), refused(/forbidden-effect/));
  await assert.rejects(w.m.abandon(r.id, "ada", "  "), refused(/reason-required/));
  // Still down: reconciliation impossible, so abandonment is refused and nothing changes.
  await assert.rejects(w.m.abandon(r.id, "ada", "registry gone"), refused(/unreconciled/));
  assert.equal((await w.m.load(r.id)).state, "approved");
  w.registry.state = state; w.registry.version = version;
  const ab = await w.m.abandon(r.id, "ada", "stuck behind a registry incident; replacing");
  assert.equal(ab.state, "abandoned");
  assert.deepEqual([ab.abandonment!.by, ab.abandonment!.byType, ab.abandonment!.atState], ["ada", "person", "approved"]);
  assert.equal(ab.abandonment!.reconciliation.releaseCommitOnBranch, false);
  assert.deepEqual(ab.abandonment!.remainsReal, ["nothing: no release commit on the branch, no tags, no published versions"]);
  assert.ok(ab.claim && ab.approvals.length === 1 && ab.attempts.some((a) => a.step === "claim"), "proposal, approval, claim and attempts preserved");
  assert.equal((await w.m.execute(r.id, "randy")).state, "abandoned", "terminal: never resumed");
  ReleaseRecord.parse(JSON.parse(readFileSync(w.m.path(r.id), "utf8")));
});

test("crash after the release commit and tag, before publication: abandonment records what is real and rolls nothing back; the replacement skips the version", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  const publish = w.registry.publish.bind(w.registry);
  w.registry.publish = async () => { throw new Unavailable("process crashed before publishing"); };
  const stuck = await w.m.execute(r.id, "randy");
  assert.equal(stuck.state, "tagged");
  const commit = stuck.facts.releaseCommit!;
  assert.equal(tagAt(w.repo.bare, "@demo/core@0.2.1"), commit);
  await assert.rejects(w.m.revoke(r.id, "bot", "withdraw"), refused(/\[claimed\]/));
  const ab = await w.m.abandon(r.id, "randy", "superseded by a hotfix release");
  assert.equal(ab.state, "abandoned");
  const rec = ab.abandonment!.reconciliation;
  assert.deepEqual([rec.releaseCommitOnBranch, rec.releaseCommit, rec.tags[0]!.target, rec.registry[0]!.present], [true, commit, commit, false]);
  assert.ok(ab.abandonment!.remainsReal.some((x) => /release commit .* stays there/.test(x)));
  assert.ok(ab.abandonment!.remainsReal.some((x) => /tag @demo\/core@0\.2\.1 .* never moved or deleted/.test(x)));
  assert.equal(w.repo.head(), commit, "the release commit is not reverted");
  assert.equal(tagAt(w.repo.bare, "@demo/core@0.2.1"), commit, "the tag is not deleted");
  w.registry.publish = publish;
  const next = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot" });
  assert.equal(next.plan.packages[0]!.proposedVersion, "0.2.2", "0.2.1 is reserved: its tag is real");
  assert.ok(next.plan.decision.some((x) => /Reserved: 0\.2\.1 \(claimed by abandoned release demo-core@0\.2\.1\)/.test(x)));
});

test("an ambiguous publish is never recorded as a clean failure: reconciliation finds the version published", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  // The registry stores the artifact, the answer is lost, and the process dies before it can ask.
  const publish = w.registry.publish.bind(w.registry), version = w.registry.version.bind(w.registry);
  w.registry.publish = async (p: string, o: { distTag: string }) => { await publish(p, o); w.registry.version = async () => { throw new Unavailable("connection lost"); }; throw new Unavailable("response lost"); };
  const stuck = await w.m.execute(r.id, "randy");
  assert.equal(stuck.state, "tagged");
  assert.equal(stuck.facts.published.length, 0, "the record does not know it was published");
  await assert.rejects(w.m.abandon(r.id, "randy", "give up"), refused(/unreconciled/), "while the registry cannot be asked");
  w.registry.version = version;
  const ab = await w.m.abandon(r.id, "randy", "give up");
  const reg = ab.abandonment!.reconciliation.registry[0]!;
  assert.deepEqual([reg.present, reg.matchesBuiltArtifact], [true, true]);
  assert.ok(ab.abandonment!.remainsReal.some((x) => /IS published on the registry with exactly the built artifact/.test(x)));
  const next = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot" });
  assert.equal(next.plan.packages[0]!.proposedVersion, "0.2.2");
});

test("a replacement is refused while an abandoned predecessor has no reconciliation", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  w.registry.publish = async () => { throw new Unavailable("down"); };
  await w.m.execute(r.id, "randy");
  // A hand-made record (or one from another tool) claiming abandonment without reconciliation.
  const raw = JSON.parse(readFileSync(w.m.path(r.id), "utf8"));
  raw.state = "abandoned"; raw.abandonment = null;
  writeFileSync(w.m.path(r.id), JSON.stringify(raw));
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "bot" }), refused(/\[unreconciled\]/));
});

test("a schema-2 record (before 1.2.0) is read as it is; its claim is inferred, refused withdrawal, and the upgrade is noted on save", async () => {
  const w = world();
  const r = await approvedByAgent(w);
  w.registry.publish = async () => { throw new Unavailable("down"); };
  await w.m.execute(r.id, "randy");
  const raw = JSON.parse(readFileSync(w.m.path(r.id), "utf8"));
  raw.schemaVersion = 2; delete raw.claim; delete raw.abandonment;
  raw.attempts = raw.attempts.filter((a: any) => a.step !== "claim");
  writeFileSync(w.m.path(r.id), JSON.stringify(raw));
  const legacy = await w.m.load(r.id);
  assert.equal(legacy.schemaVersion, 2, "not migrated on read");
  await assert.rejects(w.m.revoke(r.id, "bot", "withdraw"), refused(/\[claimed\]/), "claim inferred from its history");
  const ab = await w.m.abandon(r.id, "randy", "legacy release stuck");
  assert.equal(ab.schemaVersion, 3);
  assert.equal(ab.claim!.inferred, true);
  assert.ok(ab.history.some((h) => /record schema 2 → 3 \(governance contract 1\.2\.0\): claim inferred from history/.test(h.note)));
});
