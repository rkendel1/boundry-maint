// Release Manager acceptance tests: lifecycle, invariants, failure and recovery.
// Git is real (temporary bare repositories); registry, GitHub and the executor are stand-ins with failure
// injection (the executor really runs `npm pack` on the release commit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReleaseManager, ReleaseError } from "../src/release/manager.ts";
import { GitCli } from "../src/release/adapters.ts";
import { PackageConfig, ReleaseRecord } from "../src/contracts.ts";
import { makeRepo, FakeRegistry, FakeReleases, PackingExecutor } from "./release-fakes.ts";
import { editPackageLock } from "../src/release/manifests.ts";

const policy = { approvers: ["randy"] };
const CATALOG = [
  PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: policy }),
  PackageConfig.parse({ id: "demo-client", name: "@demo/client", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/client", release: policy }),
  PackageConfig.parse({ id: "demo-noplan", name: "@demo/noplan", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core" }),
  PackageConfig.parse({ id: "tokio", name: "tokio", registry: "crates", ownership: "managed", repository: "tokio-rs/tokio" }),
];

function world(opts: { seed?: string[]; clientPin?: string } = {}) {
  const repo = makeRepo({ clientPin: opts.clientPin });
  const registry = new FakeRegistry();
  registry.seed("@demo/core", opts.seed ?? ["0.1.0", "0.2.0"]);
  const releases = new FakeReleases();
  const executor = new PackingExecutor(repo.url);
  const dataDir = mkdtempSync(join(tmpdir(), "rm-data-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "rm-run-"));
  let t = Date.UTC(2026, 10, 17, 9, 0, 0);
  const mk = () => new ReleaseManager({
    dataDir, runtimeDir, catalog: CATALOG, registry: () => registry, releases, executor, pollMs: 1,
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
    now: () => new Date((t += 1000)).toISOString(),
  });
  return { repo, registry, releases, executor, dataDir, runtimeDir, m: mk(), mk };
}
const tagsOf = (bare: string) => Object.fromEntries(execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname:short) %(*objectname)", "refs/tags"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split(" ")));
const readBlob = (bare: string, ref: string, path: string) => execFileSync("git", ["-C", bare, "show", `${ref}:${path}`], { encoding: "utf8" });

async function planned(w: ReturnType<typeof world>, packages = ["demo-core"]) {
  const r = await w.m.plan({ packages, bump: "patch", requestedBy: "randy", reason: "fix" });
  await w.m.approve(r.id, "randy", r.planDigest);
  return r;
}

test("happy path: plan → approve → prepared → built → tagged → published → registry-verified → released", async () => {
  const w = world();
  const source = w.repo.head();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "randy", reason: "fix a bug" });
  assert.equal(r.state, "awaiting-approval");
  assert.equal(r.plan.packages[0]!.proposedVersion, "0.2.1");
  assert.equal(r.plan.packages[0]!.tag, "@demo/core@0.2.1");
  assert.deepEqual(r.plan.releaseCommit.files, ["package-lock.json", "packages/core/package.json"]);
  const dep = r.plan.dependents.find((d) => d.package === "@demo/client")!;
  assert.match(dep.effect, /range \^0\.2\.0 accepts 0\.2\.1/);
  await assert.rejects(w.m.approve(r.id, "mallory", r.planDigest), (e: any) => e instanceof ReleaseError && /may not approve/.test(e.message));
  await assert.rejects(w.m.approve(r.id, "randy", "0".repeat(64)), /different plan/);
  await w.m.approve(r.id, "randy", r.planDigest);
  const done = await w.m.execute(r.id);
  assert.equal(done.state, "released", JSON.stringify(done.failure));
  assert.deepEqual(done.history.map((h) => h.state), ["proposed", "validated", "awaiting-approval", "approved", "prepared", "built", "tagged", "published", "registry-verified", "released"]);
  const head = w.repo.head();
  assert.equal(done.facts.releaseCommit, head);
  assert.equal(execFileSync("git", ["-C", w.repo.bare, "rev-parse", `${head}^`], { encoding: "utf8" }).trim(), source, "release commit sits directly on the approved source");
  assert.equal(JSON.parse(readBlob(w.repo.bare, head, "packages/core/package.json")).version, "0.2.1");
  assert.equal(JSON.parse(readBlob(w.repo.bare, head, "package-lock.json")).packages["packages/core"].version, "0.2.1");
  assert.equal(JSON.parse(readBlob(w.repo.bare, head, "packages/client/package.json")).dependencies["@demo/core"], "^0.2.0", "dependents are never changed");
  assert.equal(tagsOf(w.repo.bare)["@demo/core@0.2.1"], head, "tag points at the exact release commit");
  const art = done.facts.build!.artifacts[0]!;
  assert.equal(w.registry.pkgs.get("@demo/core")!.versions.get("0.2.1")!.integrity, art.sha512Integrity);
  assert.equal(w.registry.pkgs.has("@demo/client") && w.registry.pkgs.get("@demo/client")!.versions.size > 0, false, "dependent not published");
  assert.ok(done.facts.registryVerification[0]!.distTagPointsHere);
  assert.match(w.releases.lastBody, new RegExp(art.sha256));
  ReleaseRecord.parse(JSON.parse(readFileSync(w.m.path(r.id), "utf8")));
  assert.equal((await w.m.execute(r.id)).attempts.length, done.attempts.length, "re-executing a released release does nothing");
});

test("plan refusals: not owned, no release policy, unsupported registry, unknown", async () => {
  const w = world();
  await assert.rejects(w.m.plan({ packages: ["tokio"], bump: "patch", requestedBy: "x" }), /managed, not owned/);
  await assert.rejects(w.m.plan({ packages: ["demo-noplan"], bump: "patch", requestedBy: "x" }), /no release policy/);
  await assert.rejects(w.m.plan({ packages: ["nope"], bump: "patch", requestedBy: "x" }), /unknown package/);
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "major", requestedBy: "x" }), /does not allow a major/);
});

