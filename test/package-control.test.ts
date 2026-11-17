// Package Control (Prompt 2): npm and crates, lockfiles, yanked versions, validation outcomes, reassessment,
// downstream proposals and consumer facts. Git and `cargo package` are real; registries are stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReleaseManager, ReleaseError } from "../src/release/manager.ts";
import { GitCli } from "../src/release/adapters.ts";
import { PackageConfig, ReleaseRecord, type Installation, type EvidenceRecord } from "../src/contracts.ts";
import { makeRepo, makeCargoRepo, FakeRegistry, FakeCratesRegistry, FakeReleases, PackingExecutor, CargoPackingExecutor, PRINCIPALS } from "./release-fakes.ts";

const policy = { approvers: ["randy", "ada"] };
let clock = Date.UTC(2026, 10, 17, 9, 0, 0);
const now = () => new Date((clock += 1000)).toISOString();
const blob = (bare: string, ref: string, path: string) => execFileSync("git", ["-C", bare, "show", `${ref}:${path}`], { encoding: "utf8" });
const inst = (o: Partial<Installation> & { project: string; package: string; repository: string; manifest: string; declaredVersion: string; resolvedVersion: string | null }): Installation => ({ ecosystem: "javascript", kind: "dependencies", root: ".", registry: "npm", name: "@demo/core", commit: `${o.project}-head`, ...o } as unknown as Installation);
/** A consumer's CI evidence record, as Maintenance's scan writes it (data/evidence/<project>.json). */
const ev = (project: string, commit: string, resolved: string, outcome: "pass" | "fail" | "pending", at: string, root = "."): EvidenceRecord => ({
  project, repository: `acme/${project}`, commit, collectedAt: at, scanRun: "scan-1", passed: outcome === "pass",
  checks: { resolution: "pass", workflows: outcome }, runs: outcome === "pending" ? [] : [{ workflow: "ci.yml", runId: 77, url: `https://ci.example/${project}/77`, status: "completed", conclusion: outcome === "pass" ? "success" : "failure", headSha: commit }],
  resolved: { [`${root}|npm:@demo/core`]: resolved },
});

function npmWorld(o: { installations?: Installation[]; clientPin?: string } = {}) {
  const repo = makeRepo({ clientPin: o.clientPin });
  const registry = new FakeRegistry();
  registry.seed("@demo/core", ["0.1.0", "0.2.0"]);
  const catalog = [PackageConfig.parse({ id: "demo-core", name: "@demo/core", registry: "npm", ownership: "owned", repository: "acme/demo", directory: "packages/core", release: policy })];
  const runtimeDir = mkdtempSync(join(tmpdir(), "pc-run-"));
  const d = {
    dataDir: mkdtempSync(join(tmpdir(), "pc-data-")), runtimeDir, catalog, principals: PRINCIPALS, testRegistries: [registry.url],
    installations: o.installations ?? [], registry: () => registry, releases: new FakeReleases(), executor: new PackingExecutor(repo.url), pollMs: 1, now,
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  };
  return { repo, registry, d, m: new ReleaseManager(d) };
}

function cargoWorld(o: Parameters<typeof makeCargoRepo>[0] & { seed?: string[]; yanked?: string[]; app?: boolean } = {}) {
  const repo = makeCargoRepo(o);
  const registry = new FakeCratesRegistry();
  registry.seed("demo-core", o.seed ?? ["0.1.0"], o.yanked ?? []);
  const catalog = [
    PackageConfig.parse({ id: "demo-core", name: "demo-core", registry: "crates", ownership: "owned", repository: "acme/rust", directory: "crates/core", release: policy }),
    PackageConfig.parse({ id: "demo-app", name: "demo-app", registry: "crates", ownership: "owned", repository: "acme/rust", directory: "crates/app", release: policy }),
  ];
  const runtimeDir = mkdtempSync(join(tmpdir(), "pc-crun-"));
  const executor = new CargoPackingExecutor(repo.url);
  const d = {
    dataDir: mkdtempSync(join(tmpdir(), "pc-cdata-")), runtimeDir, catalog, principals: PRINCIPALS, testRegistries: [registry.url], installations: [],
    registry: () => registry, releases: new FakeReleases(), executor, pollMs: 1, now,
    git: () => new GitCli(repo.url, join(runtimeDir, "git"), { name: "Boundry Release", email: "release@boundry.invalid" }),
  };
  return { repo, registry, executor, d, m: new ReleaseManager(d) };
}
const refused = (re: RegExp) => (e: unknown) => e instanceof ReleaseError && re.test(e.message);

// ───────── validation outcomes ─────────

