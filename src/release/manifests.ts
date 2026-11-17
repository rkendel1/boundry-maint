/** Deterministic manifest/lockfile edits for a release commit, and dependent discovery. */
import semver from "semver";
import { parse as parseToml } from "smol-toml";

const indentOf = (s: string) => /^\{\n([ \t]+)"/.exec(s)?.[1] ?? "  ";
const withNl = (s: string) => (s.endsWith("\n") ? s : s + "\n");

const DEP_KINDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

/** package.json: set "version" and/or rewrite exact dependency pins, preserving key order and indentation. */
export function editPackageJson(text: string, version: string | null, pins: Record<string, string> = {}): string {
  const doc = JSON.parse(text);
  if (version) doc.version = version;
  for (const [name, to] of Object.entries(pins)) for (const k of DEP_KINDS) if (doc[k]?.[name] !== undefined) doc[k][name] = to;
  return withNl(JSON.stringify(doc, null, indentOf(text)));
}
export const bumpPackageJson = (text: string, version: string) => editPackageJson(text, version);

/** package-lock.json (v2/v3): workspace entry versions and the rewritten pins inside workspace entries. */
export function editPackageLock(text: string, versions: Record<string, string>, pins: Record<string, Record<string, string>> = {}): string {
  const doc = JSON.parse(text);
  for (const [directory, version] of Object.entries(versions)) {
    const key = directory === "." ? "" : directory;
    if (!doc.packages?.[key]) continue; // not a member of this lockfile
    doc.packages[key].version = version;
    if (key === "") doc.version = version;
  }
  for (const [directory, deps] of Object.entries(pins)) {
    const entry = doc.packages?.[directory === "." ? "" : directory];
    if (!entry) continue;
    for (const [name, to] of Object.entries(deps)) for (const k of DEP_KINDS) if (entry[k]?.[name] !== undefined) entry[k][name] = to;
  }
  return withNl(JSON.stringify(doc, null, indentOf(text)));
}
export const bumpPackageLock = (text: string, directory: string, version: string) => editPackageLock(text, { [directory]: version });

/** Cargo.toml: set version in [package] only; Cargo.lock: the local (source-less) entry for the crate. */
export function bumpCargoToml(text: string, version: string): string {
  const m = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m.exec(text);
  if (!m) throw new Error("Cargo.toml has no [package] version (workspace-inherited versions are not supported yet)");
  return text.slice(0, m.index) + m[1] + version + m[3] + text.slice(m.index + m[0].length);
}
export function bumpCargoLock(text: string, crate: string, version: string): string {
  const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\nversion = ")([^"]+)("\\n)(?!source)`, "m");
  if (!re.test(text)) throw new Error(`Cargo.lock has no local entry for ${crate}`);
  return text.replace(re, `$1${version}$3`);
}

export interface Dependent { package: string; where: string; declared: string; effect: string }

/** How each manifest that depends on `name` reacts to `version` (never changed or published by this release). */
export function dependentEffect(holder: string, where: string, declared: string, current: string, version: string): Dependent {
  const exact = semver.valid(declared) !== null;
  let effect: string;
  if (exact) effect = semver.eq(declared, current) ? `pins ${declared} exactly: keeps using ${declared} until it is released with an updated pin` : `pins ${declared}`;
  else if (semver.validRange(declared)) effect = semver.satisfies(version, declared) ? `range ${declared} accepts ${version} on its next install/lockfile refresh` : `range ${declared} does NOT accept ${version}: needs a manifest change`;
  else effect = `declares "${declared}" (workspace/path/other): not resolved from the registry`;
  return { package: holder, where, declared, effect };
}

export function npmDependency(manifestText: string, name: string): string | null {
  try {
    const m = JSON.parse(manifestText);
    for (const k of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) if (m[k]?.[name]) return String(m[k][name]);
  } catch { /* not JSON */ }
  return null;
}
export function cargoDependency(tomlText: string, name: string): string | null {
  try {
    const t: any = parseToml(tomlText);
    for (const k of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      const d = t[k]?.[name];
      if (typeof d === "string") return d;
      if (d && typeof d === "object" && typeof d.version === "string") return d.version;
    }
  } catch { /* invalid */ }
  return null;
}