test("1. two concurrent release requests for the same package: exactly one plan", async () => {
  const w = world();
  const results = await Promise.allSettled([w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "a" }), w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "b" })]);
  // Both may compute the same id; the record file is created once and the second sees it.
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.ok(ok.length >= 1);
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "minor", requestedBy: "c" }), (e: any) => e.code === "busy");
  const r = (ok[0] as PromiseFulfilledResult<ReleaseRecord>).value;
  await w.m.approve(r.id, "randy", r.planDigest);
  const runs = await Promise.allSettled([w.m.execute(r.id), w.m.execute(r.id)]);
  const busy = runs.filter((x) => x.status === "rejected" && (x.reason as ReleaseError).code === "busy").length;
  const released = runs.filter((x) => x.status === "fulfilled" && x.value.state === "released").length;
  assert.equal(busy + released, 2);
  assert.equal(released >= 1, true);
  assert.equal(w.registry.publishes, 1, "published exactly once");
});

test("2. version collision: the proposed version appears on the registry after approval → superseded, nothing pushed", async () => {
  const w = world();
  const before = w.repo.head();
  const r = await planned(w);
  w.registry.pkgs.get("@demo/core")!.versions.set("0.2.1", { bytes: Buffer.from("other"), integrity: "sha512-other" });
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "superseded");
  assert.equal(w.repo.head(), before);
});

test("3. tag collision: an existing tag at another commit is never moved", async () => {
  const w = world();
  const r = await planned(w);
  execFileSync("git", ["-C", w.repo.bare, "tag", "@demo/core@0.2.1", w.repo.head()]); // someone else's tag on the source commit
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "failed");
  assert.match(out.failure!.reason, /already points at .* tags are never moved/);
  assert.equal(w.registry.publishes, 0, "never published without its tag");
});

test("4. failed build: nothing tagged or published; retry after a fix completes with a new build attempt", async () => {
  const w = world();
  const r = await planned(w);
  w.executor.mode = "fail-once";
  const blocked = await w.m.execute(r.id);
  assert.equal(blocked.state, "prepared");
  assert.equal(blocked.failure!.recoverable, true);
  assert.deepEqual(tagsOf(w.repo.bare), {});
  const done = await w.m.execute(r.id);
  assert.equal(done.state, "released");
  assert.deepEqual([...w.executor.byRequest.keys()].map((k) => k.split("/").pop()), ["build-1", "build-2"]);
  assert.ok(done.attempts.some((a) => a.step === "build" && a.outcome === "failed"), "the failed attempt is kept");
});

