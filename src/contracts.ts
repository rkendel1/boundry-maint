/**
 * Data contracts for Boundry Maintenance.
 *
 * These Zod schemas are the single source of truth for both configuration
 * (curated, hand-edited) and generated artifacts (data/*.json). The JSON Schema
 * files in schemas/ are generated from them with `npm run schemas`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const Registry = z.enum(["npm", "crates"]);
export type Registry = z.infer<typeof Registry>;

export const Ownership = z.enum(["owned", "managed", "upstream"]);
export type Ownership = z.infer<typeof Ownership>;

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase id: a-z 0-9 . _ -");
const RepoSlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repo");
const IsoDate = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Configuration (config/*.json) — curated, authoritative inventory
// ---------------------------------------------------------------------------

export const PackageConfig = z.object({
  id: Id,
  name: z.string().min(1).describe("Name as published in the registry"),
  registry: Registry,
  ownership: Ownership,
  repository: RepoSlug.nullable().describe("GitHub repository holding the source, if known"),
  directory: z.string().optional().describe("Path of the package inside the repository"),
  active: z.boolean().default(true),
  trackPrereleases: z.boolean().default(false),
  description: z.string().optional(),
});
export type PackageConfig = z.infer<typeof PackageConfig>;

export const PackageCatalog = z
  .object({
    $schema: z.string().optional(),
    packages: z.array(PackageConfig),
  })
  .superRefine((cat, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    cat.packages.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["packages", i, "id"], message: `duplicate id ${p.id}` });
      const key = `${p.registry}:${p.name}`;
      if (names.has(key)) ctx.addIssue({ code: "custom", path: ["packages", i, "name"], message: `duplicate package ${key}` });
      ids.add(p.id);
      names.add(key);
    });
  });
export type PackageCatalog = z.infer<typeof PackageCatalog>;

export const ProjectConfig = z.object({
  id: Id,
  name: z.string().min(1),
  repository: RepoSlug,
  defaultBranch: z.string().optional().describe("Branch to scan; defaults to the repository's default branch"),
  active: z.boolean().default(true),
  paths: z
    .array(z.string())
    .optional()
    .describe("Restrict this project to these directories (lets several projects share one repository)"),
  ignorePaths: z.array(z.string()).default([]).describe("Directories to skip, in addition to the built-in ignores"),
  scan: z.object({ javascript: z.boolean().default(true), rust: z.boolean().default(true) }).default({ javascript: true, rust: true }),
  managedPackages: z.array(Id).describe("Package ids (config/packages.json) that appear in the maintenance report"),
  verification: z
    .object({
      workflows: z
        .array(z.string())
        .min(1)
        .describe("GitHub Actions workflow file names (e.g. ci.yml) that must succeed on a commit for it to count as verified"),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const ProjectCatalog = z
  .object({
    $schema: z.string().optional(),
    projects: z.array(ProjectConfig),
  })
  .superRefine((cat, ctx) => {
    const ids = new Set<string>();
    cat.projects.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["projects", i, "id"], message: `duplicate id ${p.id}` });
      ids.add(p.id);
    });
  });
export type ProjectCatalog = z.infer<typeof ProjectCatalog>;

export const Difference = z.enum(["major", "minor", "patch"]);
export type Difference = z.infer<typeof Difference>;

export const Policies = z.object({
  $schema: z.string().optional(),
  trackPrereleases: z.boolean().default(false).describe("Global default; a package's own setting wins when true"),
  requireUpdate: z
    .record(Ownership, z.array(Difference))
    .default({ owned: ["major", "minor", "patch"], managed: ["major", "minor"], upstream: [] })
    .describe("Which differences turn 'update-available' into 'update-required', per package ownership"),
  newReleaseDays: z.number().int().positive().default(7).describe("A release this recent counts as 'new' on the dashboard"),
  history: z
    .object({
      maxSnapshots: z.number().int().positive().default(90),
      releasesPerPackage: z.number().int().positive().default(25),
      closedItemRetentionDays: z.number().int().nonnegative().default(30),
    })
    .default({ maxSnapshots: 90, releasesPerPackage: 25, closedItemRetentionDays: 30 }),
  requestTimeoutMs: z.number().int().positive().default(20000),
});
export type Policies = z.infer<typeof Policies>;

// ---------------------------------------------------------------------------
// Generated artifacts (data/*.json)
// ---------------------------------------------------------------------------

export const SourceError = z.object({
  source: z.enum(["npm", "crates", "github", "project", "verification"]),
  target: z.string(),
  message: z.string(),
  at: IsoDate,
});
export type SourceError = z.infer<typeof SourceError>;

export const VersionInfo = z.object({
  version: z.string(),
  publishedAt: z.string().nullable(),
  deprecated: z.string().nullable().optional(),
  yanked: z.boolean().optional(),
  prerelease: z.boolean(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;

export const GithubRepoInfo = z.object({
  repository: RepoSlug,
  url: z.string(),
  private: z.boolean().nullable(),
  archived: z.boolean().nullable(),
  defaultBranch: z.string().nullable(),
  pushedAt: z.string().nullable(),
  latestRelease: z
    .object({ tag: z.string(), name: z.string().nullable(), publishedAt: z.string().nullable(), url: z.string(), prerelease: z.boolean() })
    .nullable(),
  latestTag: z.string().nullable(),
  fetchedAt: IsoDate,
});
export type GithubRepoInfo = z.infer<typeof GithubRepoInfo>;

export const PackageRecord = z.object({
  id: Id,
  name: z.string(),
  registry: Registry,
  ownership: Ownership,
  repository: RepoSlug.nullable(),
  directory: z.string().nullable(),
  description: z.string().nullable(),
  trackPrereleases: z.boolean(),
  /** Collection outcome for this run. `stale` = registry failed; registry fields carried from the last good scan. */
  collection: z.enum(["ok", "stale", "failed"]),
  error: z.string().nullable(),
  fetchedAt: IsoDate.nullable(),
  registryUrl: z.string(),
  registryRepositoryUrl: z.string().nullable(),
  /** Primary published version: npm `latest` dist-tag / crates.io newest non-yanked stable. */
  latestVersion: z.string().nullable(),
  latestStable: z.string().nullable(),
  latestPrerelease: z.string().nullable(),
  previousVersion: z.string().nullable(),
  publishedAt: z.string().nullable(),
  distTags: z.record(z.string(), z.string()).nullable(),
  deprecated: z.string().nullable().describe("Deprecation message of the latest version (npm)"),
  versionCount: z.number().int(),
  /** Versions that are deprecated (npm) or yanked (crates); used to classify installations. */
  deprecatedVersions: z.record(z.string(), z.string()),
  yankedVersions: z.array(z.string()),
  /** GitHub release information — deliberately separate from registry versions. */
  github: GithubRepoInfo.nullable(),
});
export type PackageRecord = z.infer<typeof PackageRecord>;

