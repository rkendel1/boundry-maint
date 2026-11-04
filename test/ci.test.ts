import { test } from "node:test";
import assert from "node:assert/strict";
import type { CiAnnotation, CiCheck, MaintenanceItem } from "../src/contracts.ts";
import type { GitHub, WorkflowJob, WorkflowRun } from "../src/collectors/github.ts";
import { commandsOf, discoverChecks } from "../src/ci/discover.ts";
import { collectRuns, logExcerpt, stepOutcome } from "../src/ci/runs.ts";
import { correlateItems, evaluateRequirement } from "../src/ci/correlate.ts";
import { parseWorkflow } from "../src/ci/workflow.ts";
import { assertionsIn } from "../src/ci/signals.ts";

const catalog = [
  { id: "appport-services", name: "@appport/services" },
  { id: "appport-resolver", name: "@appport/resolver" },
  { id: "appport-resolver-client", name: "@appport/resolver-client" },
  { id: "feltdb-core", name: "@feltdb/core" },
  { id: "tokio", name: "tokio" },
];

const CI_YML = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
      - name: Unit tests
        run: npm test
      - name: Release check
        env:
          RELEASE_CHECK_LATEST: report
        run: npm run test:release
      - name: Advisory freshness
        continue-on-error: true
        run: node scripts/check-fresh.mjs
  rust:
    name: rust \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-14]
    runs-on: \${{ matrix.os }}
    steps:
      - run: cargo test --locked
      - run: cargo build --release
`;

const files: Record<string, string> = {
  ".github/workflows/ci.yml": CI_YML,
  "package.json": JSON.stringify({
    name: "repo",
    scripts: {
      test: "node scripts/chain-versions.mjs check && node --test",
      "test:release": "node scripts/release-check.mjs",
      "release:gate": "node scripts/release-gate.mjs",
    },
  }),
  "scripts/chain-versions.mjs": `import { readFileSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.version !== pkg.version) errors.push(\`package-lock.json version is \${lock.version}; expected \${pkg.version}\`);`,
  "scripts/release-check.mjs": `import { execFileSync } from "node:child_process";
const REPORT = process.env.RELEASE_CHECK_LATEST === "report";
const latest = execFileSync("npm", ["view", "@appport/services", "version"]).toString().trim();
check(entry.version === spec, \`package-lock.json has @appport/services \${entry.version}, the SDK pins \${spec}\`);
if (entry.version !== latest) check(REPORT, \`@feltdb/core is behind npm's latest \${latest}\`);`,
  "scripts/check-fresh.mjs": `const latest = execFileSync("npm", ["view", "tokio", "version"]); // registry query
if (semver.lt(installed, latest)) console.error(\`"tokio" is outdated: latest is \${latest}\`);`,
  "scripts/release-gate.mjs": `// Publication gate
if (!published) blockers.push(\`@appport/services \${v} is not published on npm\`); // npm view @appport/services@\${v}
const x = execFileSync("npm", ["view", name, "dist.integrity"]);`,
  "scripts/scenario-upgrade.ts": `// not a check name, and not referenced: ignored`,
};

const repoFiles = { paths: Object.keys(files), read: async (p: string) => files[p] ?? Promise.reject(new Error(p)) };

async function discover(annotations: CiAnnotation[] = []) {
  return discoverChecks({ repository: "acme/app", commit: "abc", files: repoFiles, catalog, annotations });
}
const byStep = (checks: CiCheck[], step: string) => checks.find((c) => c.step === step || c.name === step);

test("shell text is split into simple commands", () => {
  assert.deepEqual(commandsOf("FOO=1 npm ci && npm test | tee x.log\nnode a.mjs || exit 1"), ["npm ci", "npm test", "tee x.log", "node a.mjs", "exit 1"]);
});

