/**
 * Rust scanner: Cargo.toml manifests (including workspace inheritance) resolved
 * against Cargo.lock.
 */
import { parse as parseToml } from "smol-toml";
import type { DependencyKind, DependencySource } from "../contracts.ts";
import { ancestors, dirOf, inScope, joinPath, type RepoFiles, type RootFilter, type ScannedDep, type ScannedRoot } from "./common.ts";

type Table = Record<string, unknown>;
type DepValue = string | Table;

const SECTIONS: [string, DependencyKind][] = [
  ["dependencies", "dependencies"],
  ["dev-dependencies", "devDependencies"],
  ["build-dependencies", "build-dependencies"],
];

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Cargo.lock
// ---------------------------------------------------------------------------

export interface LockPackage {
  name: string;
  version: string;
  source?: string;
  dependencies?: string[];
}

export interface CargoLock {
  packages: LockPackage[];
  /** True when the lockfile contains a local (path) package with this name. */
  hasLocal(name: string): boolean;
  /** Resolve `dep` (real crate name) as used by local crate `consumer`@`consumerVersion`. */
  resolve(consumer: string, consumerVersion: string | null, dep: string): LockPackage | null;
}

export function parseCargoLock(text: string): CargoLock {
  const doc = parseToml(text) as { package?: LockPackage[] };
  const packages = doc.package ?? [];
  const byName = new Map<string, LockPackage[]>();
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  return {
    packages,
    hasLocal: (name) => (byName.get(name) ?? []).some((p) => !p.source),
    resolve(consumer, consumerVersion, dep) {
      const locals = (byName.get(consumer) ?? []).filter((p) => !p.source);
      const self = locals.find((p) => p.version === consumerVersion) ?? locals[0];
      if (!self) return null; // this lockfile does not cover the consumer
      const candidates = byName.get(dep) ?? [];
      if (self.dependencies) {
        // Entries are "name", "name version" or "name version (source)".
        for (const entry of self.dependencies) {
          const [n, v] = entry.split(" ");
          if (n !== dep) continue;
          if (!v) return candidates.length === 1 ? candidates[0]! : null;
          return candidates.find((c) => c.version === v) ?? null;
        }
      }
      return null;
    },
  };
}

