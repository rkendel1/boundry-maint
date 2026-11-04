/** RepoFiles implementations: GitHub (production) and a local checkout (development/tests). */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHub } from "../collectors/github.ts";
import type { RepoFiles } from "./common.ts";

const MANIFEST_NAMES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock"]);
export const isManifestLike = (p: string) => MANIFEST_NAMES.has(p.slice(p.lastIndexOf("/") + 1));

export async function githubRepoFiles(gh: GitHub, repo: string, sha: string): Promise<RepoFiles & { truncated: boolean }> {
  const { paths, truncated } = await gh.tree(repo, sha);
  const cache = new Map<string, Promise<string>>();
  return {
    paths: paths.filter(isManifestLike),
    truncated,
    read(path) {
      let p = cache.get(path);
      if (!p) {
        p = gh.raw(repo, path, sha);
        cache.set(path, p);
      }
      return p;
    },
  };
}

/** Files tracked by git in a local checkout. */
export async function localRepoFiles(dir: string): Promise<RepoFiles & { commit: string | null }> {
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", dir, "ls-files"], { maxBuffer: 64 * 1024 * 1024 });
  const commit = await run("git", ["-C", dir, "rev-parse", "HEAD"]).then((r) => r.stdout.trim(), () => null);
  return {
    paths: stdout.split("\n").filter(Boolean).filter(isManifestLike),
    commit,
    read: (path) => readFile(join(dir, path), "utf8"),
  };
}
