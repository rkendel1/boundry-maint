/**
 * Side-effect adapters for the Release Manager. Each one talks to exactly one external authority and reports
 * what that authority says; none of them decides anything. Credentials are read from files/env by the caller
 * and never logged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { withLocks } from "../lib/lock.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const pexec = promisify(execFile);

export class Unavailable extends Error {}
export class Refused extends Error {}

// ───────── npm registry ─────────
export interface RegistryVersion { version: string; integrity: string | null; shasum: string | null; tarball: string | null }
export interface RegistryState { versions: string[]; distTags: Record<string, string> }
export interface RegistryAdapter {
  readonly url: string;
  state(name: string): Promise<RegistryState | null>; // null = package does not exist
  version(name: string, version: string): Promise<RegistryVersion | null>;
  publish(tarballPath: string, distTag: string): Promise<void>;
  download(url: string): Promise<Buffer>;
}

export class NpmRegistry implements RegistryAdapter {
  readonly url: string;
  readonly #token: string | null;
  constructor(url: string, token: string | null) { this.url = url.replace(/\/$/, ""); this.#token = token; }
  #doc = (name: string) => `${this.url}/${name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
  async #get(url: string): Promise<Response | null> {
    let res: Response;
    try { res = await fetch(url, { headers: { accept: "application/json", ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) }, signal: AbortSignal.timeout(20_000) }); }
    catch (e) { throw new Unavailable(`registry unreachable: ${(e as Error).message}`); }
    if (res.status === 404) return null;
    if (res.status >= 500 || res.status === 429) throw new Unavailable(`registry answered ${res.status}`);
    if (!res.ok) throw new Error(`registry answered ${res.status} for ${url}`);
    return res;
  }
  async state(name: string): Promise<RegistryState | null> {
    const res = await this.#get(this.#doc(name));
    if (!res) return null;
    const d: any = await res.json();
    return { versions: Object.keys(d.versions ?? {}), distTags: d["dist-tags"] ?? {} };
  }
  async version(name: string, version: string): Promise<RegistryVersion | null> {
    const res = await this.#get(this.#doc(name));
    if (!res) return null;
    const v = (await res.json() as any).versions?.[version];
    return v ? { version, integrity: v.dist?.integrity ?? null, shasum: v.dist?.shasum ?? null, tarball: v.dist?.tarball ?? null } : null;
  }
  async publish(tarballPath: string, distTag: string): Promise<void> {
    if (!this.#token) throw new Refused("no publish credential configured for this registry");
    const dir = await mkdtemp(join(tmpdir(), "boundry-npmrc-"));
    const rc = join(dir, "npmrc");
    const host = this.url.replace(/^https?:/, "");
    await writeFile(rc, `${host}/:_authToken=\${BOUNDRY_PUBLISH_TOKEN}\nregistry=${this.url}/\n`, { mode: 0o600 });
    try {
      await pexec("npm", ["publish", tarballPath, "--tag", distTag, "--registry", `${this.url}/`, "--access", "public", "--ignore-scripts"], {
        env: { ...process.env, npm_config_userconfig: rc, BOUNDRY_PUBLISH_TOKEN: this.#token }, maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      if (/E409|EPUBLISHCONFLICT|cannot publish over|already present/i.test(msg)) throw new Refused("registry refused: version already present");
      if (/E5\d\d|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) throw new Unavailable(`registry unavailable during publish: ${msg.split("\n").find((l) => /error/i.test(l)) ?? ""}`);
      throw new Error(`publish failed: ${msg.split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" ")}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async download(url: string): Promise<Buffer> {
    const res = await this.#get(url);
    if (!res) throw new Error(`tarball not found: ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// ───────── Git (authority for commits and tags) ─────────
export interface GitIdentity { name: string; email: string }
export interface GitAuthority {
  head(branch: string): Promise<string | null>;
  tags(): Promise<Map<string, string>>; // tag → peeled target commit
  read(commit: string, path: string): Promise<string | null>;
  list(commit: string, dir: string): Promise<string[] | null>;
  /** Deterministic commit (fixed dates) of `files` on top of `parent`; returns its sha without pushing. */
  makeCommit(parent: string, files: Record<string, string>, message: string, at: string): Promise<string>;
  /** Fast-forward `branch` from `expected` to `commit`; Refused if the branch is not at `expected`. */
  pushBranch(branch: string, commit: string, expected: string): Promise<void>;
  /** Annotated tag (fixed date) on `commit`; Refused if the tag already exists remotely. */
  pushTag(tag: string, commit: string, message: string, at: string): Promise<void>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  log(range: string, path: string, limit: number): Promise<string[]>;
}

const inGit = new AsyncLocalStorage<Set<string>>();

