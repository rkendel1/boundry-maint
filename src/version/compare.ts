/** Semantic version comparison. Never compares versions as strings. */
import semver from "semver";
import type { InstallStatus } from "../contracts.ts";

export type Bump = "major" | "minor" | "patch" | "prerelease";

export function valid(v: string | null | undefined): string | null {
  return v ? semver.valid(v, { loose: false }) : null;
}

export function isPrerelease(v: string): boolean {
  return (semver.prerelease(v)?.length ?? 0) > 0;
}

export function compare(a: string, b: string): number {
  return semver.compare(a, b);
}

/** Sort newest first; invalid versions are dropped. */
export function sortDesc(versions: Iterable<string>): string[] {
  return [...versions].filter((v) => semver.valid(v)).sort(semver.rcompare);
}

/**
 * Size of the step from `from` to a newer `to`. Pre-release-only steps
 * (e.g. 1.2.0 -> 1.3.0-beta.1) are reported as "prerelease".
 */
export function bump(from: string, to: string): Bump | null {
  if (!semver.gt(to, from)) return null;
  if (isPrerelease(to)) return "prerelease";
  const f = semver.parse(from)!;
  const t = semver.parse(to)!;
  if (t.major !== f.major) return "major";
  if (t.minor !== f.minor) return "minor";
  return "patch"; // includes 1.2.3-rc.1 -> 1.2.3
}

export interface ClassifyInput {
  resolved: string | null;
  /** Latest eligible stable target; null if the registry could not be read. */
  latest: string | null;
  latestPrerelease: string | null;
  trackPrereleases: boolean;
  registryAvailable: boolean;
  deprecated: string | null;
  yanked: boolean;
}

export interface Classification {
  status: Exclude<InstallStatus, "local">;
  target: string | null;
  bump: Bump | null;
}

export function classify(i: ClassifyInput): Classification {
  if (!i.registryAvailable) return { status: "unavailable", target: null, bump: null };
  const resolved = valid(i.resolved);
  if (!resolved) return { status: "unknown", target: i.latest, bump: null };
  // Problems with the installed version itself outrank how far behind it is.
  if (i.yanked) return { status: "yanked", target: i.latest, bump: i.latest ? bump(resolved, i.latest) : null };
  if (i.deprecated) return { status: "deprecated", target: i.latest, bump: i.latest ? bump(resolved, i.latest) : null };
  if (!i.latest) return { status: "unavailable", target: null, bump: null };

  const stableStep = bump(resolved, i.latest);
  if (stableStep && stableStep !== "prerelease") {
    return { status: `${stableStep}-behind`, target: i.latest, bump: stableStep };
  }
  if (i.trackPrereleases && i.latestPrerelease && semver.gt(i.latestPrerelease, resolved) && semver.gt(i.latestPrerelease, i.latest)) {
    return { status: "prerelease", target: i.latestPrerelease, bump: "prerelease" };
  }
  // Equal to, or ahead of, the latest eligible version (e.g. installed a newer prerelease).
  return { status: "current", target: i.latest, bump: null };
}
