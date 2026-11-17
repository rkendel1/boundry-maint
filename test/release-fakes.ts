import { Principal } from "../src/contracts.ts";
/** Test stand-ins with failure injection. Git is REAL (temporary bare repositories); the executor really packs. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Unavailable, Refused, type RegistryAdapter, type ReleasesAdapter, type Executor, type ExecutionRequest, type ExecutionStatus } from "../src/release/adapters.ts";

const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const integrity = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

/** A real bare repository with an npm workspace: @demo/core 0.2.0 and @demo/client pinning it exactly. */
export function makeRepo(opts: { clientPin?: string } = {}): { url: string; bare: string; push: (files: Record<string, string>, msg: string) => string; head: () => string } {
  const base = mkdtempSync(join(tmpdir(), "rm-repo-"));
  const bare = join(base, "origin.git"), work = join(base, "work");
  sh("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  sh("git", ["init", "-q", "-b", "main", work]);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo-workspace", private: true, workspaces: ["packages/*"] }, null, 2) + "\n",
    "packages/core/package.json": JSON.stringify({ name: "@demo/core", version: "0.2.0", main: "index.js" }, null, 2) + "\n",
    "packages/core/index.js": "module.exports = 1;\n",
    "packages/client/package.json": JSON.stringify({ name: "@demo/client", version: "0.3.0", dependencies: { "@demo/core": opts.clientPin ?? "^0.2.0" } }, null, 2) + "\n",
    "packages/client/index.js": "module.exports = 2;\n",
  };
  const commit = (fs: Record<string, string>, msg: string, lock = false) => {
    for (const [p, c] of Object.entries(fs)) { mkdirSync(join(work, p, ".."), { recursive: true }); writeFileSync(join(work, p), c); }
    // A real npm-generated lockfile (workspace links only, so this works offline).
    if (lock) sh("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], work);
    sh("git", ["-C", work, "add", "-A"]);
    sh("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
    sh("git", ["-C", work, "push", "-q", "-f", bare, "HEAD:refs/heads/main"]);
    return sh("git", ["-C", work, "rev-parse", "HEAD"]).trim();
  };
  commit(files, "initial", true);
  return { url: `file://${bare}`, bare, push: (fs, m) => { sh("git", ["-C", work, "fetch", "-q", bare, "main"]); sh("git", ["-C", work, "reset", "-q", "--hard", "FETCH_HEAD"]); return commit(fs, m); }, head: () => sh("git", ["-C", bare, "rev-parse", "refs/heads/main"]).trim() };
}

export class FakeRegistry implements RegistryAdapter {
  readonly url = "mem://registry";
  readonly kind = "npm" as const;
  integrityOf(b: Buffer) { return integrity(b); }
  pkgs = new Map<string, { versions: Map<string, { bytes: Buffer; integrity: string }>; distTags: Record<string, string> }>();
  publishes = 0;
  mode: "ok" | "unavailable-once" | "lose-response-once" | "error-once" | "down" = "ok";
  seed(name: string, versions: string[]) {
    const m = new Map(versions.map((v) => [v, { bytes: Buffer.from(`seed ${v}`), integrity: integrity(Buffer.from(`seed ${v}`)) }]));
    this.pkgs.set(name, { versions: m, distTags: { latest: versions.at(-1)! } });
  }
  async state(name: string) {
    if (this.mode === "down") throw new Unavailable("registry down");
    const p = this.pkgs.get(name);
    return p ? { versions: [...p.versions.keys()], yanked: [], distTags: { ...p.distTags } } : null;
  }
  async version(name: string, version: string) {
    if (this.mode === "down") throw new Unavailable("registry down");
    const v = this.pkgs.get(name)?.versions.get(version);
    return v ? { version, integrity: v.integrity, shasum: null, tarball: `mem://${name}/${version}`, yanked: false } : null;
  }
  async publish(path: string, { distTag }: { distTag: string }) {
    if (this.mode === "down") throw new Unavailable("registry down");
    if (this.mode === "unavailable-once") { this.mode = "ok"; throw new Unavailable("registry answered 503"); }
    if (this.mode === "error-once") { this.mode = "ok"; throw new Error("publish failed: E500 internal"); }
    const bytes = readFileSync(path);
    const inner = JSON.parse(execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }));
    const p = this.pkgs.get(inner.name) ?? { versions: new Map<string, { bytes: Buffer; integrity: string }>(), distTags: {} as Record<string, string> };
    if (p.versions.has(inner.version)) throw new Refused("registry refused: version already present");
    p.versions.set(inner.version, { bytes, integrity: integrity(bytes) });
    p.distTags[distTag] = inner.version;
    this.pkgs.set(inner.name, p);
    this.publishes++;
    if (this.mode === "lose-response-once") { this.mode = "ok"; throw new Unavailable("socket hang up (response lost)"); }
  }
  async download(url: string) {
    const rest = url.slice("mem://".length);
    const i = rest.lastIndexOf("/");
    return this.pkgs.get(rest.slice(0, i))!.versions.get(rest.slice(i + 1))!.bytes;
  }
}

