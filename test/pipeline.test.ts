/**
 * End-to-end pipeline tests: a real local git repository as the project, a fake
 * registry, and data/ in a temp directory. Covers the maintenance lifecycle,
 * verification evidence, snapshots, and failure preservation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageConfig } from "../src/contracts.ts";
import type { RegistryPackage } from "../src/collectors/npm.ts";
import { parseNpmDoc } from "../src/collectors/npm.ts";
import { parseCratesResponse } from "../src/collectors/crates.ts";
import type { GitHub } from "../src/collectors/github.ts";
import { runScan } from "../src/scan.ts";
import { buildSite } from "../src/reports/generate.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "boundry-"));
  await mkdir(join(root, "config"));
  await mkdir(join(root, "public"));
  await writeFile(join(root, "public/index.html"), "<!doctype html>");
  await writeFile(
    join(root, "config/packages.json"),
    JSON.stringify({
      packages: [
        { id: "appport-sdk", name: "@appport/sdk", registry: "npm", ownership: "owned", repository: "rkendel1/appport" },
        { id: "tokio", name: "tokio", registry: "crates", ownership: "managed", repository: "tokio-rs/tokio" },
      ],
    }),
  );
  await writeFile(
    join(root, "config/projects.json"),
    JSON.stringify({
      projects: [{ id: "demo", name: "Demo", repository: "acme/demo", managedPackages: ["appport-sdk", "tokio"], verification: { workflows: ["ci.yml"] } }],
    }),
  );
  await writeFile(join(root, "config/policies.json"), JSON.stringify({}));

  const project = join(root, "project-checkout");
  await mkdir(join(project, "rust"), { recursive: true });
  git(root, "init", "-q", project);
  return { root, project, data: join(root, "data") };
}

async function writeProject(dir: string, sdk: string, tokio: string) {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { "@appport/sdk": `^${sdk}` } }));
  await writeFile(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "demo" }, "node_modules/@appport/sdk": { version: sdk } } }),
  );
  await writeFile(join(dir, "rust/Cargo.toml"), `[package]\nname = "demo-rs"\nversion = "0.1.0"\n\n[dependencies]\ntokio = "1"\n`);
  await writeFile(
    join(dir, "rust/Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "demo-rs"\nversion = "0.1.0"\ndependencies = ["tokio"]\n\n[[package]]\nname = "tokio"\nversion = "${tokio}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `sdk ${sdk} tokio ${tokio}`);
  return git(dir, "rev-parse", "HEAD");
}

function registry(versions: { sdk: string[]; tokio: string[]; yanked?: string[] }) {
  return async (pkg: PackageConfig): Promise<RegistryPackage> => {
    if (pkg.registry === "npm") {
      const v = versions.sdk;
      return parseNpmDoc(pkg.name, {
        name: pkg.name,
        "dist-tags": { latest: v[v.length - 1]! },
        versions: Object.fromEntries(v.map((x) => [x, {}])),
        time: Object.fromEntries(v.map((x, i) => [x, new Date(Date.UTC(2026, 9, i + 1)).toISOString()])),
      });
    }
    return parseCratesResponse(pkg.name, {
      crate: { name: pkg.name },
      versions: versions.tokio.map((num, i) => ({ num, yanked: versions.yanked?.includes(num) ?? false, created_at: new Date(Date.UTC(2026, 9, i + 1)).toISOString() })),
    });
  };
}

/** Minimal GitHub stand-in: only workflow runs are consulted (repo info is optional). */
function fakeGitHub(runs: Map<string, "success" | "failure" | "pending">): GitHub {
  return {
    repoInfo: async () => {
      throw new Error("offline");
    },
    workflowRunsForCommit: async (_repo: string, wf: string, sha: string) => {
      const r = runs.get(sha);
      if (!r) return [];
      return [{ id: 1, html_url: `https://github.com/acme/demo/actions/runs/1?${wf}`, status: r === "pending" ? "in_progress" : "completed", conclusion: r === "pending" ? null : r, head_sha: sha, run_attempt: 1, created_at: "2026-11-01T00:00:00Z" }];
    },
  } as unknown as GitHub;
}

const readData = async (data: string, f: string) => JSON.parse(await readFile(join(data, f), "utf8"));
const item = async (data: string, name: string) => (await readData(data, "maintenance.json")).items.find((i: { name: string }) => i.name === name);

