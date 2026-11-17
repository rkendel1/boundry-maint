/**
 * What differs between npm and Cargo, and nothing else: manifests, lockfiles, workspaces, requirement syntax,
 * and how a built artifact is identified. Pure functions of file contents; no registry or git access here.
 *
 * Declared requirements (what a manifest asks for) and resolved versions (what a lockfile chose) are kept as
 * separate facts throughout.
 */
import semver from "semver";
import { parse as parseToml } from "smol-toml";
import { editPackageJson, editPackageLock, npmDependency } from "./manifests.ts";

export type EcosystemId = "npm" | "crates";

export interface ManifestFacts {
  name: string | null;
  /** The version as declared, or the workspace version when inherited. */
  version: string | null;
  /** true when the version comes from [workspace.package] (Cargo). */
  inherited: boolean;
  /** Not publishable: npm "private": true, Cargo publish = false. */
  unpublishable: boolean;
}

export interface Ecosystem {
  readonly id: EcosystemId;
  readonly lockfile: string;
  manifestPath(dir: string): string;
  readManifest(text: string, rootText: string | null): ManifestFacts;
  /** The version the lockfile records for this workspace member, or null if the lockfile has no entry. */
  lockedVersion(lockText: string, dir: string, name: string): string | null;
  /** Member directories of the workspace declared by the root manifest (empty when not a workspace). */
  workspacePatterns(rootText: string | null): string[];
  /** The requirement a manifest declares on `dep` (null if none). Workspace-inherited requirements are resolved through the root. */
  requirement(manifestText: string, rootText: string | null, dep: string): string | null;
  /** The version the lockfile resolved for `dep` as used by this member (null if unknown). */
  resolved(lockText: string | null, dep: string, localVersion: string | null): string | null;
  /** semver range equivalent of an ecosystem requirement (Cargo "0.3" means ^0.3). */
  range(requirement: string): string | null;
  isExact(requirement: string): boolean;
  /** The requirement to write when an in-plan sibling's requirement must follow a new version. */
  followRequirement(old: string, version: string): string;
  artifactFile(name: string, version: string): string;
  /** Which package and version a built artifact contains (read from inside it). */
  readArtifactManifest(extract: (inner: string) => Promise<string>, name: string, version: string): Promise<{ name: string; version: string }>;
  /** The Boundry Recipe step that packages this ecosystem's release artifacts. */
  readonly packageStep: string;
  /** Release commit file edits for the planned versions and in-plan requirement changes. */
  editFiles(read: (path: string) => Promise<string | null>, planned: { directory: string; name: string; proposedVersion: string; inherited?: boolean }[], pins: { in: string; dependency: string; from: string; to: string }[]): Promise<Record<string, string>>;
}