test("every check is recorded with one of five outcomes; deferred checks say when they run", async () => {
  const w = npmWorld();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  const by = Object.fromEntries(r.plan.checks.map((c) => [c.check, c]));
  assert.equal(by["@demo/core: manifest and package-lock.json agree"]!.outcome, "passed");
  assert.equal(by["build and tests"]!.outcome, "deferred");
  assert.match(by["build and tests"]!.detail, /after approval/);
  assert.equal(by["registry acceptance"]!.outcome, "deferred");
  assert.equal(by["consumer verification"]!.outcome, "deferred");
  assert.equal(by["external consumers"]!.outcome, "unavailable", "no scan data: unknown, not assumed empty");
  assert.equal(by["workspace version inheritance"]!.outcome, "not-applicable");
  assert.ok(r.plan.unknowns.some((u) => /Consumers in other repositories/.test(u)));
  for (const c of r.plan.checks) assert.ok(["passed", "failed", "deferred", "unavailable", "not-applicable"].includes(c.outcome));
});

test("manifest and lockfile disagree: the plan is refused, naming both", async () => {
  const w = npmWorld();
  w.repo.push({ "packages/core/package.json": JSON.stringify({ name: "@demo/core", version: "0.2.5", main: "index.js" }, null, 2) + "\n" }, "edit version without the lockfile");
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "repository", requestedBy: "grace" }), refused(/declares 0\.2\.5 but package-lock\.json records 0\.2\.0/));
  const c = cargoWorld();
  c.repo.push({ "crates/core/Cargo.toml": readFileSync(join(c.repo.work, "crates/core/Cargo.toml"), "utf8").replace('version = "0.1.0"', 'version = "0.1.7"') }, "edit without Cargo.lock");
  await assert.rejects(c.m.plan({ packages: ["demo-core"], bump: "repository", requestedBy: "grace" }), refused(/declares 0\.1\.7 but Cargo\.lock records 0\.1\.0/));
});

// ───────── reassessment ─────────

test("reassessed before approval: a registry change supersedes the plan and the approval is refused", async () => {
  const w = npmWorld();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  w.registry.seed("@demo/core", ["0.1.0", "0.2.0", "0.2.1-rc.0"]); // someone published a prerelease meanwhile
  await assert.rejects(w.m.approve(r.id, "randy", r.planDigest), refused(/superseded.*the registry now has 3 version/));
  const rec = await w.m.load(r.id);
  assert.equal(rec.state, "superseded");
  assert.equal(rec.approvals.length, 0);
});

test("reassessed before execution: changed consumers supersede an approved plan; nothing is changed", async () => {
  const consumer = inst({ project: "shop", package: "demo-core", repository: "acme/shop", manifest: "package.json", declaredVersion: "^0.2.0", resolvedVersion: "0.2.0" });
  const w = npmWorld({ installations: [consumer] });
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await w.m.approve(r.id, "randy", r.planDigest);
  const head = w.repo.head();
  const later = new ReleaseManager({ ...w.d, installations: [consumer, inst({ project: "billing", package: "demo-core", repository: "acme/billing", manifest: "package.json", declaredVersion: "0.2.0", resolvedVersion: "0.2.0" })] });
  const out = await later.execute(r.id, "randy");
  assert.equal(out.state, "superseded");
  assert.match(out.history.at(-1)!.note, /consumers .* changed/);
  assert.equal(w.repo.head(), head);
  assert.equal(w.registry.publishes, 0);
});

// ───────── consumers: declared vs resolved; downstream proposals; installation ≠ adoption ≠ verification ─────────

