// Negative cases for consumer verification, each named, and the real unmatched installations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { consumerVerification } from "../src/release/manager.ts";
import type { EvidenceRecord, Installation } from "../src/contracts.ts";

const inst = { project: "shop", root: ".", registry: "npm" as const, name: "@demo/core" };
const ev = (o: Partial<EvidenceRecord> & { commit: string; resolved: Record<string, string> }): EvidenceRecord => ({
  project: "shop", repository: "acme/shop", collectedAt: "2026-11-17T10:00:00.000Z", scanRun: null, passed: true,
  checks: { resolution: "pass", workflows: "pass" }, runs: [{ workflow: "ci.yml", runId: 1, url: "u", status: "completed", conclusion: "success", headSha: o.commit }], ...o,
});
const K = ".|npm:@demo/core";

test("verified: workflows passed on a commit that resolved exactly the released version", () => {
  const r = consumerVerification(inst, "0.2.1", [ev({ commit: "c2", resolved: { [K]: "0.2.1" } })]);
  assert.deepEqual([r.verification, r.record?.commit], ["verified", "c2"]);
});
test("wrong version: CI passed, but on a commit resolving 0.2.0 → unverified for 0.2.1", () => {
  assert.equal(consumerVerification(inst, "0.2.1", [ev({ commit: "c1", resolved: { [K]: "0.2.0" } })]).verification, "unverified");
});
test("newer version: CI passed on 0.2.2 → still unverified for 0.2.1 (adoption of a later version is not verification of this one)", () => {
  assert.equal(consumerVerification(inst, "0.2.1", [ev({ commit: "c3", resolved: { [K]: "0.2.2" } })]).verification, "unverified");
});
test("wrong manifest: evidence for another root of the same project is not evidence for this manifest", () => {
  assert.equal(consumerVerification(inst, "0.2.1", [ev({ commit: "c2", resolved: { "packages/x|npm:@demo/core": "0.2.1" } })]).verification, "unverified");
});
test("wrong project: another project's evidence never counts", () => {
  assert.equal(consumerVerification(inst, "0.2.1", [ev({ project: "billing", commit: "b1", resolved: { [K]: "0.2.1" } })]).verification, "unverified");
});
test("older commit: a failed run on an older commit resolving the version, then a pass on a newer one → verified by the passing record", () => {
  const r = consumerVerification(inst, "0.2.1", [
    ev({ commit: "c2", collectedAt: "2026-11-17T09:00:00.000Z", passed: false, checks: { resolution: "pass", workflows: "fail" }, resolved: { [K]: "0.2.1" } }),
    ev({ commit: "c4", collectedAt: "2026-11-17T11:00:00.000Z", resolved: { [K]: "0.2.1" } }),
  ]);
  assert.deepEqual([r.verification, r.record?.commit], ["verified", "c4"]);
});
test("failed: the only completed evidence for this version failed → failed, with that record", () => {
  const r = consumerVerification(inst, "0.2.1", [ev({ commit: "c2", passed: false, checks: { resolution: "pass", workflows: "fail" }, resolved: { [K]: "0.2.1" } })]);
  assert.deepEqual([r.verification, r.record?.commit], ["failed", "c2"]);
});
test("incomplete workflow: runs still pending → unverified, not passed and not failed", () => {
  const r = consumerVerification(inst, "0.2.1", [ev({ commit: "c2", passed: false, checks: { resolution: "pass", workflows: "pending" }, runs: [], resolved: { [K]: "0.2.1" } })]);
  assert.deepEqual([r.verification, r.record], ["unverified", null]);
  assert.match(r.why, /incomplete/);
});
test("lockfile resolution failed at that commit → not evidence", () => {
  assert.equal(consumerVerification(inst, "0.2.1", [ev({ commit: "c2", passed: false, checks: { resolution: "fail", workflows: "pass" }, resolved: { [K]: "0.2.1" } })]).verification, "unverified");
});
test("no configured CI: no evidence at all → unverified, and the reason says so", () => {
  const r = consumerVerification(inst, "0.2.1", []);
  assert.deepEqual([r.verification, r.record], ["unverified", null]);
  assert.match(r.why, /no CI evidence for shop/);
});

test("real data: the two installations without matching evidence are agent-obstacle's, which has no CI; they stay unverified", () => {
  const installations: Installation[] = JSON.parse(readFileSync(new URL("../data/installations.json", import.meta.url), "utf8")).installations;
  const dir = new URL("../data/evidence/", import.meta.url);
  const evidence: EvidenceRecord[] = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")).records);
  const projects = JSON.parse(readFileSync(new URL("../config/projects.json", import.meta.url), "utf8")).projects;
  const unmatched = installations.filter((i) => i.status !== "local" && i.resolvedVersion && !evidence.some((e) => e.project === i.project && e.resolved[`${i.root}|${i.registry}:${i.name}`] === i.resolvedVersion));
  assert.deepEqual(unmatched.map((i) => `${i.project} ${i.name}@${i.resolvedVersion}`).sort(), ["agent-obstacle @feltdb/core@0.16.0", "agent-obstacle @feltdb/feltkit@0.3.2"]);
  assert.equal(projects.find((p: any) => p.id === "agent-obstacle").verification, undefined, "no verification workflows configured");
  for (const i of unmatched) {
    const r = consumerVerification(i, i.resolvedVersion!, evidence);
    assert.equal(r.verification, "unverified");
    assert.match(r.why, /no CI evidence for agent-obstacle/);
  }
});
