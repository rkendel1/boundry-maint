/**
 * The scan pipeline: configuration → collection → scanning → classification →
 * maintenance → JSON artifacts + timestamped snapshot.
 *
 * Nothing is written unless the scan produces a usable result. A scan in which
 * every registry request and every project failed is a failed scan: it exits
 * non-zero and leaves the previous data untouched.
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  EventsFile,
  EvidenceFile,
  InstallationsFile,
  MaintenanceFile,
  PackageCatalog,
  PackagesFile,
  Policies,
  ProjectCatalog,
  ProjectsFile,
  ReleasesFile,
  Snapshot,
  type EvidenceRecord,
  type Installation,
  type PackageRecord,
  type ProjectRecord,
  type ScanSummary,
  type SnapshotChanges,
  type SourceError,
  type VersionInfo,
} from "./contracts.ts";
import { GitHub } from "./collectors/github.ts";
import { listFiles, readJson, readJsonIfValid, writeAllAtomic } from "./lib/files.ts";
import { mapLimit } from "./lib/http.ts";
import { localRepoFiles } from "./scanners/sources.ts";
import { collectPackages, defaultFetcher, type RegistryFetcher } from "./status/package.ts";
import { computeMaintenance } from "./status/maintenance.ts";
import { githubSource, scanProject, type Discovered, type ProjectSource } from "./status/project.ts";

export interface Config {
  packages: PackageCatalog;
  projects: ProjectCatalog;
  policies: Policies;
}

export async function loadConfig(root: string): Promise<Config> {
  const packages = await readJson(join(root, "config/packages.json"), PackageCatalog);
  const projects = await readJson(join(root, "config/projects.json"), ProjectCatalog);
  const policies = await readJson(join(root, "config/policies.json"), Policies);
  const ids = new Set(packages.packages.map((p) => p.id));
  const problems: string[] = [];
  for (const proj of projects.projects)
    for (const id of proj.managedPackages) if (!ids.has(id)) problems.push(`config/projects.json: project ${proj.id} references unknown package id "${id}"`);
  if (problems.length) throw new Error(problems.join("\n"));
  return { packages, projects, policies };
}

export interface ScanOptions {
  root: string;
  dataDir: string;
  githubToken: string | null;
  /** owner/repo → local checkout, for development and tests. */
  localRepos?: Map<string, string>;
  fetcher?: RegistryFetcher;
  github?: GitHub | null;
  now?: string;
  run?: { id: string | null; url: string | null; trigger: string | null; configCommit: string | null };
}

export interface ScanResult {
  summary: ScanSummary;
  written: boolean;
}

function localSource(map: Map<string, string>, fallback: ProjectSource | null): ProjectSource {
  return {
    async open(project) {
      const dir = map.get(project.repository);
      if (!dir) {
        if (fallback) return fallback.open(project);
        throw new Error(`no local checkout mapped for ${project.repository}`);
      }
      const files = await localRepoFiles(dir);
      return { files, commit: files.commit, branch: null, warnings: ["scanned from a local checkout"] };
    },
  };
}