test("discovery finds built-in and script checks, follows npm scripts, and records local-only gates", async () => {
  const { checks, workflows } = await discover();
  assert.equal(workflows.length, 1);

  const install = byStep(checks, "Install")!;
  assert.equal(install.confidence, "identified", "documented built-in behaviour");
  assert.deepEqual(install.types, ["version-consistency"]);
  assert.equal(install.dedicated, false, "npm ci also installs; its failure is not automatically a version failure");
  assert.match(install.condition!, /package-lock\.json must satisfy package\.json/);

  const release = byStep(checks, "Release check")!;
  assert.equal(release.confidence, "partially-understood", "scripts are never fully understood without an annotation");
  assert.ok(release.types.includes("version-freshness"));
  assert.ok(release.types.includes("version-pinning"));
  assert.deepEqual(release.packages, ["appport-services", "feltdb-core"]);
  assert.equal(release.dedicated, true);
  assert.deepEqual(release.modifiers, [{ name: "RELEASE_CHECK_LATEST", value: "report", relaxes: true }]);
  assert.match(release.blockingNote!, /relaxed by RELEASE_CHECK_LATEST=report/);
  assert.ok(release.assertions.some((a) => a.includes("the SDK pins")));
  assert.deepEqual(release.gates, ["pushes to main", "pull requests"]);

  const unit = byStep(checks, "Unit tests")!;
  assert.ok(unit, "a version check hidden inside npm test is found");
  assert.equal(unit.dedicated, false, "the step also runs the test suite");

  const advisory = byStep(checks, "Advisory freshness")!;
  assert.equal(advisory.blocking, false);
  assert.deepEqual(advisory.packages, ["tokio"], "unscoped names are matched only in package-like positions");

  const locked = checks.filter((c) => c.signals.includes("builtin:cargo-locked"));
  assert.equal(locked.length, 1, "cargo --locked is a check; plain cargo build is not");

  const gate = checks.find((c) => c.workflow === null)!;
  assert.equal(gate.name, "release-gate.mjs");
  assert.equal(gate.blocking, false);
  assert.match(gate.note!, /Not run by any workflow; run locally via npm run release:gate/);
  assert.ok(gate.types.includes("publication-validation"));
  assert.equal(checks.some((c) => c.sources.some((s) => s.path.includes("scenario"))), false);
});

test("annotations clarify, ignore, and declare checks — and never set results", async () => {
  const { checks } = await discover([
    {
      match: { repository: "acme/app", workflow: ".github/workflows/ci.yml", job: "test", step: "Release check" },
      name: "Release check (CI mode)",
      requirements: [{ package: "appport-services", requirement: "latest", enforcement: "report" }],
      condition: "pins exact; services latest reported only",
    },
    { match: { repository: "acme/app", step: "Advisory freshness" }, ignore: true },
    { match: { repository: "acme/app", workflow: ".github/workflows/ci.yml", job: "test", step: "Smoke" }, name: "Manual smoke", types: ["integration-validation"] },
  ]);
  const release = checks.find((c) => c.name === "Release check (CI mode)")!;
  assert.equal(release.confidence, "identified");
  assert.equal(release.annotated, true);
  assert.equal(release.result, "unknown", "results only ever come from GitHub");
  assert.deepEqual(release.requirements, [{ package: "appport-services", requirement: "latest", enforcement: "report" }]);
  assert.equal(byStep(checks, "Advisory freshness"), undefined);
  const declared = checks.find((c) => c.name === "Manual smoke")!;
  assert.match(declared.note!, /discovery did not find it/);
});

test("assertion extraction keeps messages, not code", () => {
  const src = `check(Boolean(m) && atLeast("1.0.0", m[2]) && !atLeast(m[1], m[2]), \`\${name}@\${spec} must be a range with a ceiling of at most 1.0.0\`);`;
  assert.deepEqual(assertionsIn(src), ["<name>@<spec> must be a range with a ceiling of at most 1.0.0"]);
});

// ---------------------------------------------------------------------------
// Run collection
// ---------------------------------------------------------------------------

