import { test } from "node:test";
import assert from "node:assert/strict";
import { bump, classify, sortDesc } from "../src/version/compare.ts";
import { cargoReqToRange, parseNpmSpec, satisfies } from "../src/version/resolve.ts";

const base = { latestPrerelease: null, trackPrereleases: false, registryAvailable: true, deprecated: null, yanked: false };

test("versions are compared semantically, never lexicographically", () => {
  assert.deepEqual(sortDesc(["1.9.0", "1.10.0", "1.2.0", "not-a-version"]), ["1.10.0", "1.9.0", "1.2.0"]);
  assert.equal(classify({ ...base, resolved: "1.9.0", latest: "1.10.0" }).status, "minor-behind");
});

test("patch / minor / major differences", () => {
  assert.equal(classify({ ...base, resolved: "1.4.0", latest: "1.4.1" }).status, "patch-behind");
  assert.equal(classify({ ...base, resolved: "1.4.0", latest: "1.5.0" }).status, "minor-behind");
  assert.equal(classify({ ...base, resolved: "1.4.0", latest: "2.0.0" }).status, "major-behind");
  assert.equal(classify({ ...base, resolved: "0.14.0", latest: "0.15.0" }).status, "minor-behind");
  assert.equal(classify({ ...base, resolved: "1.4.1", latest: "1.4.1" }).status, "current");
  assert.equal(bump("1.2.3-rc.1", "1.2.3"), "patch");
});

test("installed ahead of latest is current, not behind", () => {
  assert.equal(classify({ ...base, resolved: "2.0.0-beta.1", latest: "1.9.0" }).status, "current");
});

test("prerelease policy is respected", () => {
  const input = { ...base, resolved: "1.4.0", latest: "1.4.0", latestPrerelease: "1.5.0-beta.1" };
  assert.equal(classify(input).status, "current");
  const tracked = classify({ ...input, trackPrereleases: true });
  assert.equal(tracked.status, "prerelease");
  assert.equal(tracked.target, "1.5.0-beta.1");
});

test("deprecated and yanked installs outrank version distance", () => {
  assert.equal(classify({ ...base, resolved: "1.0.0", latest: "2.0.0", deprecated: "use 2.x" }).status, "deprecated");
  assert.equal(classify({ ...base, resolved: "1.0.0", latest: "1.0.1", yanked: true }).status, "yanked");
});

test("registry failure is unavailable and unresolvable installs are unknown — never current", () => {
  assert.equal(classify({ ...base, resolved: "1.0.0", latest: "1.0.0", registryAvailable: false }).status, "unavailable");
  assert.equal(classify({ ...base, resolved: null, latest: "1.0.0" }).status, "unknown");
  assert.equal(classify({ ...base, resolved: "github:foo/bar", latest: "1.0.0" }).status, "unknown");
});

test("Cargo requirements follow Cargo semantics", () => {
  const cases: [string, string, boolean][] = [
    ["1", "1.54.1", true],
    ["1", "2.0.0", false],
    ["0.3", "0.3.9", true],
    ["0.3", "0.4.0", false],
    ["0.3.0", "0.3.5", true],
    ["=1.2.3", "1.2.4", false],
    ["~1.2", "1.2.9", true],
    ["~1.2", "1.3.0", false],
    [">=1.2, <1.5", "1.4.0", true],
    [">=1.2, <1.5", "1.5.0", false],
    ["*", "9.9.9", true],
    ["1.*", "1.8.0", true],
  ];
  for (const [req, version, expected] of cases) assert.equal(satisfies(version, cargoReqToRange(req)), expected, `${req} vs ${version}`);
});

test("npm specifiers are classified by source", () => {
  assert.equal(parseNpmSpec("^1.4.0").source, "registry");
  assert.equal(parseNpmSpec("workspace:*").source, "workspace");
  assert.equal(parseNpmSpec("file:../..").source, "path");
  assert.equal(parseNpmSpec("github:rkendel1/appport#main").source, "git");
  assert.equal(parseNpmSpec("rkendel1/appport").source, "git");
  assert.deepEqual(parseNpmSpec("npm:@appport/sdk@^1.4.0").aliasOf, "@appport/sdk");
  assert.equal(parseNpmSpec("latest").range, null);
  assert.equal(satisfies("1.4.1", parseNpmSpec(">=0.13.1 <1.0.0").range), false);
});