export const PackagesFile = z.object({ generatedAt: IsoDate, packages: z.array(PackageRecord) });

export const ReleasesFile = z.object({
  generatedAt: IsoDate,
  releases: z.array(
    z.object({
      package: Id,
      name: z.string(),
      registry: Registry,
      latestVersion: z.string().nullable(),
      versions: z.array(VersionInfo).describe("Newest first, truncated to policies.history.releasesPerPackage"),
    }),
  ),
});

export const DependencyKind = z.enum(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "build-dependencies"]);
export type DependencyKind = z.infer<typeof DependencyKind>;

export const InstallStatus = z.enum([
  "current",
  "patch-behind",
  "minor-behind",
  "major-behind",
  "prerelease",
  "deprecated",
  "yanked",
  "unavailable",
  "unknown",
  /** Extension: satisfied by a path/workspace link inside the same repository, not by a registry install. */
  "local",
]);
export type InstallStatus = z.infer<typeof InstallStatus>;

export const DependencySource = z.enum(["registry", "git", "path", "workspace", "other"]);
export type DependencySource = z.infer<typeof DependencySource>;

export const Installation = z.object({
  project: Id,
  repository: RepoSlug,
  commit: z.string().nullable(),
  root: z.string().describe("Directory of the consuming manifest within the repository ('.' = repo root)"),
  manifest: z.string(),
  lockfile: z.string().nullable(),
  ecosystem: z.enum(["javascript", "rust"]),
  package: Id.nullable().describe("Catalog id when the dependency is a managed package"),
  name: z.string(),
  registry: Registry,
  kind: DependencyKind,
  optional: z.boolean(),
  declaredVersion: z.string().nullable(),
  resolvedVersion: z.string().nullable(),
  source: DependencySource,
  sourceRevision: z.string().nullable().describe("Git revision / path / link target for non-registry sources"),
  latestVersion: z.string().nullable(),
  latestSatisfiesDeclared: z.boolean().nullable().describe("True when updating needs only a lockfile refresh"),
  lockfileInSync: z.boolean().nullable().describe("False when the resolved version does not satisfy the declared requirement (stale lockfile)"),
  status: InstallStatus,
  verification: z.object({ verified: z.boolean(), commit: z.string().nullable(), evidenceAt: z.string().nullable() }),
  stale: z.boolean().describe("Carried from the last successful scan because the repository could not be read this run"),
  lastScanned: IsoDate,
});
export type Installation = z.infer<typeof Installation>;