const run = (id: number, conclusion: string | null, status = "completed"): WorkflowRun => ({
  id,
  html_url: `https://github.com/acme/app/actions/runs/${id}`,
  status,
  conclusion,
  head_branch: "main",
  head_sha: `sha${id}`,
  event: "push",
  created_at: `2026-11-0${id}T00:00:00Z`,
  updated_at: `2026-11-0${id}T00:10:00Z`,
  run_attempt: 1,
});
const job = (id: number, name: string, conclusion: string, steps: [string, string][]): WorkflowJob => ({
  id,
  name,
  html_url: `https://github.com/acme/app/actions/runs/1/job/${id}`,
  status: "completed",
  conclusion,
  steps: steps.map(([n, c], i) => ({ name: n, status: "completed", conclusion: c, number: i + 1 })),
});

function fakeGh(runs: WorkflowRun[], jobs: Record<number, WorkflowJob[]>, logs: Record<number, string>, seen: number[] = []): GitHub {
  return {
    workflowRuns: async () => runs,
    runJobs: async (_r: string, id: number) => jobs[id] ?? [],
    jobLog: async (_r: string, id: number) => {
      seen.push(id);
      return logs[id] ?? "";
    },
  } as unknown as GitHub;
}

test("the real feltkit failure: npm ci fails on an unpublished pin; later checks are skipped, not failing", async () => {
  const { checks, workflows } = await discover();
  const result = await collectRuns({
    gh: fakeGh(
      [run(2, "failure"), run(1, "success")],
      {
        2: [
          job(10, "test", "failure", [["Set up job", "success"], ["Install", "failure"], ["Unit tests", "skipped"], ["Release check", "skipped"], ["Advisory freshness", "skipped"]]),
          job(11, "rust ubuntu-latest", "success", [["Run cargo test --locked", "success"]]),
          job(12, "rust macos-14", "success", [["Run cargo test --locked", "success"]]),
        ],
      },
      { 10: "2026-11-04T06:39:53.1Z npm error notarget No matching version found for @appport/resolver-client@0.1.1.\n2026-11-04T06:39:53.7Z ##[error]Process completed with exit code 1." },
    ),
    repository: "acme/app",
    defaultBranch: "main",
    private: false,
    workflows,
    checks,
    catalog,
    runsPerWorkflow: 20,
    collectLogs: "public",
  });
  assert.equal(result.workflows[0]!.result, "failing");
  assert.deepEqual(result.workflows[0]!.failedJobs[0]!.failedSteps, ["Install"]);
  const install = byStep(result.checks, "Install")!;
  assert.equal(install.result, "failing");
  assert.deepEqual(install.failure, {
    attribution: "confirmed",
    packages: ["appport-resolver-client"],
    excerpt: ["npm error notarget No matching version found for @appport/resolver-client@0.1.1."],
  });
  assert.equal(install.lastSuccess?.runId, 1);
  const release = byStep(result.checks, "Release check")!;
  assert.equal(release.result, "skipped");
  assert.equal(release.resultNote, "skipped because an earlier step in the job failed");
  assert.equal(release.failure, null);
  const locked = result.checks.find((c) => c.signals.includes("builtin:cargo-locked"))!;
  assert.equal(locked.result, "passing");
  assert.match(locked.resultNote!, /2 matrix jobs/);
});

test("failure attribution is conservative: no log + non-dedicated step = possible; private logs are not read", async () => {
  const { checks, workflows } = await discover();
  const seen: number[] = [];
  const result = await collectRuns({
    gh: fakeGh(
      [run(3, "failure")],
      { 3: [job(20, "test", "failure", [["Install", "success"], ["Unit tests", "failure"], ["Release check", "failure"]])] },
      { 20: "@appport/services is behind npm's latest 0.15.0" },
      seen,
    ),
    repository: "acme/app",
    defaultBranch: "main",
    private: true,
    workflows,
    checks,
    catalog,
    runsPerWorkflow: 20,
    collectLogs: "public",
  });
  assert.deepEqual(seen, [], "log excerpts of private repositories are not collected under the 'public' policy");
  assert.deepEqual(byStep(result.checks, "Unit tests")!.failure, { attribution: "possible", packages: [], excerpt: [] });
  assert.deepEqual(byStep(result.checks, "Release check")!.failure, { attribution: "confirmed", packages: ["appport-services", "feltdb-core"], excerpt: [] });
});