export class GitCli implements GitAuthority {
  readonly #url: string; readonly #work: string; readonly #id: GitIdentity; readonly #auth: string[];
  constructor(url: string, workDir: string, identity: GitIdentity, authHeader?: string) {
    this.#url = url; this.#work = workDir; this.#id = identity;
    this.#auth = authHeader ? ["-c", `http.extraHeader=${authHeader}`] : [];
  }
  /**
   * One git operation at a time per work directory, across processes: the mirror's shallow file, index and
   * checkout are shared state (concurrent fetches fail with "remove the file manually to continue").
   * Re-entrant within one call chain.
   */
  #serial<T>(f: () => Promise<T>): Promise<T> {
    if (inGit.getStore()?.has(this.#work)) return f();
    const held = new Set(inGit.getStore() ?? []).add(this.#work);
    return withLocks([`${this.#work}.lock`], () => inGit.run(held, f), { waitMs: 300_000 });
  }
  async #git(args: string[], env: Record<string, string> = {}): Promise<string> {
    try { return (await pexec("git", ["-C", this.#work, ...this.#auth, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 32 * 1024 * 1024 })).stdout; }
    catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      if (/Could not read from remote|unable to access|Connection refused|timed out/i.test(msg)) throw new Unavailable(`git: ${msg.trim().split("\n").pop()}`);
      throw Object.assign(new Error(`git ${args[0]}: ${msg.trim().split("\n").pop()}`), { stderr: msg });
    }
  }
  async #ready() { await mkdir(this.#work, { recursive: true }); await pexec("git", ["init", "-q", this.#work]).catch(() => {}); }
  async #fetch(ref: string) { await this.#ready(); await this.#git(["fetch", "-q", "--depth", "200", this.#url, ref]); }
  async head(branch: string) {
    return this.#serial(async () => {
    await this.#ready();
    const out = await this.#git(["ls-remote", this.#url, `refs/heads/${branch}`]);
    return out.trim().split(/\s+/)[0] || null;
    });
  }
  async tags() {
    return this.#serial(async () => {
    await this.#ready();
    const out = await this.#git(["ls-remote", "--tags", this.#url]);
    const m = new Map<string, string>();
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/);
      if (!sha || !ref) continue;
      const name = ref.replace(/^refs\/tags\//, "");
      if (name.endsWith("^{}")) m.set(name.slice(0, -3), sha); // peeled annotated tag wins
      else if (!m.has(name)) m.set(name, sha);
    }
    return m;
    });
  }
  async read(commit: string, path: string) {
    return this.#serial(async () => {
    await this.#fetch(commit);
    try { return await this.#git(["show", `${commit}:${path}`]); } catch { return null; }
    });
  }
  async list(commit: string, dir: string) {
    return this.#serial(async () => {
    await this.#fetch(commit);
    try { return (await this.#git(["ls-tree", "--name-only", `${commit}:${dir === "." ? "" : dir}`])).trim().split("\n").filter(Boolean).sort(); } catch { return null; }
    });
  }
  #env(at: string) { return { GIT_AUTHOR_NAME: this.#id.name, GIT_AUTHOR_EMAIL: this.#id.email, GIT_COMMITTER_NAME: this.#id.name, GIT_COMMITTER_EMAIL: this.#id.email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }; }
  async makeCommit(parent: string, files: Record<string, string>, message: string, at: string) {
    return this.#serial(async () => {
    await this.#fetch(parent);
    await this.#git(["checkout", "-q", "-f", "--detach", parent]);
    for (const [p, content] of Object.entries(files)) { await mkdir(dirname(join(this.#work, p)), { recursive: true }); await writeFile(join(this.#work, p), content); }
    await this.#git(["add", "--", ...Object.keys(files)]);
    await this.#git(["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], this.#env(at));
    return (await this.#git(["rev-parse", "HEAD"])).trim();
    });
  }
  async pushBranch(branch: string, commit: string, expected: string) {
    return this.#serial(async () => {
    try { await this.#git(["push", "-q", `--force-with-lease=refs/heads/${branch}:${expected}`, this.#url, `${commit}:refs/heads/${branch}`]); }
    catch (e) { if (/stale info|rejected|non-fast-forward|fetch first/i.test(String((e as any).stderr ?? (e as Error).message))) throw new Refused(`${branch} is no longer at ${expected.slice(0, 12)}`); throw e; }
    });
  }
  async pushTag(tag: string, commit: string, message: string, at: string) {
    return this.#serial(async () => {
    if ((await this.tags()).has(tag)) throw new Refused(`tag ${tag} already exists`);
    await this.#fetch(commit);
    await this.#git(["-c", "tag.gpgsign=false", "tag", "-f", "-a", tag, commit, "-m", message], this.#env(at));
    try { await this.#git(["push", "-q", this.#url, `refs/tags/${tag}`]); }
    catch (e) { if (/already exists|rejected/i.test(String((e as any).stderr ?? (e as Error).message))) throw new Refused(`tag ${tag} already exists`); throw e; }
    });
  }
  async isAncestor(a: string, d: string) {
    return this.#serial(async () => {
    await this.#fetch(d);
    try { await this.#git(["merge-base", "--is-ancestor", a, d]); return true; } catch { return false; }
    });
  }
  async log(range: string, path: string, limit: number) {
    return this.#serial(async () => {
    try { return (await this.#git(["log", `--max-count=${limit}`, "--format=%h %s", range, "--", path])).trim().split("\n").filter(Boolean); } catch { return []; }
    });
  }
}