export class FakeReleases implements ReleasesAdapter {
  rels = new Map<string, string>();
  failOnce = false;
  creates = 0;
  async find(_repo: string, tag: string) { return this.rels.has(tag) ? { url: this.rels.get(tag)!, tag } : null; }
  async create(repo: string, r: { tag: string; name: string; body: string }) {
    if (this.failOnce) { this.failOnce = false; throw new Unavailable("GitHub answered 502"); }
    const url = `mem://github-stand-in/${repo}/releases/tag/${encodeURIComponent(r.tag)}`;
    this.rels.set(r.tag, url); this.creates++; this.lastBody = r.body;
    return { url };
  }
  lastBody = "";
}

/** Builds for real: clones the requested commit and runs `npm pack --workspaces` into package.tar. */
export class PackingExecutor implements Executor {
  readonly url: string;
  runs = new Map<string, { req: ExecutionRequest; state: ExecutionStatus["state"]; bytes?: Buffer; sha256?: string }>();
  byRequest = new Map<string, string>();
  mode: "ok" | "fail-once" | "corrupt-digest" | "wrong-version" = "ok";
  lastError = "";
  constructor(url: string) { this.url = url; }
  async submit(req: ExecutionRequest) {
    const existing = this.byRequest.get(req.requestId);
    if (existing) return { runId: existing, duplicate: true };
    const runId = `run_${this.runs.size + 1}`;
    this.byRequest.set(req.requestId, runId);
    if (this.mode === "fail-once") { this.mode = "ok"; this.runs.set(runId, { req, state: "failed" }); return { runId, duplicate: false }; }
    const dir = mkdtempSync(join(tmpdir(), "rm-build-"));
    try {
      sh("git", ["init", "-q", dir]);
      sh("git", ["-C", dir, "fetch", "-q", "--depth", "1", this.url, req.commit]);
      sh("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"]);
      mkdirSync(join(dir, "out"));
      // Like the real release build: a clean install from the lockfile must succeed first.
      try { sh("npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], dir); }
      catch (e) { this.runs.set(runId, { req, state: "failed" }); this.lastError = String((e as any).stderr ?? e).split("\n").find((l) => /Missing|error/.test(l)) ?? "npm ci failed"; return { runId, duplicate: false }; }
      sh("npm", ["pack", "--workspaces", "--pack-destination", "out", "--silent", "--ignore-scripts"], dir);
      if (this.mode === "wrong-version") { for (const f of sh("ls", [join(dir, "out")]).trim().split("\n")) rmSync(join(dir, "out", f)); writeFileSync(join(dir, "out", "x.txt"), "x"); }
      sh("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "package.tar", "-C", "out", "."], dir);
      const bytes = readFileSync(join(dir, "package.tar"));
      const sha = createHash("sha256").update(bytes).digest("hex");
      this.runs.set(runId, { req, state: "succeeded", bytes, sha256: this.mode === "corrupt-digest" ? "0".repeat(64) : sha });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { runId, duplicate: false };
  }
  async status(runId: string): Promise<ExecutionStatus> {
    const r = this.runs.get(runId)!;
    return { runId, state: r.state, reason: r.state === "failed" ? "tests failed" : null, jobs: [{ key: "tests", state: r.state, reason: null }, { key: "step-package", state: r.state, reason: null }], evidenceUrl: `mem://runs/${runId}` };
  }
  async artifact(runId: string) { const r = this.runs.get(runId)!; return { sha256: r.sha256!, bytes: r.bytes! }; }
}

/** Who is who: people approve, an agent proposes, the executor executes. */
export const PRINCIPALS = [
  { id: "randy", name: "Randy", type: "person", roles: ["admin", "engineer", "prod_approver"] },
  { id: "ada", name: "Ada", type: "person", roles: ["prod_approver"] },
  { id: "barbara", name: "Barbara", type: "person", roles: ["approver"] },
  { id: "grace", name: "Grace", type: "person", roles: ["engineer"] },
  { id: "mallory", name: "Mallory", type: "person", roles: ["prod_approver"] },
  { id: "bot", name: "Ops agent", type: "agent", roles: ["agent"] },
  { id: "component:release-executor", name: "Release executor", type: "component", roles: ["executor"] },
].map((p) => Principal.parse(p));

// ───────── Cargo stand-ins ─────────

/**
 * A real bare repository with a Cargo workspace: `demo-core` (publishable, own version) and `demo-app`
 * (publish = false) depending on it through a path + version requirement, plus a real Cargo.lock.
 * opts.inherit: both crates inherit [workspace.package] version; opts.appReq: app's requirement on core.
 */
export function makeCargoRepo(opts: { inherit?: boolean; appReq?: string; coreVersion?: string; appPublish?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "rm-cargo-"));
  const bare = join(base, "origin.git"), work = join(base, "work");
  sh("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  sh("git", ["init", "-q", "-b", "main", work]);
  const v = opts.coreVersion ?? "0.1.0";
  const ver = opts.inherit ? "version.workspace = true" : `version = "${v}"`;
  const files: Record<string, string> = {
    "Cargo.toml": `[workspace]\nmembers = ["crates/core", "crates/app"]\nresolver = "2"\n${opts.inherit ? `\n[workspace.package]\nversion = "${v}"\n` : ""}`,
    "crates/core/Cargo.toml": `[package]\nname = "demo-core"\n${ver}\nedition = "2021"\nlicense = "MIT"\ndescription = "Disposable crate for Boundry release tests"\n\n[dependencies]\n`,
    "crates/core/src/lib.rs": "pub fn answer() -> u32 { 42 }\n\n#[cfg(test)]\nmod t { #[test] fn works() { assert_eq!(super::answer(), 42); } }\n",
    "crates/app/Cargo.toml": `[package]\nname = "demo-app"\n${ver}\nedition = "2021"\nlicense = "MIT"\ndescription = "Disposable consumer"\n${opts.appPublish ? "" : "publish = false\n"}\n[dependencies]\ndemo-core = { version = "${opts.appReq ?? "0.1"}", path = "../core" }\n`,
    "crates/app/src/main.rs": "fn main() { println!(\"{}\", demo_core::answer()); }\n",
  };
  const commit = (fs: Record<string, string>, msg: string, lock = false) => {
    for (const [p, c] of Object.entries(fs)) { mkdirSync(join(work, p, ".."), { recursive: true }); writeFileSync(join(work, p), c); }
    if (lock) sh("cargo", ["generate-lockfile", "--offline"], work);
    sh("git", ["-C", work, "add", "-A"]);
    sh("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
    sh("git", ["-C", work, "push", "-q", "-f", bare, "HEAD:refs/heads/main"]);
    return sh("git", ["-C", work, "rev-parse", "HEAD"]).trim();
  };
  commit(files, "initial", true);
  return { url: `file://${bare}`, bare, work, push: (fs: Record<string, string>, m: string) => { sh("git", ["-C", work, "fetch", "-q", bare, "main"]); sh("git", ["-C", work, "reset", "-q", "--hard", "FETCH_HEAD"]); return commit(fs, m); }, head: () => sh("git", ["-C", bare, "rev-parse", "refs/heads/main"]).trim() };
}

const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** An in-memory Cargo registry: versions with checksums, yank, and the same failure modes as FakeRegistry. */
export class FakeCratesRegistry implements RegistryAdapter {
  readonly url = "mem://crates";
  readonly kind = "crates" as const;
  crates = new Map<string, Map<string, { bytes: Buffer; cksum: string; yanked: boolean }>>();
  publishes = 0;
  mode: "ok" | "lose-response-once" | "down" = "ok";
  integrityOf(b: Buffer) { return sha256hex(b); }
  seed(name: string, versions: string[], yanked: string[] = []) {
    this.crates.set(name, new Map(versions.map((v) => [v, { bytes: Buffer.from(`seed ${v}`), cksum: sha256hex(Buffer.from(`seed ${v}`)), yanked: yanked.includes(v) }])));
  }
  yank(name: string, v: string) { this.crates.get(name)!.get(v)!.yanked = true; }
  async state(name: string) {
    if (this.mode === "down") throw new Unavailable("crates registry down");
    const c = this.crates.get(name);
    return c ? { versions: [...c.keys()], yanked: [...c].filter(([, x]) => x.yanked).map(([v]) => v), distTags: {} } : null;
  }
  async version(name: string, version: string) {
    if (this.mode === "down") throw new Unavailable("crates registry down");
    const x = this.crates.get(name)?.get(version);
    return x ? { version, integrity: x.cksum, shasum: null, tarball: `mem://crates/${name}/${version}`, yanked: x.yanked } : null;
  }
  async publish(path: string) {
    if (this.mode === "down") throw new Unavailable("crates registry down");
    const bytes = readFileSync(path);
    const list = sh("tar", ["-tzf", path]).split("\n").filter(Boolean);
    const manifest = list.find((p) => /^[^/]+\/Cargo\.toml$/.test(p))!;
    const t = sh("tar", ["-xzOf", path, manifest]);
    const name = /^name = "([^"]+)"/m.exec(t)![1]!, version = /^version = "([^"]+)"/m.exec(t)![1]!;
    const c = this.crates.get(name) ?? new Map();
    if (c.has(version)) throw new Refused("registry refused: version already present");
    c.set(version, { bytes, cksum: sha256hex(bytes), yanked: false });
    this.crates.set(name, c);
    this.publishes++;
    if (this.mode === "lose-response-once") { this.mode = "ok"; throw new Unavailable("connection reset (response lost)"); }
  }
  async download(url: string) {
    const [, , , name, version] = url.split("/");
    return this.crates.get(name!)!.get(version!)!.bytes;
  }
}

/** Builds for real: clones the commit, runs the tests and `cargo package --workspace`, and returns package.tar. */
export class CargoPackingExecutor implements Executor {
  readonly url: string;
  runs = new Map<string, { req: ExecutionRequest; state: ExecutionStatus["state"]; bytes?: Buffer; sha256?: string; failed?: string }>();
  byRequest = new Map<string, string>();
  mode: "ok" | "tests-fail-once" = "ok";
  constructor(url: string) { this.url = url; }
  async submit(req: ExecutionRequest) {
    const existing = this.byRequest.get(req.requestId);
    if (existing) return { runId: existing, duplicate: true };
    const runId = `crun_${this.runs.size + 1}`;
    this.byRequest.set(req.requestId, runId);
    if (this.mode === "tests-fail-once") { this.mode = "ok"; this.runs.set(runId, { req, state: "failed", failed: "tests" }); return { runId, duplicate: false }; }
    const dir = mkdtempSync(join(tmpdir(), "rm-cbuild-"));
    try {
      sh("git", ["init", "-q", dir]);
      sh("git", ["-C", dir, "fetch", "-q", "--depth", "1", this.url, req.commit]);
      sh("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"]);
      try { sh("cargo", ["test", "--locked", "--offline", "-q"], dir); }
      catch { this.runs.set(runId, { req, state: "failed", failed: "tests" }); return { runId, duplicate: false }; }
      try { sh("cargo", ["package", "--locked", "--offline", "--workspace", "--allow-dirty", "-q"], dir); }
      catch (e) { this.runs.set(runId, { req, state: "failed", failed: `step-package: ${String((e as any).stderr ?? e).slice(0, 300)}` }); return { runId, duplicate: false }; }
      mkdirSync(join(dir, "out"));
      for (const f of sh("ls", [join(dir, "target", "package")]).trim().split("\n").filter((x) => x.endsWith(".crate"))) writeFileSync(join(dir, "out", f), readFileSync(join(dir, "target", "package", f)));
      sh("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "package.tar", "-C", "out", "."], dir);
      const bytes = readFileSync(join(dir, "package.tar"));
      this.runs.set(runId, { req, state: "succeeded", bytes, sha256: sha256hex(bytes) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { runId, duplicate: false };
  }
  async status(runId: string): Promise<ExecutionStatus> {
    const r = this.runs.get(runId)!;
    const testsFailed = r.failed === "tests";
    return { runId, state: r.state, reason: r.failed ?? null, jobs: [{ key: "tests", state: testsFailed ? "failed" : r.state === "failed" ? "succeeded" : r.state, reason: testsFailed ? "cargo test failed" : null }, { key: "step-package", state: testsFailed ? "cancelled" : r.state, reason: !testsFailed && r.failed ? r.failed : null }], evidenceUrl: `mem://runs/${runId}` };
  }
  async artifact(runId: string) { const r = this.runs.get(runId)!; return { sha256: r.sha256!, bytes: r.bytes! }; }
}