export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  const startedAt = opts.now ?? new Date().toISOString();
  const now = startedAt;
  const config = await loadConfig(opts.root);
  const { policies } = config;
  const data = (f: string) => join(opts.dataDir, f);

  // Prior state (absent on first run).
  const prevPackages = await readJsonIfValid(data("packages.json"), PackagesFile);
  const prevReleases = await readJsonIfValid(data("releases.json"), ReleasesFile);
  const prevProjects = await readJsonIfValid(data("projects.json"), ProjectsFile);
  const prevInstallations = await readJsonIfValid(data("installations.json"), InstallationsFile);
  const prevMaintenance = await readJsonIfValid(data("maintenance.json"), MaintenanceFile);
  const prevSnapshot = await readJsonIfValid(data("snapshot.json"), Snapshot);
  const events = (await readJsonIfValid(data("events.json"), EventsFile))?.events ?? [];

  const github = opts.github !== undefined ? opts.github : new GitHub(opts.githubToken, policies.requestTimeoutMs);
  const scanRun = opts.run?.url ?? opts.run?.id ?? null;

  // 1–4. Registries and GitHub.
  const pkgResult = await collectPackages({
    packages: config.packages.packages,
    previous: new Map((prevPackages?.packages ?? []).map((p) => [p.id, p])),
    previousVersions: new Map((prevReleases?.releases ?? []).map((r) => [r.package, r.versions])),
    fetcher: opts.fetcher ?? defaultFetcher(policies.requestTimeoutMs),
    github,
    now,
  });
  const packages = new Map(pkgResult.records.map((p) => [p.id, p]));
  const errors: SourceError[] = [...pkgResult.errors];

  // 5–7. Projects.
  const ghSource = github ? githubSource(github) : null;
  const source: ProjectSource = opts.localRepos?.size ? localSource(opts.localRepos, ghSource) : ghSource!;
  if (!source) throw new Error("no project source available");
  const evidenceByProject = new Map<string, EvidenceRecord[]>();
  for (const proj of config.projects.projects) {
    const f = await readJsonIfValid(data(`evidence/${proj.id}.json`), EvidenceFile);
    evidenceByProject.set(proj.id, f?.records ?? []);
  }
  const prevProjectById = new Map((prevProjects?.projects ?? []).map((p) => [p.id, p]));
  const results = await mapLimit(config.projects.projects, 3, (project) =>
    scanProject({
      project,
      source,
      github,
      catalog: config.packages.packages,
      packages,
      policies,
      previous: { record: prevProjectById.get(project.id), installations: (prevInstallations?.installations ?? []).filter((i) => i.project === project.id) },
      evidence: evidenceByProject.get(project.id) ?? [],
      now,
      scanRun,
    }),
  );
  const projects: ProjectRecord[] = results.map((r) => r.project);
  const installations: Installation[] = results.flatMap((r) => r.installations);
  const discovered: Discovered[] = results.flatMap((r) => r.discovered);
  const newEvidence: EvidenceRecord[] = [];
  for (const r of results) {
    errors.push(...r.errors);
    if (r.evidence) {
      const list = evidenceByProject.get(r.project.id) ?? [];
      const existing = list.find((e) => e.commit === r.evidence!.commit);
      if (!existing || existing.passed !== r.evidence.passed || existing.checks.workflows !== r.evidence.checks.workflows) newEvidence.push(r.evidence);
      evidenceByProject.set(r.project.id, [...list.filter((e) => e.commit !== r.evidence!.commit), r.evidence]);
    }
  }

  // 8. Maintenance lifecycle.
  const items = computeMaintenance({
    installations,
    previous: prevMaintenance?.items ?? [],
    packages,
    evidence: evidenceByProject,
    events,
    policies,
    now,
    scanRun,
  });

  const packagesFailed = pkgResult.records.filter((p) => p.collection !== "ok").length;
  const activeProjects = projects.filter((p) => p.scanStatus !== "inactive");
  const projectsFailed = activeProjects.filter((p) => p.scanStatus !== "ok").length;
  const nothingWorked =
    (pkgResult.records.length > 0 && packagesFailed === pkgResult.records.length) && (activeProjects.length === 0 || projectsFailed === activeProjects.length);
  const status: ScanSummary["status"] = nothingWorked ? "failed" : errors.length || packagesFailed || projectsFailed ? "partial" : "success";
  const finishedAt = new Date().toISOString();
  const summary: ScanSummary = {
    runId: opts.run?.id ?? null,
    runUrl: opts.run?.url ?? null,
    startedAt,
    finishedAt: finishedAt < startedAt ? startedAt : finishedAt,
    status,
    trigger: opts.run?.trigger ?? null,
    configCommit: opts.run?.configCommit ?? null,
    counts: {
      packages: pkgResult.records.length,
      packagesFailed,
      projects: activeProjects.length,
      projectsFailed,
      installations: installations.length,
      maintenanceOpen: items.filter((i) => i.status.startsWith("update-")).length,
    },
    errors,
  };
  if (status === "failed") return { summary, written: false };

  // 9. Artifacts.
  const releases = pkgResult.records.map((p) => ({
    package: p.id,
    name: p.name,
    registry: p.registry,
    latestVersion: p.latestVersion,
    versions: (pkgResult.versions.get(p.id) ?? ([] as VersionInfo[])).slice(0, policies.history.releasesPerPackage),
  }));
  const snapshot: Snapshot = {
    schemaVersion: 1,
    scan: summary,
    packages: Object.fromEntries(pkgResult.records.map((p) => [p.id, { latestVersion: p.latestVersion, collection: p.collection }])),
    installations: [
      ...installations.map((i) => ({ project: i.project, root: i.root, name: i.name, registry: i.registry, resolvedVersion: i.resolvedVersion, status: i.status, managed: true })),
      ...discovered.map((d) => ({ project: d.project, root: d.root, name: d.name, registry: d.registry, resolvedVersion: d.resolvedVersion, status: "unknown" as const, managed: false })),
    ],
    maintenance: items.map((i) => ({ key: i.key, status: i.status, currentVersion: i.currentVersion, targetVersion: i.targetVersion })),
    changes: diffSnapshots(prevSnapshot, pkgResult.records, installations, discovered, items, newEvidence, new Set(projects.filter((p) => p.scanStatus === "ok").map((p) => p.id))),
  };
  const stamp = now.replace(/[:.]/g, "-");
  const files: Record<string, unknown> = {
    [data("packages.json")]: { generatedAt: now, packages: pkgResult.records },
    [data("releases.json")]: { generatedAt: now, releases },
    [data("projects.json")]: { generatedAt: now, projects },
    [data("installations.json")]: { generatedAt: now, installations, discovered },
    [data("maintenance.json")]: { generatedAt: now, items },
    [data("snapshot.json")]: snapshot,
    [data(`history/${stamp}.json`)]: snapshot,
  };
  for (const [project, records] of evidenceByProject) {
    if (records.length) files[data(`evidence/${project}.json`)] = { project, records: records.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt)) };
  }
  await writeAllAtomic(files);

  // Retention: keep the newest N snapshots.
  const history = (await listFiles(data("history"))).filter((f) => f.endsWith(".json")).sort();
  for (const old of history.slice(0, Math.max(0, history.length - policies.history.maxSnapshots))) await rm(old);
  return { summary, written: true };
}