// ───────── npm ─────────
export const npm: Ecosystem = {
  id: "npm",
  lockfile: "package-lock.json",
  manifestPath: (d) => (d === "." ? "package.json" : `${d}/package.json`),
  readManifest(text) {
    const m = JSON.parse(text);
    return { name: m.name ?? null, version: m.version ?? null, inherited: false, unpublishable: m.private === true };
  },
  lockedVersion(lockText, dir) {
    const l = JSON.parse(lockText);
    const e = l.packages?.[dir === "." ? "" : dir];
    return e?.version ?? null;
  },
  workspacePatterns(rootText) {
    if (!rootText) return [];
    const r = JSON.parse(rootText);
    return [].concat(r.workspaces?.packages ?? r.workspaces ?? []);
  },
  requirement: (text, _root, dep) => npmDependency(text, dep),
  resolved(lockText, dep) {
    if (!lockText) return null;
    const l = JSON.parse(lockText);
    const e = l.packages?.[`node_modules/${dep}`];
    if (!e) return null;
    if (e.link && typeof e.resolved === "string") return l.packages?.[e.resolved]?.version ?? null; // workspace link → the member's version
    return e.version ?? null;
  },
  range: (req) => (semver.validRange(req) ? req : null),
  isExact: (req) => semver.valid(req) !== null,
  followRequirement: (_old, version) => version,
  artifactFile: (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
  async readArtifactManifest(extract) {
    const m = JSON.parse(await extract("package/package.json"));
    return { name: m.name, version: m.version };
  },
  packageStep: "Package the result.",
  async editFiles(read, planned, pins) {
    const files: Record<string, string> = {};
    const dirs = [...new Set([...planned.map((p) => p.directory), ...pins.map((p) => p.in)])].sort();
    for (const d of dirs) {
      const path = npm.manifestPath(d);
      const text = await read(path);
      if (!text) throw new Error(`${path} not found`);
      const version = planned.find((p) => p.directory === d)?.proposedVersion ?? null;
      const next = editPackageJson(text, version, Object.fromEntries(pins.filter((p) => p.in === d).map((p) => [p.dependency, p.to])));
      if (next !== text) files[path] = next;
    }
    const lock = await read("package-lock.json");
    if (lock) {
      const pinMap: Record<string, Record<string, string>> = {};
      for (const p of pins) (pinMap[p.in] ??= {})[p.dependency] = p.to;
      const next = editPackageLock(lock, Object.fromEntries(planned.map((p) => [p.directory, p.proposedVersion])), pinMap);
      if (next !== lock) files["package-lock.json"] = next;
    }
    return files;
  },
};

// ───────── Cargo ─────────
const toml = (text: string): any => parseToml(text);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Cargo requirement → semver range. "0.3.0" and "^0.3.0" are caret; "=x" exact; "~x" tilde; comma = and. */
export function cargoRange(req: string): string | null {
  const parts = req.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (/^\d/.test(p) ? `^${p}` : p.replace(/^=\s*/, "")));
  const r = parts.join(" ");
  return semver.validRange(r) ? r : null;
}

export const cargo: Ecosystem = {
  id: "crates",
  lockfile: "Cargo.lock",
  manifestPath: (d) => (d === "." ? "Cargo.toml" : `${d}/Cargo.toml`),
  readManifest(text, rootText) {
    const t = toml(text);
    const pkg = t.package ?? {};
    const inherited = typeof pkg.version === "object" && pkg.version?.workspace === true;
    const version = inherited ? (rootText ? toml(rootText).workspace?.package?.version ?? null : null) : (typeof pkg.version === "string" ? pkg.version : pkg.version === undefined ? "0.0.0" : null);
    return { name: pkg.name ?? null, version, inherited, unpublishable: pkg.publish === false || (Array.isArray(pkg.publish) && pkg.publish.length === 0) };
  },
  lockedVersion(lockText, _dir, name) {
    const l = toml(lockText);
    const local = (l.package ?? []).filter((p: any) => p.name === name && !p.source);
    return local.length === 1 ? local[0].version : null;
  },
  workspacePatterns(rootText) {
    if (!rootText) return [];
    return toml(rootText).workspace?.members ?? [];
  },
  requirement(text, rootText, dep) {
    const t = toml(text);
    for (const table of [t.dependencies, t["dev-dependencies"], t["build-dependencies"], ...Object.values(t.target ?? {}).flatMap((x: any) => [x.dependencies, x["dev-dependencies"], x["build-dependencies"]])]) {
      const d = table?.[dep] ?? Object.values(table ?? {}).find((v: any) => v && typeof v === "object" && v.package === dep);
      if (d === undefined) continue;
      if (typeof d === "string") return d;
      if (d.workspace === true) {
        const w = rootText ? toml(rootText).workspace?.dependencies?.[dep] : undefined;
        if (typeof w === "string") return w;
        return typeof w?.version === "string" ? w.version : "*";
      }
      return typeof d.version === "string" ? d.version : "*"; // path-only dependency: any version (the local one)
    }
    return null;
  },
  resolved(lockText, dep, localVersion) {
    if (!lockText) return null;
    const entries = (toml(lockText).package ?? []).filter((p: any) => p.name === dep);
    const local = entries.find((p: any) => !p.source);
    if (local) return local.version;
    return entries.length === 1 ? entries[0].version : localVersion;
  },
  range: cargoRange,
  isExact: (req) => /^=\s*\d/.test(req.trim()) && !req.includes(","),
  followRequirement: (old, version) => (old.trim().startsWith("=") ? `=${version}` : version),
  artifactFile: (name, version) => `${name}-${version}.crate`,
  async readArtifactManifest(extract, name, version) {
    const t = toml(await extract(`${name}-${version}/Cargo.toml`));
    return { name: t.package?.name, version: t.package?.version };
  },
  packageStep: "Package the crates.",
  async editFiles(read, planned, pins) {
    const files: Record<string, string> = {};
    const set = async (path: string, f: (text: string) => string) => {
      const text = files[path] ?? (await read(path));
      if (text === null || text === undefined) throw new Error(`${path} not found`);
      const next = f(text);
      if (next !== text) files[path] = next;
    };
    const inheritedVersions = [...new Set(planned.filter((p) => p.inherited).map((p) => p.proposedVersion))];
    if (inheritedVersions.length > 1) throw new Error(`crates inheriting the workspace version must be released at one version, got ${inheritedVersions.join(", ")}`);
    if (inheritedVersions[0]) await set("Cargo.toml", (t) => setWorkspaceVersion(t, inheritedVersions[0]!));
    for (const p of planned.filter((x) => !x.inherited)) await set(cargo.manifestPath(p.directory), (t) => setPackageVersion(t, p.proposedVersion));
    for (const pin of pins) await set(cargo.manifestPath(pin.in), (t) => setDependencyVersion(t, pin.dependency, pin.from, pin.to));
    const lock = await read("Cargo.lock");
    if (lock) {
      let next = lock;
      for (const p of planned) next = setLockVersion(next, p.name, p.proposedVersion);
      if (next !== lock) files["Cargo.lock"] = next;
    }
    return files;
  },
};