test("consumers: declared and resolved are separate; after release, explicit downstream proposals; nothing applied", async () => {
  const installations = [
    inst({ project: "shop", package: "demo-core", repository: "acme/shop", manifest: "package.json", declaredVersion: "^0.2.0", resolvedVersion: "0.2.0" }),
    inst({ project: "billing", package: "demo-core", repository: "acme/billing", manifest: "package.json", declaredVersion: "0.2.0", resolvedVersion: "0.2.0" }),
    inst({ project: "legacy", package: "demo-core", repository: "acme/legacy", manifest: "package.json", declaredVersion: "^0.1.0", resolvedVersion: "0.1.0" }),
  ];
  const w = npmWorld({ installations });
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  const shop = r.plan.dependents.find((d) => d.package === "shop")!;
  assert.deepEqual([shop.declared, shop.resolved, shop.accepts], ["^0.2.0", "0.2.0", true]);
  const billing = r.plan.dependents.find((d) => d.package === "billing")!;
  assert.deepEqual([billing.declared, billing.accepts], ["0.2.0", false]);
  await w.m.approve(r.id, "randy", r.planDigest);
  const done = await w.m.execute(r.id, "randy");
  assert.equal(done.state, "released");
  const by = Object.fromEntries(done.downstream.map((d) => [d.consumer, d]));
  assert.deepEqual([by.shop!.kind, by.shop!.from, by.shop!.to], ["lockfile-update", "0.2.0", "0.2.1"]);
  assert.deepEqual([by.billing!.kind, by.billing!.from, by.billing!.to], ["requirement-change", "0.2.0", "0.2.1"]);
  assert.deepEqual([by.legacy!.kind, by.legacy!.to], ["requirement-change", "^0.2.1"]);
  assert.ok(done.downstream.every((d) => d.state === "proposed" && /own plan and approval/.test(d.note)));
  // Observations: released ≠ adopted ≠ verified. Verification comes only from the consumer's own CI evidence for
  // a consumer commit whose lockfile resolved exactly the released version, for that manifest root.
  const later = [
    { ...installations[0]!, resolvedVersion: "0.2.1", commit: "shop-c2" }, // shop refreshed its lockfile
    { ...installations[1]!, commit: "billing-c1" }, // billing still pins 0.2.0
    { ...installations[2]!, resolvedVersion: "0.2.1", commit: "legacy-c5" }, // legacy moved, CI failed on it
  ];
  const evidence = [
    ev("shop", "shop-c1", "0.2.0", "pass", "2026-11-17T10:00:00.000Z"), // CI on the OLD version: says nothing about 0.2.1
    ev("shop", "shop-c2", "0.2.1", "pass", "2026-11-17T11:00:00.000Z"),
    ev("billing", "billing-c1", "0.2.0", "pass", "2026-11-17T11:00:00.000Z"),
    ev("legacy", "legacy-c5", "0.2.1", "fail", "2026-11-17T11:00:00.000Z"),
    ev("shop", "shop-c3", "0.2.1", "pending", "2026-11-17T12:00:00.000Z"), // still running: not evidence
    ev("billing", "billing-x", "0.2.1", "pass", "2026-11-17T12:00:00.000Z", "packages/other"), // another manifest root
  ];
  const obs = await w.m.observeConsumers(r.id, later, "scan at T1", evidence);
  const o = Object.fromEntries(obs.consumers.map((c) => [c.consumer, c]));
  assert.deepEqual([o.shop!.adoption, o.shop!.verification, o.shop!.verificationRecord!.commit, o.shop!.installation.commit], ["adopted", "verified", "shop-c2", "shop-c2"]);
  assert.match(o.shop!.verificationEvidence!, /passed: ci\.yml run 77 success on shop@shop-c2, which resolved @demo\/core 0\.2\.1/);
  assert.deepEqual([o.billing!.adoption, o.billing!.verification, o.billing!.verificationRecord], ["not-adopted", "unverified", null], "another root's CI is not this manifest's evidence");
  assert.deepEqual([o.legacy!.adoption, o.legacy!.verification], ["adopted", "failed"], "adopted, and its CI failed on the released version");
  assert.equal(obs.facts.registryVerification.length, 1, "release verification is a separate fact, untouched by consumers");
  const again = await w.m.observeConsumers(r.id, [{ ...installations[1]!, resolvedVersion: "0.2.1", commit: "billing-c2" }], "scan at T2", evidence);
  assert.equal(again.consumers.length, 4, "append-only");
  assert.deepEqual([again.consumers.at(-1)!.adoption, again.consumers.at(-1)!.verification], ["adopted", "unverified"], "adoption alone is never verification");
  ReleaseRecord.parse(JSON.parse(readFileSync(w.m.path(r.id), "utf8")));
});

// ───────── crates ─────────

test("crates: yanked versions count as published; allocation goes past them and says why", async () => {
  const w = cargoWorld({ seed: ["0.1.0", "0.1.1"], yanked: ["0.1.1"], coreVersion: "0.1.0" });
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  assert.equal(r.plan.packages[0]!.proposedVersion, "0.1.2");
  assert.deepEqual(r.plan.packages[0]!.registryVersions.yanked, ["0.1.1"]);
  assert.ok(r.plan.decision.some((d) => /Yanked: 0\.1\.1.*never reused/.test(d)));
});

