/**
 * JavaScript scanner: package.json manifests resolved against package-lock.json /
 * npm-shrinkwrap.json, pnpm-lock.yaml or yarn.lock (classic and Berry).
 */
import YAML from "yaml";
import semver from "semver";
import type { DependencyKind, DependencySource } from "../contracts.ts";
import { parseNpmSpec } from "../version/resolve.ts";
import { ancestors, dirOf, inScope, joinPath, relativeTo, type RepoFiles, type RootFilter, type ScannedDep, type ScannedRoot } from "./common.ts";

const KINDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const satisfies readonly DependencyKind[];
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] as const;

interface Resolution {
  version: string | null;
  source: DependencySource;
  revision: string | null;
}

/** A parsed lockfile able to answer "what did <name> resolve to for the manifest in <dir>?" */
export interface Lock {
  file: string;
  /** False when the lockfile demonstrably does not install the manifest in relDir. */
  covers(relDir: string): boolean;
  resolve(relDir: string, name: string, declared: string): Resolution | null;
}

// ---------------------------------------------------------------------------
// package-lock.json (v1, v2, v3)
// ---------------------------------------------------------------------------

interface NpmLock {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; resolved?: string; link?: boolean; name?: string }>;
  dependencies?: Record<string, { version?: string; resolved?: string }>;
}

function sourceFromResolved(resolved: string | undefined): { source: DependencySource; revision: string | null } {
  if (!resolved) return { source: "registry", revision: null };
  if (/^git(\+|:)|^github:/.test(resolved)) return { source: "git", revision: resolved };
  if (resolved.startsWith("file:")) return { source: "path", revision: resolved };
  return { source: "registry", revision: null };
}