// ───────── GitHub Releases ─────────
export interface ReleasesAdapter {
  find(repo: string, tag: string): Promise<{ url: string; tag: string } | null>;
  create(repo: string, r: { tag: string; name: string; body: string; prerelease: boolean }): Promise<{ url: string }>;
}
export class GitHubReleases implements ReleasesAdapter {
  readonly #api: string; readonly #token: string | null;
  constructor(api: string, token: string | null) { this.#api = api.replace(/\/$/, ""); this.#token = token; }
  async #req(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.#api}${path}`, { method, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    } catch (e) { throw new Unavailable(`GitHub unreachable: ${(e as Error).message}`); }
  }
  async find(repo: string, tag: string) {
    const r = await this.#req("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (r.status === 404) return null;
    if (r.status >= 500) throw new Unavailable(`GitHub answered ${r.status}`);
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j: any = await r.json();
    return { url: j.html_url, tag: j.tag_name };
  }
  async create(repo: string, rel: { tag: string; name: string; body: string; prerelease: boolean }) {
    const r = await this.#req("POST", `/repos/${repo}/releases`, { tag_name: rel.tag, name: rel.name, body: rel.body, prerelease: rel.prerelease, draft: false });
    if (r.status >= 500) throw new Unavailable(`GitHub answered ${r.status}`);
    if (!r.ok) throw new Error(`GitHub refused release creation: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { url: ((await r.json()) as any).html_url };
  }
}

// ───────── Boundry CI (execution substrate) ─────────
export interface ExecutionRequest { requestId: string; repository: string; commit: string; branch: string; recipe: { path: string; source: string } }
export interface ExecutionStatus { runId: string; state: "running" | "succeeded" | "failed" | "cancelled"; reason: string | null; jobs: { key: string; state: string; reason: string | null }[]; evidenceUrl: string }
export interface Executor {
  submit(req: ExecutionRequest): Promise<{ runId: string; duplicate: boolean }>;
  status(runId: string): Promise<ExecutionStatus>;
  artifact(runId: string, job: string, name: string): Promise<{ sha256: string; bytes: Buffer }>;
}
export class BoundryCiExecutor implements Executor {
  readonly #url: string; readonly #token: string;
  constructor(url: string, operatorToken: string) { this.#url = url.replace(/\/$/, ""); this.#token = operatorToken; }
  async #req(method: string, path: string, body?: unknown): Promise<Response> {
    try { return await fetch(`${this.#url}${path}`, { method, headers: { authorization: `Bearer ${this.#token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { throw new Unavailable(`Boundry CI unreachable: ${(e as Error).message}`); }
  }
  async submit(req: ExecutionRequest) {
    const r = await this.#req("POST", "/v1/executions", req);
    if (!r.ok) throw new Error(`Boundry CI refused the execution: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const j: any = await r.json();
    if (!j.runIds?.length) throw new Error(`Boundry CI created no run (${j.state})`);
    return { runId: j.runIds[0], duplicate: !!j.duplicate };
  }
  async status(runId: string): Promise<ExecutionStatus> {
    const run: any = await (await this.#req("GET", `/v1/runs/${runId}`)).json();
    const jobs: any[] = await (await this.#req("GET", `/v1/runs/${runId}/jobs`)).json();
    return { runId, state: run.state, reason: run.reason ?? null, jobs: jobs.map((j) => ({ key: j.key, state: j.state, reason: j.reason ?? null })), evidenceUrl: `${this.#url}/v1/runs/${runId}/evidence` };
  }
  async artifact(runId: string, job: string, name: string) {
    const ev: any = await (await this.#req("GET", `/v1/runs/${runId}/evidence`)).json();
    const j = ev.jobs.find((x: any) => x.key === job);
    const a = j?.attempts.filter((x: any) => x.state === "succeeded").at(-1)?.artifacts.find((x: any) => x.name === name);
    if (!a) throw new Error(`run ${runId} has no artifact ${name} from ${job}`);
    const r = await this.#req("GET", `/v1/artifacts/sha256/${a.digest}`);
    if (!r.ok) throw new Error(`artifact download failed: ${r.status}`);
    return { sha256: a.digest, bytes: Buffer.from(await r.arrayBuffer()) };
  }
}