test("5+7. failed publish and registry temporarily unavailable: recoverable, retried after inspecting the registry", async () => {
  const w = world();
  const r = await planned(w);
  w.registry.mode = "unavailable-once";
  const a = await w.m.execute(r.id);
  assert.equal(a.state, "tagged");
  assert.equal(a.failure!.recoverable, true);
  w.registry.mode = "error-once";
  const b = await w.m.execute(r.id);
  assert.equal(b.state, "tagged");
  const c = await w.m.execute(r.id);
  assert.equal(c.state, "released");
  assert.equal(w.registry.publishes, 1);
  w.registry.mode = "down";
  const w2 = world(); const r2 = await planned(w2); w2.registry.mode = "down";
  const d = await w2.m.execute(r2.id);
  assert.equal(d.state, "approved", "cannot even prepare while the registry cannot be inspected");
  assert.equal(d.failure!.recoverable, true);
});

test("6. publish succeeds but the response is lost: the registry is asked, nothing is republished", async () => {
  const w = world();
  const r = await planned(w);
  w.registry.mode = "lose-response-once";
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "released");
  assert.equal(w.registry.publishes, 1);
  assert.equal(out.facts.published[0]!.alreadyPresent, true);
  assert.ok(out.attempts.some((x) => x.step === "publish" && x.outcome === "already-done" && /response lost/.test(x.detail)));
});

test("8. GitHub release creation fails after publication: release stays registry-verified, retry creates it once", async () => {
  const w = world();
  const r = await planned(w);
  w.releases.failOnce = true;
  const a = await w.m.execute(r.id);
  assert.equal(a.state, "registry-verified");
  assert.equal(a.failure!.recoverable, true);
  await assert.rejects(w.m.revoke(r.id, "randy", "too late"), /cannot be revoked/);
  const b = await w.m.execute(r.id);
  assert.equal(b.state, "released");
  assert.equal(w.releases.creates, 1);
  assert.equal(w.registry.publishes, 1);
});

test("9. retry after partial completion (process restart mid-release): reconciles, never duplicates commit, tag or publish", async () => {
  const w = world();
  const r = await planned(w);
  w.releases.failOnce = true;
  await w.m.execute(r.id); // reaches registry-verified
  // Simulate a crash that lost the record's later facts: roll the record back to "approved" with no facts.
  const rec = JSON.parse(readFileSync(w.m.path(r.id), "utf8"));
  rec.state = "approved"; rec.failure = null; rec.facts = { releaseCommit: null, build: null, tags: [], published: [], registryVerification: [], githubRelease: null };
  (await import("node:fs")).writeFileSync(w.m.path(r.id), JSON.stringify(rec));
  const head = w.repo.head();
  const fresh = w.mk(); // new process
  const out = await fresh.execute(r.id);
  assert.equal(out.state, "released", JSON.stringify(out.failure));
  assert.equal(w.repo.head(), head, "the identical release commit was recognised, not recreated");
  assert.ok(out.attempts.some((a) => a.step === "release-commit" && a.outcome === "already-done"));
  assert.ok(out.attempts.some((a) => a.step === "tag" && a.outcome === "already-done"));
  assert.ok(out.attempts.some((a) => a.step === "publish" && a.outcome === "already-done"));
  assert.equal(w.registry.publishes, 1);
  assert.equal(Object.keys(tagsOf(w.repo.bare)).length, 1);
});

test("10. wrong artifact digest or contents: refused before tagging", async () => {
  const w = world();
  const r = await planned(w);
  w.executor.mode = "corrupt-digest";
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "failed");
  assert.match(out.failure!.reason, /does not match its digest/);
  assert.deepEqual(tagsOf(w.repo.bare), {});
  const w2 = world(); const r2 = await planned(w2); w2.executor.mode = "wrong-version";
  const out2 = await w2.m.execute(r2.id);
  assert.match(out2.failure!.reason, /did not produce|contains/);
});

test("11. different artifact already published under the version (e.g. by hand): never overwritten", async () => {
  const w = world();
  const r = await planned(w);
  // Let it build and tag, then a different 0.2.1 lands on the registry before publish.
  w.registry.mode = "unavailable-once";
  await w.m.execute(r.id); // stops at tagged
  w.registry.pkgs.get("@demo/core")!.versions.set("0.2.1", { bytes: Buffer.from("x"), integrity: "sha512-somethingelse" });
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "failed");
  assert.match(out.failure!.reason, /DIFFERENT artifact/);
});

