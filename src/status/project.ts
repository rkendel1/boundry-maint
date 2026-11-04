/** Scans configured projects and classifies their managed-package installations. */
import type {
  EvidenceRecord,
  Installation,
  PackageConfig,
  PackageRecord,
  Policies,
  ProjectConfig,
  ProjectRecord,
  SourceError,
  DependencyKind,
} from "../contracts.ts";
import type { GitHub } from "../collectors/github.ts";
import { errorMessage, HttpError } from "../lib/http.ts";
import type { RepoFiles, ScannedDep, ScannedRoot } from "../scanners/common.ts";
import { scanJavaScript } from "../scanners/javascript.ts";
import { scanRust } from "../scanners/rust.ts";
import { githubRepoFiles } from "../scanners/sources.ts";
import { classify } from "../version/compare.ts";
import { cargoReqToRange, parseNpmSpec, satisfies } from "../version/resolve.ts";

export type Discovered = {
  project: string;
  root: string;
  name: string;
  registry: "npm" | "crates";
  kind: DependencyKind;
  declaredVersion: string | null;
  resolvedVersion: string | null;
  source: Installation["source"];
};

/** Where a project's files come from. Production uses GitHub; development may map repos to local checkouts. */
export interface ProjectSource {
  open(project: ProjectConfig): Promise<{ files: RepoFiles; commit: string | null; branch: string | null; warnings: string[] }>;
}

export function githubSource(gh: GitHub): ProjectSource {
  return {
    async open(project) {
      const repo = await gh.repo(project.repository);
      const branch = project.defaultBranch ?? repo.default_branch;
      const commit = await gh.branchHead(project.repository, branch);
      const files = await githubRepoFiles(gh, project.repository, commit);
      return { files, commit, branch, warnings: files.truncated ? ["repository tree was truncated by the GitHub API; some manifests may be missing"] : [] };
    },
  };
}

export const installKey = (root: string, registry: string, name: string) => `${root}|${registry}:${name}`;

const KIND_RANK: Record<DependencyKind, number> = { dependencies: 0, "build-dependencies": 1, optionalDependencies: 2, devDependencies: 3, peerDependencies: 4 };

/** One record per (root, package): the highest-precedence declaration wins, and a resolved version from any declaration is used. */
function collapse(deps: ScannedDep[]): ScannedDep[] {
  const byName = new Map<string, ScannedDep>();
  for (const d of deps) {
    const prev = byName.get(d.name);
    if (!prev) {
      byName.set(d.name, d);
      continue;
    }
    const [win, lose] = KIND_RANK[d.kind] < KIND_RANK[prev.kind] ? [d, prev] : [prev, d];
    byName.set(d.name, { ...win, resolved: win.resolved ?? lose.resolved });
  }
  return [...byName.values()];
}

function requirementRange(registry: "npm" | "crates", declared: string | null): string | null {
  if (!declared) return null;
  return registry === "npm" ? parseNpmSpec(declared).range : cargoReqToRange(declared);
}

export interface ProjectScanResult {
  project: ProjectRecord;
  installations: Installation[];
  discovered: Discovered[];
  evidence: EvidenceRecord | null;
  errors: SourceError[];
}

