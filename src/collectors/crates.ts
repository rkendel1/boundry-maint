/**
 * crates.io adapter. https://crates.io/data-access — requests must carry an
 * identifying User-Agent and should stay at or below one request per second.
 */
import { getJson } from "../lib/http.ts";
import { isPrerelease, sortDesc } from "../version/compare.ts";
import type { RegistryPackage } from "./npm.ts";

interface CratesResponse {
  crate: { name: string; description?: string | null; repository?: string | null; max_version?: string };
  versions: { num: string; yanked: boolean; created_at: string }[];
}

// Serialise all crates.io requests through one queue, spaced one second apart.
let queue: Promise<void> = Promise.resolve();
function politeDelay(): Promise<void> {
  const slot = queue.then(() => new Promise<void>((r) => setTimeout(r, 1000)));
  queue = slot;
  return queue;
}

export function parseCratesResponse(name: string, body: CratesResponse): RegistryPackage {
  const byNum = new Map(body.versions.map((v) => [v.num, v]));
  const all = sortDesc(byNum.keys());
  const yanked = all.filter((v) => byNum.get(v)!.yanked);
  const eligible = all.filter((v) => !byNum.get(v)!.yanked);
  // A yanked version is never a valid update target.
  const latestStable = eligible.find((v) => !isPrerelease(v)) ?? null;
  const newestPre = eligible.find((v) => isPrerelease(v)) ?? null;
  const latestPrerelease = newestPre && (!latestStable || sortDesc([newestPre, latestStable])[0] === newestPre) ? newestPre : null;
  const latest = latestStable;
  return {
    latestVersion: latest,
    latestStable,
    latestPrerelease,
    publishedAt: latest ? byNum.get(latest)!.created_at : null,
    distTags: null,
    deprecated: null,
    description: body.crate.description ?? null,
    repositoryUrl: body.crate.repository?.replace(/\.git$/, "") ?? null,
    registryUrl: `https://crates.io/crates/${name}`,
    versions: all.map((v) => ({ version: v, publishedAt: byNum.get(v)!.created_at, yanked: byNum.get(v)!.yanked, prerelease: isPrerelease(v) })),
    deprecatedVersions: {},
    yankedVersions: yanked,
  };
}

export async function fetchCrate(name: string, timeoutMs: number): Promise<RegistryPackage> {
  await politeDelay();
  const body = await getJson<CratesResponse>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { timeoutMs });
  if (!body?.crate || !Array.isArray(body.versions)) throw new Error(`crates.io returned an unexpected body for ${name}`);
  return parseCratesResponse(name, body);
}
