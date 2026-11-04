import { posix } from "node:path";
import type { DependencyKind, DependencySource, Registry } from "../contracts.ts";

/** A read-only view of one repository at one commit. */
export interface RepoFiles {
  /** Every file path in the repository (POSIX, relative, no leading "./"). */
  paths: string[];
  read(path: string): Promise<string>;
}

export interface ScannedDep {
  name: string;
  registry: Registry;
  kind: DependencyKind;
  optional: boolean;
  declared: string | null;
  resolved: string | null;
  source: DependencySource;
  revision: string | null;
}

export interface ScannedRoot {
  path: string; // directory, "." for repo root
  ecosystem: "javascript" | "rust";
  manifest: string;
  lockfile: string | null;
  name: string | null;
  deps: ScannedDep[];
  /** Problems reading this root (e.g. unparsable lockfile). Resolution is then left null. */
  warnings: string[];
}

/** Directories that never hold installations we own: build output and vendored copies. */
export const BUILTIN_IGNORES = ["node_modules", "target", "vendor", "dist", "build", ".git", ".next", ".turbo", "out", "coverage"];

export interface RootFilter {
  paths?: string[] | undefined;
  ignorePaths?: string[] | undefined;
}

const norm = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");

/** True when `file` belongs to the project slice of the repository. */
export function inScope(file: string, filter: RootFilter): boolean {
  const segments = file.split("/");
  if (segments.slice(0, -1).some((s) => BUILTIN_IGNORES.includes(s))) return false;
  const under = (dir: string) => {
    const d = norm(dir);
    return d === "" || file === d || file.startsWith(d + "/");
  };
  if (filter.ignorePaths?.some(under)) return false;
  if (filter.paths && filter.paths.length > 0 && !filter.paths.some(under)) return false;
  return true;
}

export function dirOf(file: string): string {
  const d = posix.dirname(file);
  return d === "" ? "." : d;
}

export function joinPath(dir: string, file: string): string {
  return dir === "." ? file : `${dir}/${file}`;
}

/** Ancestors of a directory, nearest first, ending with ".". */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (d === ".") break;
    d = dirOf(d);
  }
  return out;
}

/** Directory of `dir` relative to `base` ("" when equal). `base` must be an ancestor. */
export function relativeTo(dir: string, base: string): string {
  if (base === ".") return dir === "." ? "" : dir;
  if (dir === base) return "";
  return dir.slice(base.length + 1);
}