export async function scanProject(opts: {
  project: ProjectConfig;
  source: ProjectSource;
  github: GitHub | null;
  catalog: PackageConfig[];
  packages: Map<string, PackageRecord>;
  policies: Policies;
  previous: { record: ProjectRecord | undefined; installations: Installation[] };
  evidence: EvidenceRecord[];
  now: string;
  scanRun: string | null;
}): Promise<ProjectScanResult> {
  const { project, now } = opts;
  const base: Omit<ProjectRecord, "scanStatus" | "error" | "commit" | "commitUrl" | "branch" | "roots" | "lastScanned" | "lastSuccessfulScan"> = {
    id: project.id,
    name: project.name,
    repository: project.repository,
    managedPackages: project.managedPackages,
    missingManagedPackages: [],
    catalogPackagesNotManaged: [],
    discoveredDependencyCount: 0,
    warnings: [],
    verification: project.verification ? { workflows: project.verification.workflows, headVerified: null, lastVerifiedCommit: null, lastVerifiedAt: null } : null,
  };

  if (!project.active) {
    return {
      project: { ...base, branch: null, commit: null, commitUrl: null, roots: [], scanStatus: "inactive", error: null, lastScanned: null, lastSuccessfulScan: opts.previous.record?.lastSuccessfulScan ?? null },
      installations: [],
      discovered: [],
      evidence: null,
      errors: [],
    };
  }

  let opened;
  let roots: ScannedRoot[];
  try {
    opened = await opts.source.open(project);
    roots = [];
    const filter = { paths: project.paths, ignorePaths: project.ignorePaths };
    if (project.scan.javascript) roots.push(...(await scanJavaScript(opened.files, filter)));
    if (project.scan.rust) roots.push(...(await scanRust(opened.files, filter)));
  } catch (e) {
    const message = errorMessage(e);
    const inaccessible = e instanceof HttpError && (e.status === 404 || e.status === 403 || e.status === 401);
    const prev = opts.previous.record;
    return {
      project: {
        ...(prev ?? { ...base, branch: null, commit: null, commitUrl: null, roots: [] }),
        ...{ id: project.id, name: project.name, repository: project.repository, managedPackages: project.managedPackages },
        scanStatus: inaccessible ? "inaccessible" : "failed",
        error: inaccessible ? `${message} — the scan token cannot read this repository` : message,
        lastScanned: now,
        lastSuccessfulScan: prev?.lastSuccessfulScan ?? null,
      },
      // Preserve the last successful view of this project, clearly marked stale.
      installations: opts.previous.installations.map((i) => ({ ...i, stale: true })),
      discovered: [],
      evidence: null,
      errors: [{ source: "project", target: `${project.id} (${project.repository})`, message, at: now }],
    };
  }

  const catalogByName = new Map(opts.catalog.map((p) => [`${p.registry}:${p.name}`, p]));
  const managed = new Set(project.managedPackages);
  const installations: Installation[] = [];
  const discovered: Discovered[] = [];
  const seenManaged = new Set<string>();
  const notManaged = new Set<string>();
  const warnings = [...opened.warnings];

  for (const root of roots) {
    for (const w of root.warnings) warnings.push(`${root.manifest}: ${w}`);
    for (const dep of collapse(root.deps)) {
      const cat = catalogByName.get(`${dep.registry}:${dep.name}`);
      if (!cat || !managed.has(cat.id)) {
        if (cat) notManaged.add(cat.id);
        discovered.push({ project: project.id, root: root.path, name: dep.name, registry: dep.registry, kind: dep.kind, declaredVersion: dep.declared, resolvedVersion: dep.resolved, source: dep.source });
        continue;
      }
      seenManaged.add(cat.id);
      const pkg = opts.packages.get(cat.id);
      const range = requirementRange(dep.registry, dep.declared);
      const isLocal = dep.source === "workspace" || dep.source === "path";
      const trackPre = (pkg?.trackPrereleases ?? cat.trackPrereleases) || opts.policies.trackPrereleases;
      const c = isLocal
        ? null
        : dep.source !== "registry"
          ? { status: "unknown" as const, target: pkg?.latestVersion ?? null }
          : classify({
              resolved: dep.resolved,
              latest: pkg?.latestVersion ?? null,
              latestPrerelease: pkg?.latestPrerelease ?? null,
              trackPrereleases: trackPre,
              registryAvailable: pkg?.collection === "ok",
              deprecated: dep.resolved ? (pkg?.deprecatedVersions[dep.resolved] ?? null) : null,
              yanked: dep.resolved ? (pkg?.yankedVersions.includes(dep.resolved) ?? false) : false,
            });
      installations.push({
        project: project.id,
        repository: project.repository,
        commit: opened.commit,
        root: root.path,
        manifest: root.manifest,
        lockfile: root.lockfile,
        ecosystem: root.ecosystem,
        package: cat.id,
        name: dep.name,
        registry: dep.registry,
        kind: dep.kind,
        optional: dep.optional,
        declaredVersion: dep.declared,
        resolvedVersion: dep.resolved,
        source: dep.source,
        sourceRevision: dep.revision,
        latestVersion: pkg?.latestVersion ?? null,
        latestSatisfiesDeclared: isLocal ? null : satisfies(pkg?.latestVersion ?? null, range),
        lockfileInSync: isLocal ? null : satisfies(dep.resolved, range),
        status: c ? c.status : "local",
        verification: { verified: false, commit: null, evidenceAt: null },
        stale: false,
        lastScanned: now,
      });
    }
  }

  // Verification evidence for the scanned commit (Phase 7).
  let evidence: EvidenceRecord | null = null;
  const errors: SourceError[] = [];
  if (project.verification && opened.commit && opts.github) {
    try {
      evidence = await collectEvidence(opts.github, project, opened.commit, installations, warnings, now, opts.scanRun);
    } catch (e) {
      errors.push({ source: "verification", target: project.id, message: errorMessage(e), at: now });
    }
  }
  const allEvidence = evidence ? [...opts.evidence.filter((r) => r.commit !== evidence!.commit), evidence] : opts.evidence;
  for (const inst of installations) {
    if (inst.status === "local" || !inst.resolvedVersion) continue;
    const key = installKey(inst.root, inst.registry, inst.name);
    const match = allEvidence
      .filter((r) => r.passed && r.resolved[key] === inst.resolvedVersion)
      .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
    if (match) inst.verification = { verified: true, commit: match.commit, evidenceAt: match.collectedAt };
  }
  const lastPassed = allEvidence.filter((r) => r.passed).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];

  return {
    project: {
      ...base,
      branch: opened.branch,
      commit: opened.commit,
      commitUrl: opened.commit ? `https://github.com/${project.repository}/commit/${opened.commit}` : null,
      roots: roots.map((r) => ({ path: r.path, ecosystem: r.ecosystem, manifest: r.manifest, lockfile: r.lockfile, name: r.name })),
      scanStatus: "ok",
      error: null,
      lastScanned: now,
      lastSuccessfulScan: now,
      missingManagedPackages: project.managedPackages.filter((id) => !seenManaged.has(id)),
      catalogPackagesNotManaged: [...notManaged].sort(),
      discoveredDependencyCount: discovered.length,
      warnings,
      verification: base.verification
        ? {
            ...base.verification,
            headVerified: evidence ? (evidence.checks.workflows === "pending" ? null : evidence.passed) : null,
            lastVerifiedCommit: lastPassed?.commit ?? null,
            lastVerifiedAt: lastPassed?.collectedAt ?? null,
          }
        : null,
    },
    installations,
    discovered,
    evidence: evidence && evidence.checks.workflows !== "pending" ? evidence : null,
    errors,
  };
}