test("crates: a full release — Cargo.toml and Cargo.lock bumped, cargo-built .crate published byte-for-byte, verified", async () => {
  const w = cargoWorld({ appReq: "0.1" });
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  assert.deepEqual(r.plan.releaseCommit.files, ["Cargo.lock", "crates/core/Cargo.toml"]);
  const app = r.plan.dependents.find((d) => d.package === "demo-app")!;
  assert.deepEqual([app.declared, app.resolved, app.accepts], ["0.1", "0.1.0", true]);
  await w.m.approve(r.id, "randy", r.planDigest);
  const done = await w.m.execute(r.id, "randy");
  assert.equal(done.state, "released", JSON.stringify(done.failure));
  const c = done.facts.releaseCommit!;
  assert.match(blob(w.repo.bare, c, "crates/core/Cargo.toml"), /^version = "0\.1\.1"$/m);
  assert.match(blob(w.repo.bare, c, "Cargo.lock"), /name = "demo-core"\nversion = "0\.1\.1"/);
  const art = done.facts.build!.artifacts[0]!;
  assert.equal(art.file, "demo-core-0.1.1.crate");
  assert.equal(w.registry.crates.get("demo-core")!.get("0.1.1")!.cksum, art.integrity, "registry checksum = sha256 of the built .crate");
  assert.equal(art.integrity, art.sha256);
  assert.equal(done.facts.registryVerification[0]!.distTagPointsHere, null, "crates have no dist-tags");
  assert.equal(w.registry.crates.has("demo-app"), false, "the dependent is never published");
});

test("crates: an exact sibling pin is refused alone and rewritten when released together", async () => {
  const w = cargoWorld({ appReq: "=0.1.0", appPublish: true });
  w.registry.seed("demo-app", ["0.1.0"]);
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" }), refused(/demo-app .* declares demo-core "=0\.1\.0", which does not accept 0\.1\.1 → add --package demo-app/));
  const r = await w.m.plan({ packages: ["demo-core", "demo-app"], bump: "patch", requestedBy: "grace" });
  assert.deepEqual(r.plan.releaseCommit.pins, [{ in: "crates/app", dependency: "demo-core", from: "=0.1.0", to: "=0.1.1" }]);
  await w.m.approve(r.id, "randy", r.planDigest);
  const done = await w.m.execute(r.id, "randy");
  assert.equal(done.state, "released", JSON.stringify(done.failure));
  assert.match(blob(w.repo.bare, done.facts.releaseCommit!, "crates/app/Cargo.toml"), /demo-core = \{ version = "=0\.1\.1", path = "\.\.\/core" \}/);
});

test("crates: a workspace-inherited version cannot be released for one crate alone", async () => {
  const w = cargoWorld({ inherit: true, appPublish: true });
  w.registry.seed("demo-app", ["0.1.0"]);
  await assert.rejects(w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" }), refused(/demo-app \(crates\/app\) also inherits \[workspace\.package\] version 0\.1\.0.*--package demo-app/));
  const r = await w.m.plan({ packages: ["demo-core", "demo-app"], bump: "patch", requestedBy: "grace" });
  assert.deepEqual(r.plan.releaseCommit.files, ["Cargo.lock", "Cargo.toml"], "one edit, in [workspace.package]");
  await w.m.approve(r.id, "randy", r.planDigest);
  const done = await w.m.execute(r.id, "randy");
  assert.equal(done.state, "released", JSON.stringify(done.failure));
  assert.match(blob(w.repo.bare, done.facts.releaseCommit!, "Cargo.toml"), /\[workspace\.package\]\nversion = "0\.1\.1"/);
});

test("crates: tests failing is distinguished from packaging failing; recoverable; nothing tagged", async () => {
  const w = cargoWorld();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await w.m.approve(r.id, "randy", r.planDigest);
  w.executor.mode = "tests-fail-once";
  const out = await w.m.execute(r.id, "randy");
  assert.equal(out.state, "prepared");
  assert.match(out.failure!.reason, /the tests failed on the release commit/);
  assert.equal(w.registry.publishes, 0);
  assert.equal((await w.m.execute(r.id, "randy")).state, "released");
});

test("crates: an ambiguous publish response is reconciled against the registry before any retry", async () => {
  const w = cargoWorld();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await w.m.approve(r.id, "randy", r.planDigest);
  w.registry.mode = "lose-response-once"; // the registry stores it, then the answer is lost
  const out = await w.m.execute(r.id, "randy");
  assert.equal(out.state, "released", JSON.stringify(out.failure));
  assert.equal(w.registry.publishes, 1, "published once, not retried blindly");
  assert.ok(out.attempts.some((a) => a.step === "publish" && a.outcome === "already-done" && /registry has the exact artifact/.test(a.detail)));
});

test("crates: a version yanked right after publication is not a verified release", async () => {
  const w = cargoWorld();
  const r = await w.m.plan({ packages: ["demo-core"], bump: "patch", requestedBy: "grace" });
  await w.m.approve(r.id, "randy", r.planDigest);
  const orig = w.registry.publish.bind(w.registry);
  w.registry.publish = async (p: string) => { await orig(p); w.registry.yank("demo-core", "0.1.1"); };
  const out = await w.m.execute(r.id, "randy");
  assert.equal(out.state, "failed");
  assert.match(out.failure!.reason, /yanked.*not a resolution target/);
});