export const ProjectRecord = z.object({
  id: Id,
  name: z.string(),
  repository: RepoSlug,
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  commitUrl: z.string().nullable(),
  scanStatus: z.enum(["ok", "inaccessible", "failed", "inactive"]),
  error: z.string().nullable(),
  lastScanned: IsoDate.nullable(),
  lastSuccessfulScan: IsoDate.nullable(),
  roots: z.array(z.object({ path: z.string(), ecosystem: z.enum(["javascript", "rust"]), manifest: z.string(), lockfile: z.string().nullable(), name: z.string().nullable() })),
  managedPackages: z.array(Id),
  missingManagedPackages: z.array(Id).describe("Configured as managed but not found in any manifest"),
  catalogPackagesNotManaged: z.array(Id).describe("Catalog packages this project uses that are not listed in its managedPackages (curation hint)"),
  warnings: z.array(z.string()),
  discoveredDependencyCount: z.number().int(),
  verification: z
    .object({ workflows: z.array(z.string()), headVerified: z.boolean().nullable(), lastVerifiedCommit: z.string().nullable(), lastVerifiedAt: z.string().nullable() })
    .nullable(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const ProjectsFile = z.object({ generatedAt: IsoDate, projects: z.array(ProjectRecord) });

export const InstallationsFile = z.object({
  generatedAt: IsoDate,
  installations: z.array(Installation).describe("Managed package installations — the primary report"),
  discovered: z
    .array(
      z.object({
        project: Id,
        root: z.string(),
        name: z.string(),
        registry: Registry,
        kind: DependencyKind,
        declaredVersion: z.string().nullable(),
        resolvedVersion: z.string().nullable(),
        source: DependencySource,
      }),
    )
    .describe("Every other dependency found; not classified against the registry"),
});

export const MaintenanceState = z.enum(["update-available", "update-required", "update-in-progress", "updated-unverified", "updated-verified"]);
export type MaintenanceState = z.infer<typeof MaintenanceState>;

export const MaintenanceItem = z.object({
  key: z.string().describe("project|lockfile-or-root|registry:name — one item per resolution, stable across scans"),
  project: Id,
  root: z.string().describe("Lockfile that resolves the dependency (or the manifest directory when there is none)"),
  roots: z.array(z.string()).describe("Every manifest directory affected by this item"),
  package: Id,
  name: z.string(),
  registry: Registry,
  ownership: Ownership,
  currentVersion: z.string().nullable(),
  targetVersion: z.string().nullable(),
  declaredVersion: z.string().nullable(),
  difference: z.enum(["major", "minor", "patch", "prerelease", "deprecated", "yanked"]).nullable(),
  latestSatisfiesDeclared: z.boolean().nullable(),
  status: MaintenanceState,
  priority: z.number().int().describe("Lower sorts first: 0 deprecation/yank, 1 major, 2 minor, 3 patch, 4 prerelease, 9 resolved"),
  targetPublishedAt: z.string().nullable(),
  openedAt: IsoDate,
  updatedAt: IsoDate,
  closedAt: IsoDate.nullable(),
  lastVerifiedCommit: z.string().nullable(),
  evidence: z.array(z.object({ commit: z.string(), at: z.string(), runs: z.array(z.object({ workflow: z.string(), url: z.string(), conclusion: z.string().nullable() })) })),
  history: z.array(z.object({ at: IsoDate, status: MaintenanceState, version: z.string().nullable(), scanRun: z.string().nullable() })),
});
export type MaintenanceItem = z.infer<typeof MaintenanceItem>;

export const MaintenanceFile = z.object({ generatedAt: IsoDate, items: z.array(MaintenanceItem) });

export const EvidenceRecord = z.object({
  project: Id,
  repository: RepoSlug,
  commit: z.string(),
  collectedAt: IsoDate,
  scanRun: z.string().nullable(),
  passed: z.boolean(),
  checks: z.object({
    resolution: z.enum(["pass", "fail"]).describe("Lockfiles parsed and every managed dependency resolved"),
    workflows: z.enum(["pass", "fail", "pending"]),
  }),
  runs: z.array(z.object({ workflow: z.string(), runId: z.number(), url: z.string(), status: z.string(), conclusion: z.string().nullable(), headSha: z.string() })),
  resolved: z.record(z.string(), z.string()).describe("`root|registry:name` → resolved version at this commit"),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const EvidenceFile = z.object({ project: Id, records: z.array(EvidenceRecord) });

/**
 * Explicit maintenance signals sent by the people/agents doing the work
 * (repository_dispatch `maintenance-started`). Stored append-only in data/events.json.
 */
export const MaintenanceEvent = z.object({
  type: z.literal("maintenance-started"),
  project: Id,
  package: Id,
  targetVersion: z.string().nullable(),
  ref: z.string().nullable().describe("Branch or PR URL where the update is happening"),
  at: IsoDate,
  sender: z.string().nullable(),
});
export type MaintenanceEvent = z.infer<typeof MaintenanceEvent>;
export const EventsFile = z.object({ events: z.array(MaintenanceEvent) });

export const ScanSummary = z.object({
  runId: z.string().nullable(),
  runUrl: z.string().nullable(),
  startedAt: IsoDate,
  finishedAt: IsoDate,
  status: z.enum(["success", "partial", "failed"]),
  trigger: z.string().nullable(),
  configCommit: z.string().nullable(),
  counts: z.object({
    packages: z.number().int(),
    packagesFailed: z.number().int(),
    projects: z.number().int(),
    projectsFailed: z.number().int(),
    installations: z.number().int(),
    maintenanceOpen: z.number().int(),
  }),
  errors: z.array(SourceError),
});
export type ScanSummary = z.infer<typeof ScanSummary>;

export const SnapshotChanges = z.object({
  newReleases: z.array(z.object({ package: Id, from: z.string().nullable(), to: z.string() })),
  versionChanges: z.array(z.object({ project: Id, root: z.string(), name: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
  newDependencies: z.array(z.object({ project: Id, root: z.string(), name: z.string(), version: z.string().nullable() })),
  removedDependencies: z.array(z.object({ project: Id, root: z.string(), name: z.string() })),
  statusChanges: z.array(z.object({ key: z.string(), from: MaintenanceState.nullable(), to: MaintenanceState })),
  newEvidence: z.array(z.object({ project: Id, commit: z.string(), passed: z.boolean() })),
});
export type SnapshotChanges = z.infer<typeof SnapshotChanges>;

/** data/history/<timestamp>.json and data/snapshot.json (latest). */
export const Snapshot = z.object({
  schemaVersion: z.literal(1),
  scan: ScanSummary,
  packages: z.record(Id, z.object({ latestVersion: z.string().nullable(), collection: z.string() })),
  installations: z.array(
    z.object({ project: Id, root: z.string(), name: z.string(), registry: Registry, resolvedVersion: z.string().nullable(), status: InstallStatus, managed: z.boolean() }),
  ),
  maintenance: z.array(z.object({ key: z.string(), status: MaintenanceState, currentVersion: z.string().nullable(), targetVersion: z.string().nullable() })),
  changes: SnapshotChanges,
});
export type Snapshot = z.infer<typeof Snapshot>;
