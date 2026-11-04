/** npm registry adapter. https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md */
import { getJson } from "../lib/http.ts";
import { isPrerelease, sortDesc, valid } from "../version/compare.ts";
import type { VersionInfo } from "../contracts.ts";

export interface RegistryPackage {
  latestVersion: string | null;
  latestStable: string | null;
  latestPrerelease: string | null;
  publishedAt: string | null;
  distTags: Record<string, string> | null;
  deprecated: string | null;
  description: string | null;
  repositoryUrl: string | null;
  registryUrl: string;
  versions: VersionInfo[]; // newest first
  deprecatedVersions: Record<string, string>;
  yankedVersions: string[];
}

interface NpmDoc {
  name: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  repository?: string | { url?: string };
  versions?: Record<string, { deprecated?: string | boolean; repository?: string | { url?: string } }>;
}

export function npmDocUrl(name: string): string {
  return `https://registry.npmjs.org/${name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
}

function repoUrl(r: NpmDoc["repository"]): string | null {
  if (!r) return null;
  const url = typeof r === "string" ? r : r.url;
  return url ? url.replace(/^git\+/, "").replace(/\.git$/, "") : null;
}

export function parseNpmDoc(name: string, doc: NpmDoc): RegistryPackage {
  const versionsMap = doc.versions ?? {};
  const all = sortDesc(Object.keys(versionsMap));
  const deprecatedVersions: Record<string, string> = {};
  for (const v of all) {
    const d = versionsMap[v]?.deprecated;
    if (d) deprecatedVersions[v] = typeof d === "string" ? d : "deprecated";
  }
  const distTags = doc["dist-tags"] ?? {};
  const latest = valid(distTags.latest) ?? null;
  const latestStable = all.find((v) => !isPrerelease(v) && !deprecatedVersions[v]) ?? null;
  const newestPre = all.find((v) => isPrerelease(v)) ?? null;
  const latestPrerelease = newestPre && (!latestStable || sortDesc([newestPre, latestStable])[0] === newestPre) ? newestPre : null;
  const time = doc.time ?? {};
  const latestManifest = latest ? versionsMap[latest] : undefined;
  return {
    latestVersion: latest,
    latestStable,
    latestPrerelease,
    publishedAt: latest ? time[latest] ?? null : null,
    distTags,
    deprecated: latest ? deprecatedVersions[latest] ?? null : null,
    description: doc.description ?? null,
    repositoryUrl: repoUrl(latestManifest?.repository) ?? repoUrl(doc.repository),
    registryUrl: `https://www.npmjs.com/package/${name}`,
    versions: all.map((v) => ({ version: v, publishedAt: time[v] ?? null, deprecated: deprecatedVersions[v] ?? null, prerelease: isPrerelease(v) })),
    deprecatedVersions,
    yankedVersions: [],
  };
}

export async function fetchNpmPackage(name: string, timeoutMs: number): Promise<RegistryPackage> {
  const doc = await getJson<NpmDoc>(npmDocUrl(name), { timeoutMs });
  if (!doc || typeof doc !== "object" || !doc.versions) throw new Error(`npm returned no versions for ${name}`);
  return parseNpmDoc(name, doc);
}