/**
 * Verification = (1) every managed dependency resolved from the lockfile at this
 * commit, and (2) every configured workflow's latest run on this exact commit
 * concluded "success". Evidence references the commit SHA and the scan run.
 */
async function collectEvidence(
  gh: GitHub,
  project: ProjectConfig,
  commit: string,
  installations: Installation[],
  warnings: string[],
  now: string,
  scanRun: string | null,
): Promise<EvidenceRecord> {
  const runs: EvidenceRecord["runs"] = [];
  let workflows: EvidenceRecord["checks"]["workflows"] = "pass";
  for (const wf of project.verification!.workflows) {
    const list = await gh.workflowRunsForCommit(project.repository, wf, commit);
    const latest = list.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest) {
      if (workflows === "pass") workflows = "pending";
      continue;
    }
    runs.push({ workflow: wf, runId: latest.id, url: latest.html_url, status: latest.status, conclusion: latest.conclusion, headSha: latest.head_sha });
    if (latest.status !== "completed") {
      if (workflows === "pass") workflows = "pending";
    } else if (latest.conclusion !== "success") workflows = "fail";
  }
  const registryInstalls = installations.filter((i) => i.status !== "local");
  const resolutionOk = registryInstalls.every((i) => i.resolvedVersion !== null && i.lockfileInSync !== false) && !warnings.some((w) => /could not be parsed/.test(w));
  const resolved: Record<string, string> = {};
  for (const i of registryInstalls) if (i.resolvedVersion) resolved[installKey(i.root, i.registry, i.name)] = i.resolvedVersion;
  return {
    project: project.id,
    repository: project.repository,
    commit,
    collectedAt: now,
    scanRun,
    passed: resolutionOk && workflows === "pass",
    checks: { resolution: resolutionOk ? "pass" : "fail", workflows },
    runs,
    resolved,
  };
}
