/**
 * Version allocation. Pure and deterministic: same facts + request ⇒ same version and explanation.
 *
 * - Versions are compared with semver, never as strings.
 * - The base is the highest version EVER published (any dist-tag, deprecated or yanked included), so a version
 *   can never be reused even if `latest` points lower.
 * - A version already published, or whose tag already exists, is never chosen; allocation fails instead of
 *   silently picking another number.
 */
import semver from "semver";
import type { ReleaseBump, ReleasePolicy } from "../contracts.ts";

export interface VersionFacts {
  /** Every version the registry has ever served for the package (including prereleases, deprecated, yanked). */
  published: string[];
  /** The version the manifest declares at the source commit. */
  repositoryVersion: string | null;
  /** Tags that already exist in the repository. */
  tags: string[];
  /** Versions the registry marks yanked (crates.io). Still published: never reused. */
  yanked?: string[];
  /** Versions claimed by abandoned releases: possibly real (commit, tag, publication), never reused. */
  reserved?: { version: string; why: string }[];
}
export interface Allocation { version: string; tag: string; explanation: string[] }
export class AllocationError extends Error {
  readonly kind: "policy" | "collision" | "invalid" | "decision";
  constructor(kind: AllocationError["kind"], message: string) { super(message); this.kind = kind; }
}

export const tagFor = (format: string, name: string, version: string) => format.replaceAll("{name}", name).replaceAll("{version}", version);

export function allocate(name: string, facts: VersionFacts, bump: ReleaseBump, policy: ReleasePolicy): Allocation {
  if (!policy.allowedBumps.includes(bump)) throw new AllocationError("policy", `${name}: release policy does not allow a ${bump} release (allowed: ${policy.allowedBumps.join(", ")})`);
  const reserved = (facts.reserved ?? []).filter((x) => semver.valid(x.version));
  const valid = [...new Set([...facts.published, ...reserved.map((x) => x.version)])].filter((v) => semver.valid(v));
  const invalid = facts.published.filter((v) => !semver.valid(v));
  const highest = valid.length ? valid.sort(semver.rcompare)[0] : null;
  const highestStable = valid.filter((v) => !semver.prerelease(v)).sort(semver.rcompare)[0] ?? null;
  const repo = facts.repositoryVersion && semver.valid(facts.repositoryVersion) ? facts.repositoryVersion : null;
  const why: string[] = [];
  if (facts.repositoryVersion && !repo) throw new AllocationError("invalid", `${name}: the manifest version "${facts.repositoryVersion}" is not valid semver`);
  if (invalid.length) why.push(`Ignored ${invalid.length} registry entr${invalid.length === 1 ? "y" : "ies"} that are not semver (${invalid.slice(0, 3).join(", ")}).`);
  why.push(highest ? `The registry has ${valid.length} version${valid.length === 1 ? "" : "s"} of ${name}; the highest ever published is ${highest}${highestStable && highestStable !== highest ? ` (highest stable ${highestStable})` : ""}.` : `${name} has never been published.`);
  if (reserved.length) why.push(`Reserved: ${reserved.map((x) => `${x.version} (${x.why})`).join(", ")}. A version an abandoned release claimed may be partly real, so it counts toward the highest version and is never reused.`);
  if (facts.yanked?.length) why.push(`Yanked: ${facts.yanked.join(", ")}. A yanked version stays published and is never reused, so it counts toward the highest version.`);
  if (repo) why.push(`The manifest at the source commit declares ${repo}.`);

  let version: string;
  if (bump === "repository") {
    if (!repo) throw new AllocationError("invalid", `${name}: no manifest version to release`);
    if (highest && !semver.gt(repo, highest)) throw new AllocationError("decision", `${name}: the manifest declares ${repo}, which is not newer than the published ${highest}. Choose patch, minor or prerelease instead.`);
    version = repo;
    why.push(`Releasing the manifest's version ${repo} as it stands (it is newer than anything published).`);
  } else {
    const base = highest ?? repo ?? "0.0.0";
    if (repo && highest && semver.gt(repo, highest)) {
      throw new AllocationError("decision", `${name}: the manifest already declares ${repo}, newer than the published ${highest}. Either release it as it stands ("repository") or reset the manifest; Boundry will not stack a ${bump} on top of an unpublished version.`);
    }
    const preid = policy.prereleaseId;
    const next = semver.inc(base, bump as semver.ReleaseType, preid);
    if (!next) throw new AllocationError("invalid", `${name}: cannot apply ${bump} to ${base}`);
    version = next;
    const zero = semver.major(base) === 0 && bump !== "prerelease";
    why.push(`${cap(bump)} release from ${base} gives ${version}${zero ? ` (0.x: under semver a ${bump === "patch" ? "patch" : "minor"} bump of a 0.x version is the ${bump === "minor" ? "breaking-change" : "compatible"} channel for consumers using ^0.${semver.minor(base)})` : ""}.`);
    if (bump === "prerelease" && !semver.prerelease(base)) why.push(`A prerelease of a stable base starts the next patch's ${preid} series.`);
  }
  if (valid.some((v) => semver.eq(v, version))) throw new AllocationError("collision", `${name}@${version} is already on the registry; a published version is never reused`);
  const tag = tagFor(policy.tagFormat, name, version);
  if (facts.tags.includes(tag)) throw new AllocationError("collision", `tag ${tag} already exists; tags are never moved or reused`);
  why.push(`Version ${version} is not on the registry and tag ${tag} does not exist.`);
  return { version, tag, explanation: why };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
