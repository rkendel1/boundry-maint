/**
 * Builds the GitHub Pages site (_site/) from public/ and data/: copies the
 * dashboard, publishes the JSON artifacts, and generates badges and the
 * overview. Everything here is derived; data/ remains the only state.
 */
import { cp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { CiFile, InstallationsFile, MaintenanceFile, PackagesFile, ProjectsFile, Snapshot, type Installation, type PackageRecord } from "../contracts.ts";
import { generateBadges, projectStatus } from "../badges/generate.ts";
import { listFiles, readJson, writeAllAtomic } from "../lib/files.ts";
import type { Policies } from "../contracts.ts";

const BEHIND = new Set(["patch-behind", "minor-behind", "major-behind", "prerelease", "deprecated", "yanked"]);

export function overview(input: {
  packages: PackageRecord[];
  projects: ReturnType<typeof ProjectsFile.parse>["projects"];
  installations: Installation[];
  items: ReturnType<typeof MaintenanceFile.parse>["items"];
  snapshot: Snapshot;
  ci: CiFile | null;
  newReleaseDays: number;
  now: number;
}) {
  const recent = input.now - input.newReleaseDays * 86_400_000;
  const newReleases = input.packages.filter((p) => p.publishedAt && Date.parse(p.publishedAt) >= recent);
  const outdatedProjects = new Set(input.installations.filter((i) => BEHIND.has(i.status)).map((i) => i.project));
  return {
    managedPackages: input.packages.length,
    packagesByOwnership: {
      owned: input.packages.filter((p) => p.ownership === "owned").length,
      managed: input.packages.filter((p) => p.ownership === "managed").length,
      upstream: input.packages.filter((p) => p.ownership === "upstream").length,
    },
    trackedProjects: input.projects.filter((p) => p.scanStatus !== "inactive").length,
    packagesWithNewReleases: newReleases.map((p) => p.id),
    projectsWithOutdatedInstallations: [...outdatedProjects].sort(),
    outstandingMaintenance: input.items.filter((i) => i.status.startsWith("update-")).length,
    awaitingVerification: input.items.filter((i) => i.status === "updated-unverified").length,
    ci: ciOverview(input.ci, input.items),
    lastScan: { status: input.snapshot.scan.status, at: input.snapshot.scan.finishedAt, runUrl: input.snapshot.scan.runUrl, errors: input.snapshot.scan.errors.length },
    lastSuccessfulScan: input.snapshot.scan.status === "failed" ? null : input.snapshot.scan.finishedAt,
    projectStatus: Object.fromEntries(
      input.projects.map((p) => [
        p.id,
        projectStatus(
          p,
          input.installations.filter((i) => i.project === p.id),
          input.items.filter((i) => i.project === p.id),
        ).message,
      ]),
    ),
  };
}

const VERSION_TYPES = new Set(["version-freshness", "version-pinning", "version-consistency", "dependency-compatibility"]);

/** CI enforcement summary: repositories, version checks, and failures attributed to dependencies. */
export function ciOverview(ci: CiFile | null, items: { ci: { blockingFailure: boolean } | null; status: string }[]) {
  if (!ci) return null;
  const inCi = ci.checks.filter((c) => c.workflow !== null);
  return {
    repositories: ci.repositories.length,
    repositoriesUnreadable: ci.repositories.filter((r) => r.status !== "ok").length,
    checks: ci.checks.length,
    checksInCi: inCi.length,
    localOnlyChecks: ci.checks.length - inCi.length,
    passing: inCi.filter((c) => c.result === "passing").length,
    failing: inCi.filter((c) => c.result === "failing").length,
    dependencyFailures: inCi.filter((c) => c.result === "failing" && c.blocking && c.failure?.attribution === "confirmed" && c.types.some((t) => VERSION_TYPES.has(t))).length,
    unattributedFailures: inCi.filter((c) => c.result === "failing" && c.failure?.attribution !== "confirmed").length,
    blockedItems: items.filter((i) => i.ci?.blockingFailure && i.status.startsWith("update-")).length,
    workflowsFailing: ci.workflows.filter((w) => w.result === "failing").length,
    needsReview: ci.checks.filter((c) => c.confidence !== "identified").length,
  };
}

export async function buildSite(opts: { root: string; dataDir: string; outDir: string; policies: Policies }): Promise<{ files: number }> {
  const d = (f: string) => join(opts.dataDir, f);
  await rm(opts.outDir, { recursive: true, force: true });
  await mkdir(opts.outDir, { recursive: true });
  await cp(join(opts.root, "public"), opts.outDir, { recursive: true });
  if (!existsSync(d("snapshot.json"))) {
    // No successful scan yet: publish the dashboard shell, which explains how to produce data.
    await writeAllAtomic({ [join(opts.outDir, ".nojekyll")]: "" });
    return { files: 1 };
  }
  const packages = (await readJson(d("packages.json"), PackagesFile)).packages;
  const projects = (await readJson(d("projects.json"), ProjectsFile)).projects;
  const installations = (await readJson(d("installations.json"), InstallationsFile)).installations;
  const items = (await readJson(d("maintenance.json"), MaintenanceFile)).items;
  const snapshot = await readJson(d("snapshot.json"), Snapshot);
  const ci = existsSync(d("ci.json")) ? await readJson(d("ci.json"), CiFile) : null;

  await cp(opts.dataDir, join(opts.outDir, "data"), { recursive: true });

  const history = [];
  for (const f of (await listFiles(d("history"))).filter((f) => f.endsWith(".json")).sort().reverse()) {
    const s = JSON.parse(await readFile(f, "utf8")) as Snapshot;
    history.push({ file: `data/history/${basename(f)}`, at: s.scan.finishedAt, status: s.scan.status, counts: s.scan.counts, changes: {
      newReleases: s.changes.newReleases.length,
      versionChanges: s.changes.versionChanges.length,
      newDependencies: s.changes.newDependencies.length,
      statusChanges: s.changes.statusChanges.length,
    } });
  }

  const files: Record<string, unknown> = {
    [join(opts.outDir, "data/dashboard.json")]: {
      generatedAt: new Date().toISOString(),
      overview: overview({ packages, projects, installations, items, snapshot, ci, newReleaseDays: opts.policies.newReleaseDays, now: Date.now() }),
    },
    [join(opts.outDir, "data/history/index.json")]: { snapshots: history },
    [join(opts.outDir, ".nojekyll")]: "",
  };
  const badges = generateBadges({ packages, projects, installations, items, ci });
  for (const [name, svg] of Object.entries(badges)) files[join(opts.outDir, "badges", name)] = svg;
  await writeAllAtomic(files);
  return { files: Object.keys(files).length };
}
