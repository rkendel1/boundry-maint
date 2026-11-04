/**
 * Correlation engine: connects CI checks to the package and project inventory.
 *
 * Three separate facts are kept separate:
 *   drift        — installation status (newer version available)
 *   enforcement  — a CI check covers the package (with its requirement, if known)
 *   CI failure   — that check's step is failing in GitHub Actions
 * Only a failing, blocking check whose failure is *attributed* to the package
 * (dedicated check step, or the job log names it) elevates a maintenance item.
 */
import semver from "semver";
import type { CiCheck, Installation, MaintenanceItem, PackageRecord, ProjectConfig } from "../contracts.ts";

export function evaluateRequirement(requirement: string, installed: string | null, declared: string | null, latest: string | null): boolean | null {
  if (!installed || !semver.valid(installed)) return null;
  if (requirement === "latest") return latest ? semver.gte(installed, latest) : null;
  if (requirement === "exact") return declared ? installed === declared : null;
  const range = semver.validRange(requirement);
  return range ? semver.satisfies(installed, range, { includePrerelease: true }) : null;
}

/** Attach expectations (Boundry's reading of declared requirements) to checks. */
export function withExpectations(checks: CiCheck[], installations: Installation[], projects: ProjectConfig[], packages: Map<string, PackageRecord>): CiCheck[] {
  return checks.map((c) => {
    if (!c.requirements.length) return { ...c, expectations: [] };
    const projectIds = new Set(projects.filter((p) => p.repository === c.repository).map((p) => p.id));
    const expectations = c.requirements.flatMap((r) =>
      installations
        .filter((i) => projectIds.has(i.project) && i.package === r.package && i.status !== "local")
        .map((i) => ({
          package: r.package,
          requirement: r.requirement,
          enforcement: r.enforcement,
          root: i.root,
          installed: i.resolvedVersion,
          latest: packages.get(r.package)?.latestVersion ?? null,
          holds: evaluateRequirement(r.requirement, i.resolvedVersion, i.declaredVersion, packages.get(r.package)?.latestVersion ?? null),
        })),
    );
    return { ...c, expectations };
  });
}

const OPEN = new Set(["update-available", "update-required", "update-in-progress"]);

/** Link checks to maintenance items; CI-blocking failures move to the top of the queue (priority 0). */
export function correlateItems(items: MaintenanceItem[], checks: CiCheck[], projects: ProjectConfig[]): MaintenanceItem[] {
  const repoOf = new Map(projects.map((p) => [p.id, p.repository]));
  return items.map((item) => {
    const repo = repoOf.get(item.project);
    const related = checks.filter(
      (c) =>
        c.repository === repo &&
        (c.packages.includes(item.package) || c.failure?.packages.includes(item.package) || c.requirements.some((r) => r.package === item.package)),
    );
    if (!related.length) return { ...item, ci: null };
    const blockingFailure = related.some(
      (c) => c.result === "failing" && c.blocking && c.failure?.attribution === "confirmed" && c.failure.packages.includes(item.package),
    );
    const ci = {
      blockingFailure,
      checks: related.map((c) => {
        const req = c.requirements.find((r) => r.package === item.package);
        return {
          id: c.id,
          name: c.name,
          result: c.result,
          enforcement: req ? req.enforcement : ("unknown" as const),
          requirement: req?.requirement ?? null,
          runUrl: c.lastRun?.url ?? null,
        };
      }),
    };
    const elevated = blockingFailure && OPEN.has(item.status);
    return { ...item, ci, priority: elevated ? 0 : item.priority };
  });
}