/** Replace `version = "…"` inside one TOML table (bounded by the next table header, so arrays containing "[" are safe). */
function setTableVersion(text: string, header: string, version: string): string {
  const h = new RegExp(`^\\[${escapeRe(header)}\\][ \\t]*$`, "m").exec(text);
  if (!h) throw new Error(`Cargo.toml has no [${header}] table`);
  const start = h.index + h[0].length;
  const next = /^\[/m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  const body = text.slice(start, end);
  const v = /^(version\s*=\s*")([^"]+)(")/m.exec(body);
  if (!v) throw new Error(`[${header}] has no version`);
  return text.slice(0, start) + body.slice(0, v.index) + v[1] + version + v[3] + body.slice(v.index + v[0].length) + text.slice(end);
}
const setPackageVersion = (text: string, version: string) => setTableVersion(text, "package", version);
const setWorkspaceVersion = (text: string, version: string) => setTableVersion(text, "workspace.package", version);
/** Rewrite one dependency's version requirement (inline table or string form), only where it equals `from`. */
function setDependencyVersion(text: string, dep: string, from: string, to: string): string {
  const d = escapeRe(dep), f = escapeRe(from);
  const inline = new RegExp(`(^${d}\\s*=\\s*\\{[^}\\n]*?version\\s*=\\s*")${f}(")`, "m");
  if (inline.test(text)) return text.replace(inline, `$1${to}$2`);
  const plain = new RegExp(`(^${d}\\s*=\\s*")${f}(")`, "m");
  if (plain.test(text)) return text.replace(plain, `$1${to}$2`);
  throw new Error(`cannot find the requirement ${dep} = "${from}" to rewrite`);
}
function setLockVersion(text: string, crate: string, version: string): string {
  const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRe(crate)}"\\nversion = ")([^"]+)("\\n)(?!source)`, "m");
  return re.test(text) ? text.replace(re, `$1${version}$3`) : text;
}

export const ecosystemFor = (registry: string): Ecosystem => (registry === "crates" ? cargo : npm);
