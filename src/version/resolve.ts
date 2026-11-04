/** Interpreting declared version requirements for npm and Cargo. */
import semver from "semver";
import type { DependencySource } from "../contracts.ts";

export interface NpmSpec {
  source: DependencySource;
  /** Real package name when the spec is an alias (npm:other@^1). */
  aliasOf: string | null;
  /** semver range when the source is the registry and the spec is a range. */
  range: string | null;
  revision: string | null;
}

/** Classify an npm dependency specifier (the value in package.json). */
export function parseNpmSpec(spec: string): NpmSpec {
  const s = spec.trim();
  if (s.startsWith("workspace:")) return { source: "workspace", aliasOf: null, range: null, revision: s };
  if (s.startsWith("file:") || s.startsWith("link:") || s.startsWith("portal:") || s.startsWith("./") || s.startsWith("../") || s.startsWith("/"))
    return { source: "path", aliasOf: null, range: null, revision: s };
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:.*\.git(#.*)?$)/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s))
    return { source: "git", aliasOf: null, range: null, revision: s };
  if (/^https?:/.test(s)) return { source: "other", aliasOf: null, range: null, revision: s };
  if (s.startsWith("npm:")) {
    const rest = s.slice(4);
    const at = rest.lastIndexOf("@");
    if (at > 0) return { source: "registry", aliasOf: rest.slice(0, at), range: semver.validRange(rest.slice(at + 1)), revision: null };
    return { source: "registry", aliasOf: rest, range: "*", revision: null };
  }
  // Dist-tags such as "latest" are valid specs but not ranges.
  return { source: "registry", aliasOf: null, range: semver.validRange(s), revision: null };
}

/**
 * Convert a Cargo version requirement to a node-semver range.
 * Cargo treats a bare version ("1.2") as a caret requirement and separates
 * comparators with commas. See https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
 */
export function cargoReqToRange(req: string): string | null {
  const parts = req
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p === "*") return "*";
      if (/^[\^~=<>]/.test(p)) {
        // Cargo's "~1" / "~1.2" / "=1.2" match node-semver; strip spaces after the operator.
        return p.replace(/^(\^|~|=|<=|>=|<|>)\s+/, "$1");
      }
      return `^${p}`;
    });
  if (parts.length === 0) return null;
  return semver.validRange(parts.join(" "));
}

export function satisfies(version: string | null, range: string | null): boolean | null {
  if (!version || !range || !semver.valid(version)) return null;
  return semver.satisfies(version, range, { includePrerelease: semver.prerelease(version) !== null });
}

export function maxSatisfying(versions: string[], range: string | null): string | null {
  if (!range) return null;
  return semver.maxSatisfying(versions, range);
}