test("matrix job names and expression step names are matched", () => {
  const wf = parseWorkflow("w.yml", CI_YML);
  const check = { job: "rust", step: "Run cargo test --locked" } as CiCheck;
  const r = stepOutcome(check, wf, [job(1, "rust ubuntu-latest", "failure", [["Run cargo test --locked", "failure"]]), job(2, "rust macos-14", "success", [["Run cargo test --locked", "success"]])]);
  assert.equal(r.result, "failing");
});

test("log excerpts match whole package names only", () => {
  const x = logExcerpt("npm error notarget No matching version found for @appport/resolver-client@0.1.1.", catalog);
  assert.deepEqual(x.packages, ["appport-resolver-client"]);
  assert.deepEqual(logExcerpt("Compiling tokio v1.54.1 — build completed", catalog).packages, [], "no version-failure wording");
});

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

test("requirements are evaluated as Boundry's reading, separately from CI", () => {
  assert.equal(evaluateRequirement("latest", "0.14.0", ">=0.13.1 <1.0.0", "0.15.0"), false);
  assert.equal(evaluateRequirement(">=0.14.0", "0.14.0", null, null), true);
  assert.equal(evaluateRequirement("exact", "0.1.0", "0.1.1", null), false);
  assert.equal(evaluateRequirement("latest", null, null, "1.0.0"), null);
});

const item = (pkg: string, status: MaintenanceItem["status"], priority: number): MaintenanceItem => ({
  key: `feltkit|package-lock.json|npm:${pkg}`,
  project: "feltkit",
  root: "package-lock.json",
  roots: ["packages/sdk"],
  package: pkg,
  name: pkg,
  registry: "npm",
  ownership: "owned",
  currentVersion: "0.1.0",
  targetVersion: "0.2.0",
  declaredVersion: "0.1.1",
  difference: "minor",
  latestSatisfiesDeclared: false,
  status,
  priority,
  ci: null,
  targetPublishedAt: null,
  openedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  lastVerifiedCommit: null,
  evidence: [],
  history: [],
});

test("only an attributed, blocking CI failure elevates an item to the top of the queue", () => {
  const base = { repository: "acme/feltkit", blocking: true, requirements: [], packages: [], lastRun: { url: "https://run" } } as unknown as CiCheck;
  const projects = [{ id: "feltkit", repository: "acme/feltkit" }] as never;
  const confirmed = { ...base, id: "a", name: "Install", result: "failing", failure: { attribution: "confirmed", packages: ["appport-resolver-client"], excerpt: [] } } as CiCheck;
  const possible = { ...base, id: "b", name: "Unit tests", result: "failing", packages: ["appport-services"], failure: { attribution: "possible", packages: ["appport-services"], excerpt: [] } } as CiCheck;
  const reportOnly = {
    ...base,
    id: "c",
    name: "Release check",
    result: "passing",
    packages: ["appport-services"],
    requirements: [{ package: "appport-services", requirement: "latest", enforcement: "report" }],
    failure: null,
  } as unknown as CiCheck;
  const [resolver, services] = correlateItems([item("appport-resolver-client", "update-required", 3), item("appport-services", "update-required", 3)], [confirmed, possible, reportOnly], projects);
  assert.equal(resolver!.priority, 0);
  assert.equal(resolver!.ci!.blockingFailure, true);
  assert.equal(services!.priority, 3, "a possible (unattributed) failure does not elevate");
  assert.equal(services!.ci!.blockingFailure, false);
  assert.deepEqual(
    services!.ci!.checks.map((c) => [c.name, c.result, c.enforcement, c.requirement]),
    [
      ["Unit tests", "failing", "unknown", null],
      ["Release check", "passing", "report", "latest"],
    ],
  );
  const [closed] = correlateItems([item("appport-resolver-client", "updated-unverified", 9)], [confirmed], projects);
  assert.equal(closed!.priority, 9, "closed items are not elevated");
});