export function parseNpmLock(file: string, text: string): Lock {
  const lock = JSON.parse(text) as NpmLock;
  const packages = lock.packages;
  return {
    file,
    covers: (relDir) => relDir === "" || !packages || relDir in packages,
    resolve(relDir, name) {
      if (packages) {
        // Node resolution: nearest node_modules walking up from the manifest's directory.
        let d = relDir;
        for (;;) {
          const key = d === "" ? `node_modules/${name}` : `${d}/node_modules/${name}`;
          const entry = packages[key];
          if (entry) {
            if (entry.link) {
              const target = entry.resolved ?? "";
              return { version: packages[target]?.version ?? null, source: "workspace", revision: target || null };
            }
            const s = sourceFromResolved(entry.resolved);
            return { version: entry.version ?? null, ...s };
          }
          if (d === "") break;
          const parent = dirOf(d);
          d = parent === "." ? "" : parent;
        }
        return null;
      }
      const entry = lock.dependencies?.[name];
      if (!entry) return null;
      if (entry.version && !semver.valid(entry.version)) return { version: null, ...sourceFromResolved(entry.version) };
      return { version: entry.version ?? null, ...sourceFromResolved(entry.resolved) };
    },
  };
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml (v5.x, v6, v9)
// ---------------------------------------------------------------------------

type PnpmDepValue = string | { specifier?: string; version?: string };
interface PnpmLock {
  lockfileVersion?: string | number;
  importers?: Record<string, Partial<Record<"dependencies" | "devDependencies" | "optionalDependencies", Record<string, PnpmDepValue>>>>;
  dependencies?: Record<string, PnpmDepValue>;
  devDependencies?: Record<string, PnpmDepValue>;
  optionalDependencies?: Record<string, PnpmDepValue>;
}

export function pnpmVersion(raw: string): Resolution {
  const v = raw.replace(/\(.*$/, "").replace(/_.*$/, ""); // strip peer-dependency suffixes
  if (v.startsWith("link:")) return { version: null, source: "workspace", revision: v };
  if (v.startsWith("file:")) return { version: null, source: "path", revision: v };
  if (semver.valid(v)) return { version: v, source: "registry", revision: null };
  // "/@scope/name/1.2.3" (v5) or "name@1.2.3" (aliases, v9)
  const m = v.match(/[/@](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (m && semver.valid(m[1])) return { version: m[1]!, source: "registry", revision: null };
  return { version: null, source: /github|git|\.com\//.test(v) ? "git" : "other", revision: v };
}

export function parsePnpmLock(file: string, text: string): Lock {
  const lock = YAML.parse(text) as PnpmLock;
  const importers = lock.importers ?? { ".": { dependencies: lock.dependencies, devDependencies: lock.devDependencies, optionalDependencies: lock.optionalDependencies } };
  return {
    file,
    covers: (relDir) => (relDir === "" ? "." : relDir) in importers,
    resolve(relDir, name) {
      const importer = importers[relDir === "" ? "." : relDir];
      if (!importer) return null;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        const value = importer[section]?.[name];
        if (value === undefined) continue;
        const raw = typeof value === "string" ? value : value.version;
        return raw ? pnpmVersion(String(raw)) : null;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// yarn.lock (classic v1 and Berry)
// ---------------------------------------------------------------------------

/** Parse classic yarn.lock into descriptor ("name@range") → version. */
export function parseYarnClassic(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      keys = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((k) => k.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const m = line.match(/^\s+version:?\s+"?([^"\s]+)"?/);
    if (m && keys.length) for (const k of keys) out.set(k, m[1]!);
  }
  return out;
}

export function parseYarnLock(file: string, text: string): Lock {
  const isBerry = /^__metadata:/m.test(text);
  const map = new Map<string, string>();
  if (isBerry) {
    const doc = YAML.parse(text) as Record<string, { version?: string }>;
    for (const [keys, entry] of Object.entries(doc)) {
      if (keys === "__metadata" || !entry?.version) continue;
      for (const k of keys.split(/,\s*/)) map.set(k.trim(), String(entry.version));
    }
  } else {
    for (const [k, v] of parseYarnClassic(text)) map.set(k, v);
  }
  return {
    file,
    covers: () => true,
    resolve(_relDir, name, declared) {
      const candidates = [`${name}@${declared}`, `${name}@npm:${declared}`];
      for (const c of candidates) {
        const v = map.get(c);
        if (v === undefined) continue;
        if (c.includes("@workspace:") || v.endsWith("-use.local")) return { version: null, source: "workspace", revision: declared };
        return semver.valid(v) ? { version: v, source: "registry", revision: null } : { version: null, source: "other", revision: v };
      }
      return null;
    },
  };
}

export function parseLock(file: string, text: string): Lock {
  if (file.endsWith("pnpm-lock.yaml")) return parsePnpmLock(file, text);
  if (file.endsWith("yarn.lock")) return parseYarnLock(file, text);
  return parseNpmLock(file, text);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export async function scanJavaScript(repo: RepoFiles, filter: RootFilter): Promise<ScannedRoot[]> {
  const all = new Set(repo.paths);
  const manifests = repo.paths.filter((p) => (p === "package.json" || p.endsWith("/package.json")) && inScope(p, filter)).sort();
  const lockCache = new Map<string, Promise<Lock>>();
  const loadLock = (file: string) => {
    let l = lockCache.get(file);
    if (!l) {
      l = repo.read(file).then((t) => parseLock(file, t));
      lockCache.set(file, l);
    }
    return l;
  };

  const parsed = new Map<string, PackageJson>();
  for (const m of manifests) {
    try {
      parsed.set(m, JSON.parse(await repo.read(m)) as PackageJson);
    } catch {
      /* reported below */
    }
  }

  const roots: ScannedRoot[] = [];
  for (const manifest of manifests) {
    const dir = dirOf(manifest);
    const warnings: string[] = [];
    const pkg = parsed.get(manifest);
    if (!pkg) {
      roots.push({ path: dir, ecosystem: "javascript", manifest, lockfile: null, name: null, deps: [], warnings: ["package.json could not be parsed"] });
      continue;
    }
    let lockfile: string | null = null;
    let lockDir = ".";
    outer: for (const a of ancestors(dir)) {
      for (const name of LOCKFILES) {
        if (all.has(joinPath(a, name))) {
          lockfile = joinPath(a, name);
          lockDir = a;
          break outer;
        }
      }
    }
    let lock: Lock | null = null;
    if (lockfile) {
      try {
        lock = await loadLock(lockfile);
        if (!lock.covers(relativeTo(dir, lockDir))) {
          warnings.push(`${lockfile} does not include this manifest (not a workspace member); resolved versions are unknown`);
          lock = null;
        }
      } catch (e) {
        warnings.push(`${lockfile} could not be parsed: ${(e as Error).message}`);
      }
    } else {
      warnings.push("no lockfile found; resolved versions are unknown");
    }

    const deps: ScannedDep[] = [];
    for (const kind of KINDS) {
      for (const [name, declared] of Object.entries(pkg[kind] ?? {})) {
        const spec = parseNpmSpec(declared);
        const realName = spec.aliasOf ?? name;
        // Without a lockfile that covers this manifest, nothing is inferred: the resolved version stays unknown.
        const resolution: Resolution | null = lock ? lock.resolve(relativeTo(dir, lockDir), name, declared) : null;
        deps.push({
          name: realName,
          registry: "npm",
          kind,
          optional: kind === "optionalDependencies" || (kind === "peerDependencies" && !!pkg.peerDependenciesMeta?.[name]?.optional),
          declared,
          resolved: resolution?.version ?? null,
          source: spec.source !== "registry" ? spec.source : resolution?.source ?? "registry",
          revision: spec.source !== "registry" ? spec.revision : resolution?.revision ?? null,
        });
      }
    }
    roots.push({ path: dir, ecosystem: "javascript", manifest, lockfile, name: pkg.name ?? null, deps, warnings });
  }
  return roots;
}
