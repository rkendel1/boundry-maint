import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, AllocationError } from "../src/release/version.ts";
import { ReleasePolicy } from "../src/contracts.ts";

const policy = ReleasePolicy.parse({ approvers: ["randy"], allowedBumps: ["patch", "minor", "major", "prerelease", "prepatch", "repository"] });
const err = (f: () => unknown, kind: string) => { try { f(); } catch (e) { assert.ok(e instanceof AllocationError); assert.equal((e as AllocationError).kind, kind); return (e as Error).message; } assert.fail("expected AllocationError"); };

test("patch from the highest version ever published, not by string order", () => {
  const a = allocate("@x/a", { published: ["0.9.0", "0.10.0", "0.2.0"], repositoryVersion: "0.10.0", tags: [] }, "patch", policy);
  assert.equal(a.version, "0.10.1"); // string order would pick 0.9.0
  assert.equal(a.tag, "@x/a@0.10.1");
  assert.ok(a.explanation.some((l) => /highest ever published is 0\.10\.0/.test(l)));
});

test("a lower `latest` dist-tag never causes reuse: base is the highest published, prereleases included", () => {
  assert.equal(allocate("a", { published: ["1.0.0", "1.1.0", "1.2.0-rc.0"], repositoryVersion: "1.1.0", tags: [] }, "prerelease", policy).version, "1.2.0-rc.1");
  assert.equal(allocate("a", { published: ["1.0.0", "1.1.0", "1.2.0-rc.0"], repositoryVersion: "1.1.0", tags: [] }, "patch", policy).version, "1.2.0");
  assert.equal(allocate("a", { published: ["1.0.0"], repositoryVersion: "1.0.0", tags: [] }, "prerelease", policy).version, "1.0.1-rc.0");
});

test("policy: bumps not allowed are refused", () => {
  const strict = ReleasePolicy.parse({ approvers: ["randy"] }); // default excludes major
  err(() => allocate("a", { published: ["1.0.0"], repositoryVersion: "1.0.0", tags: [] }, "major", strict), "policy");
});

test("collisions are refused, never worked around", () => {
  err(() => allocate("a", { published: ["1.0.0", "1.0.1"], repositoryVersion: "1.0.1", tags: ["a@1.0.2"] }, "patch", policy), "collision");
  err(() => allocate("a", { published: ["1.0.0"], repositoryVersion: "1.0.0", tags: ["a@1.0.1"] }, "patch", policy), "collision");
});

test("repository version ahead of the registry is a decision, not a silent rule", () => {
  const m = err(() => allocate("a", { published: ["0.4.0"], repositoryVersion: "0.4.1", tags: [] }, "patch", policy), "decision");
  assert.match(m, /already declares 0\.4\.1/);
  assert.equal(allocate("a", { published: ["0.4.0"], repositoryVersion: "0.4.1", tags: [] }, "repository", policy).version, "0.4.1");
  err(() => allocate("a", { published: ["0.4.1"], repositoryVersion: "0.4.1", tags: [] }, "repository", policy), "decision");
});

test("first release and invalid inputs", () => {
  assert.equal(allocate("a", { published: [], repositoryVersion: "0.1.0", tags: [] }, "repository", policy).version, "0.1.0");
  err(() => allocate("a", { published: [], repositoryVersion: "banana", tags: [] }, "patch", policy), "invalid");
  const a = allocate("a", { published: ["0.0.0-stage", "0.2.0", "not-a-version"], repositoryVersion: "0.2.0", tags: [] }, "patch", policy);
  assert.equal(a.version, "0.2.1");
  assert.ok(a.explanation[0]!.includes("not semver"));
});