test("12. approval revoked before execution: cancelled, nothing changed", async () => {
  const w = world();
  const before = w.repo.head();
  const r = await planned(w);
  await w.m.revoke(r.id, "randy", "not today");
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "cancelled");
  assert.equal(w.repo.head(), before);
  assert.equal(w.registry.publishes, 0);
  assert.equal(out.approval!.revoked!.reason, "not today");
});

test("13. a newer version appears on the registry during the release: superseded before publishing", async () => {
  const w = world();
  const r = await planned(w);
  w.registry.mode = "unavailable-once";
  await w.m.execute(r.id); // tagged
  w.registry.pkgs.get("@demo/core")!.versions.set("0.3.0", { bytes: Buffer.from("n"), integrity: "sha512-n" });
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "superseded");
  assert.match(out.failure!.reason, /newer version \(0\.3\.0\)/);
  assert.equal(w.registry.publishes, 0);
});

test("14. repository changes after approval: superseded, nothing pushed over the new commit", async () => {
  const w = world();
  const r = await planned(w);
  const moved = w.repo.push({ "README.md": "changed\n" }, "unrelated change");
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "superseded");
  assert.match(out.failure!.reason, /repository changed after approval|moved while releasing/);
  assert.equal(w.repo.head(), moved);
});

test("workspace sibling with an exact pin: a lone release is refused (it would break npm ci); nothing is added silently", async () => {
  const w = world({ clientPin: "0.2.0" });
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "randy" }), (e: any) => e.code === "decision" && /break the workspace install/.test(e.message) && /--package demo-client/.test(e.message));
  // The failure this prevents, reproduced: without the planner check the release build's npm ci fails.
  const lone = makeRepo({ clientPin: "0.2.0" });
  // Exactly what a lone release commit would contain: the manifest and the lockfile bumped.
  const files = {
    "packages/core/package.json": JSON.stringify({ name: "@demo/core", version: "0.2.1", main: "index.js" }, null, 2) + "\n",
    "package-lock.json": editPackageLock(readBlob(lone.bare, "main", "package-lock.json"), { "packages/core": "0.2.1" }),
  };
  const bumped = lone.push(files, "bump core only");
  const ex = new PackingExecutor(lone.url);
  const { runId } = await ex.submit({ requestId: "x", repository: "acme/demo", commit: bumped, branch: "main", recipe: { path: ".boundry/recipes/x.md", source: "" } });
  assert.equal((await ex.status(runId)).state, "failed");
  // Online (the real resolver run) npm reports "Missing: …@0.2.0 from lock file"; offline it reports ENOTCACHED
  // one step earlier. Same cause: the workspace no longer provides the exactly-pinned 0.2.0.
  assert.match(ex.lastError, /Missing: @demo\/core@0\.2\.0 from lock file|ENOTCACHED/);
});

test("a coordinated multi-package release shares one release commit, one tag per package", async () => {
  const w = world({ clientPin: "0.2.0" });
  w.registry.seed("@demo/client", ["0.3.0"]);
  const r = await w.m.plan({ packages: ["demo-core", "demo-client"], bump: "patch", requestedBy: "randy" });
  assert.deepEqual(r.plan.packages.map((p) => `${p.name}@${p.proposedVersion}`), ["@demo/client@0.3.1", "@demo/core@0.2.1"]);
  await w.m.approve(r.id, "randy", r.planDigest);
  const out = await w.m.execute(r.id);
  assert.equal(out.state, "released");
  assert.deepEqual(r.plan.releaseCommit.pins, [{ in: "packages/client", dependency: "@demo/core", from: "0.2.0", to: "0.2.1" }]);
  const c = out.facts.releaseCommit!;
  assert.equal(JSON.parse(readBlob(w.repo.bare, c, "packages/client/package.json")).dependencies["@demo/core"], "0.2.1", "pin rewritten in the manifest");
  assert.equal(JSON.parse(readBlob(w.repo.bare, c, "package-lock.json")).packages["packages/client"].dependencies["@demo/core"], "0.2.1", "and in the lockfile");
  const tags = tagsOf(w.repo.bare);
  assert.equal(tags["@demo/core@0.2.1"], out.facts.releaseCommit);
  assert.equal(tags["@demo/client@0.3.1"], out.facts.releaseCommit);
  assert.equal(w.registry.publishes, 2);
});
