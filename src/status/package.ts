/** Builds package records from registry + GitHub collection, carrying forward last-known data on failure. */
import type { GithubRepoInfo, PackageConfig, PackageRecord, SourceError, VersionInfo } from "../contracts.ts";
import { fetchCrate } from "../collectors/crates.ts";
import type { GitHub } from "../collectors/github.ts";
import { fetchNpmPackage, type RegistryPackage } from "../collectors/npm.ts";
import { errorMessage, mapLimit } from "../lib/http.ts";
import { compare } from "../version/compare.ts";

export interface PackageCollection {
  records: PackageRecord[];
  versions: Map<string, VersionInfo[]>;
  errors: SourceError[];
}

export type RegistryFetcher = (pkg: PackageConfig) => Promise<RegistryPackage>;

export function defaultFetcher(timeoutMs: number): RegistryFetcher {
  return (pkg) => (pkg.registry === "npm" ? fetchNpmPackage(pkg.name, timeoutMs) : fetchCrate(pkg.name, timeoutMs));
}

function registryUrl(pkg: PackageConfig): string {
  return pkg.registry === "npm" ? `https://www.npmjs.com/package/${pkg.name}` : `https://crates.io/crates/${pkg.name}`;
}

export async function collectPackages(opts: {
  packages: PackageConfig[];
  previous: Map<string, PackageRecord>;
  previousVersions: Map<string, VersionInfo[]>;
  fetcher: RegistryFetcher;
  github: GitHub | null;
  now: string;
}): Promise<PackageCollection> {
  const errors: SourceError[] = [];
  const active = opts.packages.filter((p) => p.active);

  // GitHub repository info, once per repository.
  const repos = [...new Set(active.map((p) => p.repository).filter((r): r is string => !!r))];
  const repoInfo = new Map<string, GithubRepoInfo | null>();
  await mapLimit(repos, 4, async (repo) => {
    if (!opts.github) return;
    try {
      repoInfo.set(repo, await opts.github.repoInfo(repo));
    } catch (e) {
      repoInfo.set(repo, null);
      errors.push({ source: "github", target: repo, message: errorMessage(e), at: opts.now });
    }
  });

  const versions = new Map<string, VersionInfo[]>();
  const records = await mapLimit(active, 6, async (pkg): Promise<PackageRecord> => {
    const prev = opts.previous.get(pkg.id);
    const github = pkg.repository ? (repoInfo.get(pkg.repository) ?? (prev?.github?.repository === pkg.repository ? prev.github : null)) : null;
    const base = {
      id: pkg.id,
      name: pkg.name,
      registry: pkg.registry,
      ownership: pkg.ownership,
      repository: pkg.repository,
      directory: pkg.directory ?? null,
      trackPrereleases: pkg.trackPrereleases,
      registryUrl: registryUrl(pkg),
      github,
    };
    try {
      const r = await opts.fetcher(pkg);
      versions.set(pkg.id, r.versions);
      const stable = r.versions.filter((v) => !v.prerelease && !v.yanked).map((v) => v.version);
      const latest = r.latestVersion;
      const previousVersion = latest ? (stable.find((v) => compare(v, latest) < 0) ?? null) : null;
      return {
        ...base,
        description: pkg.description ?? r.description,
        collection: "ok",
        error: null,
        fetchedAt: opts.now,
        registryRepositoryUrl: r.repositoryUrl,
        latestVersion: r.latestVersion,
        latestStable: r.latestStable,
        latestPrerelease: r.latestPrerelease,
        previousVersion,
        publishedAt: r.publishedAt,
        distTags: r.distTags,
        deprecated: r.deprecated,
        versionCount: r.versions.length,
        deprecatedVersions: r.deprecatedVersions,
        yankedVersions: r.yankedVersions,
      };
    } catch (e) {
      const message = errorMessage(e);
      errors.push({ source: pkg.registry, target: pkg.name, message, at: opts.now });
      const prevVersions = opts.previousVersions.get(pkg.id);
      if (prevVersions) versions.set(pkg.id, prevVersions);
      if (prev && prev.collection !== "failed" && prev.registry === pkg.registry && prev.name === pkg.name) {
        // Keep showing what we last knew, clearly marked; comparisons treat it as unavailable.
        return { ...prev, ...base, description: pkg.description ?? prev.description, collection: "stale", error: message };
      }
      return {
        ...base,
        description: pkg.description ?? null,
        collection: "failed",
        error: message,
        fetchedAt: null,
        registryRepositoryUrl: null,
        latestVersion: null,
        latestStable: null,
        latestPrerelease: null,
        previousVersion: null,
        publishedAt: null,
        distTags: null,
        deprecated: null,
        versionCount: 0,
        deprecatedVersions: {},
        yankedVersions: [],
      };
    }
  });
  return { records, versions, errors };
}