export function diffSnapshots(
  prev: Snapshot | null,
  packages: PackageRecord[],
  installations: Installation[],
  discovered: Discovered[],
  items: { key: string; status: Snapshot["maintenance"][number]["status"] }[],
  newEvidence: EvidenceRecord[],
  scannedProjects: Set<string>,
): SnapshotChanges {
  const changes: SnapshotChanges = { newReleases: [], versionChanges: [], newDependencies: [], removedDependencies: [], statusChanges: [], newEvidence: [] };
  changes.newEvidence = newEvidence.map((e) => ({ project: e.project, commit: e.commit, passed: e.passed }));
  if (!prev) return changes; // first snapshot: everything is new; nothing to compare against
  for (const p of packages) {
    const before = prev.packages[p.id]?.latestVersion ?? null;
    if (p.collection === "ok" && p.latestVersion && before !== p.latestVersion) changes.newReleases.push({ package: p.id, from: before, to: p.latestVersion });
  }
  const k = (i: { project: string; root: string; registry: string; name: string }) => `${i.project}|${i.root}|${i.registry}:${i.name}`;
  const prevInst = new Map(prev.installations.map((i) => [k(i), i]));
  const current = [
    ...installations.filter((i) => !i.stale).map((i) => ({ ...i, managed: true })),
    ...discovered.map((d) => ({ ...d, managed: false })),
  ];
  const currentKeys = new Set<string>();
  for (const i of current) {
    const key = k(i);
    currentKeys.add(key);
    const before = prevInst.get(key);
    if (!before) changes.newDependencies.push({ project: i.project, root: i.root, name: i.name, version: i.resolvedVersion });
    else if (before.resolvedVersion !== i.resolvedVersion) changes.versionChanges.push({ project: i.project, root: i.root, name: i.name, from: before.resolvedVersion, to: i.resolvedVersion });
  }
  for (const [key, before] of prevInst) {
    if (!currentKeys.has(key) && scannedProjects.has(before.project)) changes.removedDependencies.push({ project: before.project, root: before.root, name: before.name });
  }
  const prevItems = new Map(prev.maintenance.map((m) => [m.key, m.status]));
  for (const item of items) {
    const before = prevItems.get(item.key) ?? null;
    if (before !== item.status) changes.statusChanges.push({ key: item.key, from: before, to: item.status });
  }
  return changes;
}
