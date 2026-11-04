/** GitHub REST adapter (read-only). */
import { get, getJson, HttpError } from "../lib/http.ts";
import { sortDesc, valid } from "../version/compare.ts";
import type { GithubRepoInfo } from "../contracts.ts";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export class GitHub {
  private readonly token: string | null;
  private readonly timeoutMs: number;
  constructor(token: string | null, timeoutMs: number) {
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    const h: Record<string, string> = { accept, "x-github-api-version": "2022-11-28" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  json<T>(path: string): Promise<T> {
    return getJson<T>(`${API}${path}`, { headers: this.headers(), timeoutMs: this.timeoutMs });
  }

  /** Like json(), but 404 → null. */
  async optional<T>(path: string): Promise<T | null> {
    try {
      return await this.json<T>(path);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async raw(repo: string, path: string, ref: string): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await get(`${API}/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      headers: this.headers("application/vnd.github.raw"),
      timeoutMs: this.timeoutMs,
    });
    return res.text();
  }

  async repo(repo: string) {
    return this.json<{ default_branch: string; private: boolean; archived: boolean; pushed_at: string; html_url: string }>(`/repos/${repo}`);
  }

  async branchHead(repo: string, branch: string): Promise<string> {
    const b = await this.json<{ commit: { sha: string } }>(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    return b.commit.sha;
  }

  async tree(repo: string, sha: string): Promise<{ paths: string[]; truncated: boolean }> {
    const t = await this.json<{ tree: { path: string; type: string }[]; truncated: boolean }>(`/repos/${repo}/git/trees/${sha}?recursive=1`);
    return { paths: t.tree.filter((e) => e.type === "blob").map((e) => e.path), truncated: t.truncated };
  }

  async workflowRunsForCommit(repo: string, workflow: string, sha: string) {
    const r = await this.optional<{ workflow_runs: { id: number; html_url: string; status: string; conclusion: string | null; head_sha: string; run_attempt: number; created_at: string }[] }>(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=20`,
    );
    return r?.workflow_runs ?? [];
  }

  async repoInfo(repo: string): Promise<GithubRepoInfo> {
    const r = await this.repo(repo);
    const latest = await this.optional<{ tag_name: string; name: string | null; published_at: string | null; html_url: string; prerelease: boolean }>(
      `/repos/${repo}/releases/latest`,
    );
    const tags = (await this.optional<{ name: string }[]>(`/repos/${repo}/tags?per_page=100`)) ?? [];
    return {
      repository: repo,
      url: r.html_url,
      private: r.private,
      archived: r.archived,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      latestRelease: latest
        ? { tag: latest.tag_name, name: latest.name, publishedAt: latest.published_at, url: latest.html_url, prerelease: latest.prerelease }
        : null,
      latestTag: latestTag(tags.map((t) => t.name)),
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Highest semver-looking tag. Monorepo tags such as "@appport/sdk@1.4.1" or
 * "feltdb-v0.6.1" are compared by their trailing version; non-version tags are
 * only used if no version tag exists (GitHub's own order, newest-ish first).
 */
export function latestTag(tags: string[]): string | null {
  const versioned = new Map<string, string>();
  for (const t of tags) {
    const m = t.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    const v = m ? valid(m[1]) : null;
    if (v && !versioned.has(v)) versioned.set(v, t);
  }
  const best = sortDesc(versioned.keys())[0];
  return best ? versioned.get(best)! : tags[0] ?? null;
}