test("maintenance lifecycle: required → in-progress → updated-unverified → updated-verified", async () => {
  const w = await workspace();
  const runs = new Map<string, "success" | "failure" | "pending">();
  const scan = (now: string, fetcher: ReturnType<typeof registry>) =>
    runScan({ root: w.root, dataDir: w.data, githubToken: null, localRepos: new Map([["acme/demo", w.project]]), fetcher, github: fakeGitHub(runs), now });

  // 1. Installed 1.4.0, registry has 1.4.1 → owned patch → update-required.
  let sha = await writeProject(w.project, "1.4.0", "1.53.1");
  let r = await scan("2026-11-01T00:00:00.000Z", registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1"] }));
  assert.equal(r.summary.status, "partial", "GitHub repo info is unavailable in this test, so the scan is honestly partial");
  assert.equal(r.written, true);
  const inst = (await readData(w.data, "installations.json")).installations.find((i: { name: string }) => i.name === "@appport/sdk");
  assert.equal(inst.declaredVersion, "^1.4.0");
  assert.equal(inst.resolvedVersion, "1.4.0");
  assert.equal(inst.latestVersion, "1.4.1");
  assert.equal(inst.status, "patch-behind");
  assert.equal(inst.latestSatisfiesDeclared, true);
  assert.equal((await item(w.data, "@appport/sdk")).status, "update-required");
  assert.equal(await item(w.data, "tokio"), undefined, "current installs never open items");

  // Managed (not owned) minor updates are required by default policy; patch-only would be "available".
  // 2. A newer tokio appears: managed + minor → required. An explicit start signal moves sdk to in-progress.
  await writeFile(
    join(w.data, "events.json"),
    JSON.stringify({ events: [{ type: "maintenance-started", project: "demo", package: "appport-sdk", targetVersion: "1.4.1", ref: "update-sdk", at: "2026-11-01T12:00:00.000Z", sender: "dev" }] }),
  );
  r = await scan("2026-11-02T00:00:00.000Z", registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1", "1.54.0"] }));
  assert.equal((await item(w.data, "@appport/sdk")).status, "update-in-progress");
  assert.equal((await item(w.data, "tokio")).status, "update-required");

  // 3. The update lands, but CI on that commit failed → updated-unverified (a version match is not verification).
  sha = await writeProject(w.project, "1.4.1", "1.53.1");
  runs.set(sha, "failure");
  await scan("2026-11-03T00:00:00.000Z", registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1", "1.54.0"] }));
  let sdkItem = await item(w.data, "@appport/sdk");
  assert.equal(sdkItem.status, "updated-unverified");
  assert.equal(sdkItem.currentVersion, "1.4.1");
  assert.equal(sdkItem.lastVerifiedCommit, null);

  // 4. CI re-run passes on the same commit → updated-verified, referencing the commit SHA.
  runs.set(sha, "success");
  await scan("2026-11-04T00:00:00.000Z", registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1", "1.54.0"] }));
  sdkItem = await item(w.data, "@appport/sdk");
  assert.equal(sdkItem.status, "updated-verified");
  assert.equal(sdkItem.lastVerifiedCommit, sha);
  assert.equal(sdkItem.evidence.at(-1).commit, sha);
  assert.deepEqual(
    sdkItem.history.map((h: { status: string }) => h.status),
    ["update-required", "update-in-progress", "updated-unverified", "updated-verified"],
  );
  const evidence = await readData(w.data, "evidence/demo.json");
  assert.equal(evidence.records.length, 1, "one evidence record per commit, updated in place (pending runs record nothing)");
  assert.equal(evidence.records.at(-1).passed, true);
  assert.equal(evidence.records.at(-1).resolved["rust|crates:tokio"], "1.53.1");

  // 5. A new release reopens the verified item.
  await scan("2026-11-05T00:00:00.000Z", registry({ sdk: ["1.4.0", "1.4.1", "2.0.0"], tokio: ["1.53.1", "1.54.0"] }));
  sdkItem = await item(w.data, "@appport/sdk");
  assert.equal(sdkItem.status, "update-required");
  assert.equal(sdkItem.difference, "major");
  assert.equal(sdkItem.latestSatisfiesDeclared, false, "a new major needs a manifest change");

  // History: one snapshot per successful scan, with release changes recorded.
  const history = await readdir(join(w.data, "history"));
  assert.equal(history.length, 5);
  const snap = await readData(w.data, "snapshot.json");
  assert.deepEqual(snap.changes.newReleases, [{ package: "appport-sdk", from: "1.4.1", to: "2.0.0" }]);

  // Report: badges and dashboard data are derived from data/.
  const out = join(w.root, "_site");
  await buildSite({ root: w.root, dataDir: w.data, outDir: out, policies: (await import("../src/contracts.ts")).Policies.parse({}) });
  const badge = await readFile(join(out, "badges/demo-status.svg"), "utf8");
  assert.match(badge, /2 updates required/);
  const dash = JSON.parse(await readFile(join(out, "data/dashboard.json"), "utf8"));
  assert.equal(dash.overview.outstandingMaintenance, 2);
});

test("yanked installed crate versions are flagged and never used as a target", async () => {
  const w = await workspace();
  await writeProject(w.project, "1.4.1", "1.54.0");
  await runScan({
    root: w.root,
    dataDir: w.data,
    githubToken: null,
    localRepos: new Map([["acme/demo", w.project]]),
    fetcher: registry({ sdk: ["1.4.1"], tokio: ["1.53.1", "1.54.0"], yanked: ["1.54.0"] }),
    github: null,
    now: "2026-11-01T00:00:00.000Z",
  });
  const tokio = (await readData(w.data, "installations.json")).installations.find((i: { name: string }) => i.name === "tokio");
  assert.equal(tokio.status, "yanked");
  assert.equal(tokio.latestVersion, "1.53.1");
  const it = await item(w.data, "tokio");
  assert.equal(it.priority, 0, "yanked sorts first");
  assert.equal(it.status, "update-required");
});

test("a failed scan writes nothing; a partial scan carries data forward as stale/unavailable", async () => {
  const w = await workspace();
  await writeProject(w.project, "1.4.0", "1.53.1");
  const opts = { root: w.root, dataDir: w.data, githubToken: null, github: null, now: "2026-11-01T00:00:00.000Z" };
  await runScan({ ...opts, localRepos: new Map([["acme/demo", w.project]]), fetcher: registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1"] }) });
  const before = await readFile(join(w.data, "snapshot.json"), "utf8");
  const backup = join(w.root, "data-before");
  await cp(w.data, backup, { recursive: true });

  // Every registry and every project fails → failed, nothing written.
  const failing = async () => {
    throw new Error("registry down");
  };
  const failed = await runScan({ ...opts, now: "2026-11-02T00:00:00.000Z", localRepos: new Map([["acme/demo", join(w.root, "missing")]]), fetcher: failing });
  assert.equal(failed.summary.status, "failed");
  assert.equal(failed.written, false);
  assert.equal(await readFile(join(w.data, "snapshot.json"), "utf8"), before, "last successful snapshot preserved");
  assert.equal((await readdir(join(w.data, "history"))).length, 1);

  // Registry down but project readable → partial; packages stale; installs unavailable (not current).
  const partial = await runScan({ ...opts, now: "2026-11-03T00:00:00.000Z", localRepos: new Map([["acme/demo", w.project]]), fetcher: failing });
  assert.equal(partial.summary.status, "partial");
  const pkgs = (await readData(w.data, "packages.json")).packages;
  assert.equal(pkgs[0].collection, "stale");
  assert.equal(pkgs[0].latestVersion, "1.4.1", "last known registry data retained for display");
  const installs = (await readData(w.data, "installations.json")).installations;
  assert.ok(installs.every((i: { status: string }) => i.status === "unavailable"));
  assert.equal((await item(w.data, "@appport/sdk")).status, "update-required", "open items are kept, not silently closed");

  // Project unreadable but registry fine → installs carried forward as stale; project marked failed.
  await runScan({ ...opts, now: "2026-11-04T00:00:00.000Z", localRepos: new Map([["acme/demo", join(w.root, "missing")]]), fetcher: registry({ sdk: ["1.4.0", "1.4.1"], tokio: ["1.53.1"] }) });
  const proj = (await readData(w.data, "projects.json")).projects[0];
  assert.equal(proj.scanStatus, "failed");
  assert.equal(proj.lastSuccessfulScan, "2026-11-03T00:00:00.000Z");
  const stale = (await readData(w.data, "installations.json")).installations;
  assert.ok(stale.length > 0 && stale.every((i: { stale: boolean }) => i.stale));
});