/** Cargo workspace membership: `members` globs (supporting `*` per path segment) minus `exclude`. */
export function isWorkspaceMember(memberDir: string, workspaceDir: string, ws: { members?: string[]; exclude?: string[] }): boolean {
  if (memberDir === workspaceDir) return true;
  const rel = workspaceDir === "." ? memberDir : memberDir.startsWith(workspaceDir + "/") ? memberDir.slice(workspaceDir.length + 1) : null;
  if (rel === null) return false;
  const match = (pattern: string) => {
    const re = new RegExp("^" + pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").map((seg) => seg.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join("/") + "$");
    return re.test(rel);
  };
  if ((ws.exclude ?? []).some(match)) return false;
  return (ws.members ?? []).some(match);
}

function lockSource(p: LockPackage): { source: DependencySource; revision: string | null } {
  if (!p.source) return { source: "path", revision: null };
  if (p.source.startsWith("registry+https://github.com/rust-lang/crates.io-index") || p.source === "sparse+https://index.crates.io/")
    return { source: "registry", revision: null };
  if (p.source.startsWith("git+")) return { source: "git", revision: p.source.slice(4) };
  return { source: "other", revision: p.source };
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

interface CargoManifest {
  package?: { name?: string; version?: string | { workspace?: boolean } };
  workspace?: { members?: string[]; exclude?: string[]; dependencies?: Record<string, DepValue>; package?: { version?: string } };
  target?: Record<string, Table>;
  [section: string]: unknown;
}

export interface DeclaredDep {
  key: string;
  name: string;
  kind: DependencyKind;
  optional: boolean;
  declared: string | null;
  source: DependencySource;
  revision: string | null;
  workspaceInherited: boolean;
}

/** Normalise one dependency entry, applying `workspace = true` inheritance. */
export function declaredDep(key: string, value: DepValue, kind: DependencyKind, workspaceDeps: Record<string, DepValue> | undefined): DeclaredDep {
  let entry: Table = typeof value === "string" ? { version: value } : { ...value };
  let inherited = false;
  if (entry.workspace === true) {
    inherited = true;
    const base = workspaceDeps?.[key];
    const baseTable: Table = base === undefined ? {} : typeof base === "string" ? { version: base } : base;
    // Members may add `features` and `optional`; everything else comes from the workspace.
    entry = { ...baseTable, optional: entry.optional ?? false, features: [...((baseTable.features as string[]) ?? []), ...((entry.features as string[]) ?? [])] };
  }
  const name = typeof entry.package === "string" ? entry.package : key;
  let source: DependencySource = "registry";
  let revision: string | null = null;
  if (typeof entry.git === "string") {
    source = "git";
    const ref = entry.rev ?? entry.tag ?? entry.branch;
    revision = `${entry.git}${ref ? `#${String(ref)}` : ""}`;
  } else if (typeof entry.path === "string") {
    source = "path";
    revision = entry.path;
  } else if (typeof entry.registry === "string") {
    source = "other";
    revision = `registry:${entry.registry}`;
  }
  return {
    key,
    name,
    kind,
    optional: entry.optional === true,
    declared: typeof entry.version === "string" ? entry.version : null,
    source,
    revision,
    workspaceInherited: inherited,
  };
}

export function manifestDeps(m: CargoManifest, workspaceDeps: Record<string, DepValue> | undefined): DeclaredDep[] {
  const out: DeclaredDep[] = [];
  const collect = (t: Table) => {
    for (const [section, kind] of SECTIONS) {
      const deps = t[section];
      if (!isTable(deps)) continue;
      for (const [key, value] of Object.entries(deps)) {
        if (typeof value === "string" || isTable(value)) out.push(declaredDep(key, value, kind, workspaceDeps));
      }
    }
  };
  collect(m as Table);
  for (const t of Object.values(m.target ?? {})) if (isTable(t)) collect(t);
  return out;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export async function scanRust(repo: RepoFiles, filter: RootFilter): Promise<ScannedRoot[]> {
  const all = new Set(repo.paths);
  const manifestCache = new Map<string, Promise<CargoManifest | null>>();
  const loadManifest = (file: string) => {
    let m = manifestCache.get(file);
    if (!m) {
      m = repo
        .read(file)
        .then((t) => parseToml(t) as CargoManifest)
        .catch(() => null);
      manifestCache.set(file, m);
    }
    return m;
  };
  const lockCache = new Map<string, Promise<CargoLock>>();
  const loadLock = (file: string) => {
    let l = lockCache.get(file);
    if (!l) {
      l = repo.read(file).then(parseCargoLock);
      lockCache.set(file, l);
    }
    return l;
  };

  const manifests = repo.paths.filter((p) => (p === "Cargo.toml" || p.endsWith("/Cargo.toml")) && inScope(p, filter)).sort();
  const roots: ScannedRoot[] = [];
  for (const manifest of manifests) {
    const dir = dirOf(manifest);
    const m = await loadManifest(manifest);
    if (!m) {
      roots.push({ path: dir, ecosystem: "rust", manifest, lockfile: null, name: null, deps: [], warnings: ["Cargo.toml could not be parsed"] });
      continue;
    }
    if (!m.package?.name) continue; // virtual workspace manifest: declarations only, inherited by members

    // Workspace root: this manifest if it declares [workspace], otherwise the nearest ancestor that does.
    let workspace: CargoManifest | null = m.workspace ? m : null;
    let workspaceDir = workspace ? dir : null;
    if (!workspace) {
      for (const a of ancestors(dir).slice(1)) {
        const candidate = joinPath(a, "Cargo.toml");
        if (!all.has(candidate)) continue;
        const wm = await loadManifest(candidate);
        if (wm?.workspace) {
          // Cargo uses the nearest ancestor workspace; it only applies if this crate is a member.
          if (isWorkspaceMember(dir, a, wm.workspace)) {
            workspace = wm;
            workspaceDir = a;
          }
          break;
        }
      }
    }
    const warnings: string[] = [];
    const lockDir = [workspaceDir, dir].find((d) => d !== null && all.has(joinPath(d, "Cargo.lock"))) ?? null;
    const lockfile = lockDir ? joinPath(lockDir, "Cargo.lock") : null;
    let lock: CargoLock | null = null;
    if (lockfile) {
      try {
        lock = await loadLock(lockfile);
        if (!lock.hasLocal(m.package.name)) {
          warnings.push(`${lockfile} does not include crate ${m.package.name}; resolved versions are unknown`);
          lock = null;
        }
      } catch (e) {
        warnings.push(`${lockfile} could not be parsed: ${(e as Error).message}`);
      }
    } else {
      warnings.push("no Cargo.lock found; resolved versions are unknown");
    }

    const version = typeof m.package.version === "string" ? m.package.version : (workspace?.workspace?.package?.version ?? null);
    const deps: ScannedDep[] = manifestDeps(m, workspace?.workspace?.dependencies).map((d) => {
      const locked = lock?.resolve(m.package!.name!, version, d.name) ?? null;
      const ls = locked ? lockSource(locked) : null;
      return {
        name: d.name,
        registry: "crates",
        kind: d.kind,
        optional: d.optional,
        declared: d.declared,
        resolved: locked?.version ?? null,
        source: d.source !== "registry" ? d.source : (ls?.source ?? "registry"),
        revision: d.revision ?? ls?.revision ?? null,
      };
    });
    roots.push({ path: dir, ecosystem: "rust", manifest, lockfile, name: m.package.name, deps, warnings });
  }
  return roots;
}
