/**
 * Release Manager: plans, approvals and a recoverable release lifecycle.
 *
 *   proposed → validated → awaiting-approval → approved → prepared → built → tagged
 *            → published → registry-verified → released            (or failed / cancelled / superseded)
 *
 * Rules (enforced here, tested in test/release-manager.test.ts):
 * - The plan is immutable once approved; the approval binds its digest. Anything that would change the plan
 *   (registry moved, branch moved) stops the release instead of adapting it.
 * - Every non-idempotent step first asks the authority whether it already happened (commit on the branch, tag
 *   target, registry version + integrity, GitHub release) and only then acts.
 * - Tags are created only after the exact release commit produced a verified artifact, and are never moved.
 * - A published version is never overwritten; publication counts only after the registry serves the version
 *   with the artifact's integrity.
 * - Nothing is ever deleted: failures, attempts and history are append-only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import semver from "semver";
import { ReleaseRecord, ReleasePolicy, type PackageConfig, type ReleaseBump, type ReleasePlan, type ReleaseState, type Installation } from "../contracts.ts";
import { writeAllAtomic, stableJson } from "../lib/files.ts";
import { allocate, tagFor, AllocationError } from "./version.ts";
import { editPackageJson, editPackageLock, dependentEffect, npmDependency, type Dependent } from "./manifests.ts";
import { Unavailable, Refused, type RegistryAdapter, type GitAuthority, type ReleasesAdapter, type Executor } from "./adapters.ts";

const pexec = promisify(execFile);
const TERMINAL: ReleaseState[] = ["released", "failed", "cancelled", "superseded"];
const ORDER: ReleaseState[] = ["proposed", "validated", "awaiting-approval", "approved", "prepared", "built", "tagged", "published", "registry-verified", "released"];

export class ReleaseError extends Error {
  readonly code: "busy" | "invalid" | "not-allowed" | "unsupported" | "decision" | "collision";
  constructor(code: ReleaseError["code"], message: string) { super(message); this.code = code; }
}
/** A step could not complete; the release stays at its last verified state (recoverable) or ends (fatal). */
class Blocked extends Error { readonly recoverable: boolean; readonly terminal: ReleaseState; constructor(reason: string, recoverable: boolean, terminal: ReleaseState = "failed") { super(reason); this.recoverable = recoverable; this.terminal = terminal; } }

export interface ManagerDeps {
  dataDir: string;
  runtimeDir: string;
  catalog: PackageConfig[];
  registry(pkg: PackageConfig): RegistryAdapter;
  git(repository: string): GitAuthority;
  releases: ReleasesAdapter;
  executor: Executor;
  installations?: Installation[];
  now?: () => string;
  buildTimeoutMs?: number;
  pollMs?: number;
}

export interface PlanRequest { packages: string[]; bump: ReleaseBump; requestedBy: string; reason?: string }

const canonical = (v: unknown): string => JSON.stringify(sort(v));
const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as any)[k])])) : v;
export const planDigestOf = (p: ReleasePlan) => createHash("sha256").update(canonical(p)).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const integrity = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const tgzName = (name: string, version: string) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

export class ReleaseManager {
  readonly d: Required<Omit<ManagerDeps, "installations">> & { installations: Installation[] };
  constructor(deps: ManagerDeps) {
    this.d = { installations: [], now: () => new Date().toISOString(), buildTimeoutMs: 30 * 60_000, pollMs: 2_000, ...deps } as any;
  }

  path(id: string) { const [pkg, version] = splitId(id); return join(this.d.dataDir, "release-manager", pkg, `${version}.json`); }
  async load(id: string): Promise<ReleaseRecord> { return ReleaseRecord.parse(JSON.parse(await readFile(this.path(id), "utf8"))); }
  async #save(r: ReleaseRecord) { await writeAllAtomic({ [this.path(r.id)]: ReleaseRecord.parse(r) }); }
  async list(): Promise<ReleaseRecord[]> {
    const base = join(this.d.dataDir, "release-manager");
    const out: ReleaseRecord[] = [];
    for (const pkg of existsSync(base) ? (await readdir(base)).sort() : []) for (const f of (await readdir(join(base, pkg))).sort()) out.push(ReleaseRecord.parse(JSON.parse(await readFile(join(base, pkg, f), "utf8"))));
    return out;
  }

  // ───────── plan ─────────
  async plan(req: PlanRequest): Promise<ReleaseRecord> {
    const pkgs = req.packages.map((id) => {
      const p = this.d.catalog.find((c) => c.id === id);
      if (!p) throw new ReleaseError("invalid", `unknown package ${id}`);
      if (p.ownership !== "owned") throw new ReleaseError("not-allowed", `${p.name} is ${p.ownership}, not owned: Boundry only releases owned packages`);
      if (!p.release) throw new ReleaseError("not-allowed", `${p.name} has no release policy in config/packages.json; releases are disabled for it`);
      if (p.registry !== "npm") throw new ReleaseError("unsupported", `${p.name}: publishing to ${p.registry} is not available yet (npm only)`);
      if (!p.repository) throw new ReleaseError("invalid", `${p.name} has no repository`);
      return p as PackageConfig & { release: ReleasePolicy; repository: string };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const first = pkgs[0];
    if (!first) throw new ReleaseError("invalid", "a release needs at least one package");
    const repo = first.repository;
    if (pkgs.some((p) => p.repository !== repo)) throw new ReleaseError("invalid", "packages released together must share one repository (one release commit)");
    const branch = first.release.branch;
    if (pkgs.some((p) => p.release.branch !== branch)) throw new ReleaseError("invalid", "packages released together must share a release branch");
    for (const r of await this.list()) {
      if (!TERMINAL.includes(r.state) && r.plan.packages.some((x) => pkgs.some((p) => p.id === x.package))) throw new ReleaseError("busy", `release ${r.id} is ${r.state}; finish or cancel it first`);
    }

    const git = this.d.git(repo);
    const source = await git.head(branch);
    if (!source) throw new ReleaseError("invalid", `${repo} has no branch ${branch}`);
    const tags = [...(await git.tags()).keys()];
    const now = this.d.now();
    const decision: string[] = [];
    const planned: ReleasePlan["packages"] = [];
    for (const p of pkgs) {
      const dir = p.directory ?? ".";
      const manifestPath = dir === "." ? "package.json" : `${dir}/package.json`;
      const manifestText = await git.read(source, manifestPath);
      if (!manifestText) throw new ReleaseError("invalid", `${p.name}: ${manifestPath} not found at ${source.slice(0, 12)}`);
      const manifest = JSON.parse(manifestText);
      if (manifest.name !== p.name) throw new ReleaseError("invalid", `${manifestPath} is "${manifest.name}", but the catalog says ${p.name}`);
      if (manifest.private) throw new ReleaseError("not-allowed", `${p.name} is marked private in ${manifestPath}`);
      const reg = this.d.registry(p);
      const st = await reg.state(p.name).catch((e) => { throw new ReleaseError("invalid", `cannot plan: ${(e as Error).message}`); });
      let alloc;
      try { alloc = allocate(p.name, { published: st?.versions ?? [], repositoryVersion: manifest.version ?? null, tags }, req.bump, p.release); }
      catch (e) { if (e instanceof AllocationError) throw new ReleaseError(e.kind === "collision" ? "collision" : e.kind === "decision" ? "decision" : "not-allowed", e.message); throw e; }
      decision.push(...alloc.explanation);
      const highest = (st?.versions ?? []).filter((v) => semver.valid(v)).sort(semver.rcompare)[0] ?? null;
      planned.push({
        package: p.id, name: p.name, registry: p.registry, directory: dir,
        registryVersions: { count: st?.versions.length ?? 0, highest, latestTag: st?.distTags.latest ?? null, observedAt: now },
        repositoryVersion: manifest.version ?? null, proposedVersion: alloc.version, tag: alloc.tag,
        distTag: semver.prerelease(alloc.version) ? "next" : p.release.distTag, destination: reg.url,
      });
    }
    // Workspace siblings: npm resolves them through the workspace link, so an exact pin on the old version
    // breaks the install (`npm ci`: "Missing ... from lock file") the moment the released package is bumped.
    const dependents: Dependent[] = [];
    const pins: ReleasePlan["releaseCommit"]["pins"] = [];
    const mustJoin: string[] = [];
    const rootManifest = await git.read(source, "package.json");
    const ws: string[] = rootManifest ? [].concat(JSON.parse(rootManifest).workspaces?.packages ?? JSON.parse(rootManifest).workspaces ?? []) : [];
    for (const pattern of ws) {
      const m = /^(.*)\/\*$/.exec(pattern);
      const parent = m?.[1];
      const dirs = parent !== undefined ? ((await git.list(source, parent)) ?? []).map((d) => `${parent}/${d}`) : [pattern];
      for (const d of dirs) {
        const text = await git.read(source, `${d}/package.json`);
        if (!text) continue;
        const holder = JSON.parse(text).name ?? d;
        const inPlan = planned.some((p) => p.directory === d);
        for (const pp of planned) {
          if (pp.directory === d) continue;
          const declared = npmDependency(text, pp.name);
          if (!declared) continue;
          const exact = semver.valid(declared) !== null;
          const accepts = exact ? semver.eq(declared, pp.proposedVersion) : !!semver.validRange(declared) && semver.satisfies(pp.proposedVersion, declared);
          if (inPlan && exact && !accepts) { pins.push({ in: d, dependency: pp.name, from: declared, to: pp.proposedVersion }); continue; }
          if (!accepts) {
            const id = this.d.catalog.find((c) => c.name === holder)?.id ?? holder;
            mustJoin.push(`${holder} (${d}/package.json declares ${pp.name} "${declared}") → add --package ${id}`);
            continue;
          }
          dependents.push(dependentEffect(holder, `${repo}:${d}/package.json`, declared, pp.registryVersions.highest ?? pp.repositoryVersion ?? "0.0.0", pp.proposedVersion));
        }
      }
    }
    // Consuming projects in other repositories (Maintenance's installations): reported, never changed.
    for (const inst of this.d.installations) {
      const pp = planned.find((p) => p.package === inst.package);
      if (!pp || inst.repository === repo || !inst.declaredVersion) continue;
      dependents.push(dependentEffect(inst.project, `${inst.repository}:${inst.manifest}`, inst.declaredVersion, inst.resolvedVersion ?? "0.0.0", pp.proposedVersion));
    }
    if (mustJoin.length) {
      throw new ReleaseError("decision", `this release would break the workspace install: npm resolves these siblings through the workspace, and their pins do not accept the new version(s). Release them together (Boundry never adds packages to a release on its own):\n  - ${[...new Set(mustJoin)].join("\n  - ")}`);
    }
    const files = await releaseFiles(git, source, planned, pins);
    if (dependents.length) decision.push(`${dependents.length} dependent manifest(s) found; none is changed or published by this release (see dependents).`);

    const policy = first.release;
    const plan: ReleasePlan = {
      repository: repo, branch, sourceCommit: source, bump: req.bump, requestedBy: req.requestedBy, requestedAt: now, reason: req.reason ?? null,
      packages: planned, decision, dependents: dependents.sort((a, b) => (a.package + a.where).localeCompare(b.package + b.where)),
      releaseCommit: { message: `Release ${planned.map((p) => `${p.name}@${p.proposedVersion}`).join(", ")}`, files: Object.keys(files).sort(), pins: pins.sort((a, b) => (a.in + a.dependency).localeCompare(b.in + b.dependency)) },
      validation: [...policy.validation], githubRelease: pkgs.every((p) => p.release.githubRelease),
      approvers: [...new Set(pkgs.flatMap((p) => p.release.approvers))].filter((a) => pkgs.every((p) => p.release.approvers.includes(a))).sort(),
    };
    if (!plan.approvers.length) throw new ReleaseError("not-allowed", "no person may approve every package in this release");
    const lead = planned[0]!; // planned has one entry per package (≥ 1)
    const id = `${lead.package}@${lead.proposedVersion}`;
    if (existsSync(this.path(id))) throw new ReleaseError("busy", `a release record for ${id} already exists`);
    const rec: ReleaseRecord = {
      schemaVersion: 1, id, planDigest: planDigestOf(plan), plan, state: "awaiting-approval", approval: null,
      facts: { releaseCommit: null, build: null, tags: [], published: [], registryVerification: [], githubRelease: null },
      failure: null,
      history: [
        { at: now, state: "proposed", note: `${req.bump} release requested by ${req.requestedBy}` },
        { at: now, state: "validated", note: `source ${source.slice(0, 12)} on ${branch}; versions free on the registry; tags free` },
        { at: now, state: "awaiting-approval", note: `approvers: ${plan.approvers.join(", ")}` },
      ],
      attempts: [],
    };
    await mkdir(join(this.d.runtimeDir, "files", id), { recursive: true });
    await writeFile(join(this.d.runtimeDir, "files", id, "files.json"), JSON.stringify(files)); // edited file contents (derivable; not committed)
    await this.#save(rec);
    return rec;
  }

  // ───────── approval ─────────
  async approve(id: string, approver: string, planDigest: string): Promise<ReleaseRecord> {
    const r = await this.load(id);
    if (r.state !== "awaiting-approval") throw new ReleaseError("not-allowed", `release ${id} is ${r.state}, not awaiting approval`);
    if (!r.plan.approvers.includes(approver)) throw new ReleaseError("not-allowed", `${approver} may not approve ${id} (approvers: ${r.plan.approvers.join(", ")})`);
    if (planDigest !== r.planDigest || planDigestOf(r.plan) !== r.planDigest) throw new ReleaseError("not-allowed", "the approval names a different plan than the one recorded");
    const at = this.d.now();
    r.approval = { approver, at, planDigest, revoked: null };
    this.#to(r, "approved", `approved by ${approver} for plan ${planDigest.slice(0, 12)}`);
    await this.#save(r);
    return r;
  }

  async revoke(id: string, by: string, reason: string): Promise<ReleaseRecord> {
    const r = await this.load(id);
    if (ORDER.indexOf(r.state) >= ORDER.indexOf("published") || TERMINAL.includes(r.state)) throw new ReleaseError("not-allowed", `release ${id} is ${r.state}; a publication cannot be revoked`);
    if (r.approval) r.approval.revoked = { by, at: this.d.now(), reason };
    this.#to(r, "cancelled", `revoked by ${by}: ${reason}${r.facts.tags.length ? ` (tag ${r.facts.tags.map((t) => t.name).join(", ")} remains; tags are never moved or deleted)` : ""}`);
    await this.#save(r);
    return r;
  }

  // ───────── execution ─────────
  async execute(id: string): Promise<ReleaseRecord> {
    let r = await this.load(id);
    return this.#locked(r.plan.packages.map((p) => p.package), async () => {
      r = await this.load(id); // re-read under the lock
      if (TERMINAL.includes(r.state)) return r;
      if (r.failure && !r.failure.recoverable) return r;
      if (r.failure) { r.attempts.push({ at: this.d.now(), step: "resume", outcome: "done", detail: `resuming at ${r.state} after: ${r.failure.reason}` }); r.failure = null; }
      const steps: Partial<Record<ReleaseState, () => Promise<void>>> = {
        approved: () => this.#prepare(r), prepared: () => this.#build(r), built: () => this.#tag(r),
        tagged: () => this.#publish(r), published: () => this.#verify(r), "registry-verified": () => this.#githubRelease(r),
      };
      while (steps[r.state]) {
        try {
          this.#checkAuthority(r);
          await steps[r.state]!();
        } catch (e) {
          const b = e instanceof Blocked ? e : e instanceof Unavailable ? new Blocked((e as Error).message, true) : new Blocked((e as Error).message, false);
          r.attempts.push({ at: this.d.now(), step: r.state, outcome: b.recoverable ? "failed" : "refused", detail: b.message });
          r.failure = { at: r.state, reason: b.message, recoverable: b.recoverable, when: this.d.now() };
          if (!b.recoverable) this.#to(r, b.terminal, b.message);
          await this.#save(r);
          return r;
        }
        await this.#save(r);
      }
      return r;
    });
  }

  #checkAuthority(r: ReleaseRecord) {
    if (ORDER.indexOf(r.state) >= ORDER.indexOf("published")) return; // after publication only verification remains
    if (!r.approval) throw new Blocked("not approved", false, "cancelled");
    if (r.approval.revoked) throw new Blocked(`approval revoked by ${r.approval.revoked.by}`, false, "cancelled");
    if (r.approval.planDigest !== r.planDigest || planDigestOf(r.plan) !== r.planDigest) throw new Blocked("the plan no longer matches what was approved", false);
  }

  #to(r: ReleaseRecord, state: ReleaseState, note: string) { r.state = state; r.history.push({ at: this.d.now(), state, note }); }
  #did(r: ReleaseRecord, step: string, outcome: "done" | "already-done", detail: string) { r.attempts.push({ at: this.d.now(), step, outcome, detail }); }

  /** approved → prepared: the release commit, deterministic, fast-forwarded onto the branch. */
  async #prepare(r: ReleaseRecord) {
    const p = r.plan;
    const git = this.d.git(p.repository);
    const files = JSON.parse(await readFile(join(this.d.runtimeDir, "files", r.id, "files.json"), "utf8").catch(async () => JSON.stringify(await this.#rederive(r))));
    const at = r.approval!.at;
    // Deterministic (fixed dates from the approval): recomputing it after a crash yields the identical sha.
    const commit = Object.keys(files).length ? await git.makeCommit(p.sourceCommit, files, p.releaseCommit.message, at) : p.sourceCommit;
    const tags = await git.tags();
    for (const pp of p.packages) {
      const st = await this.#pkgRegistry(pp.package).state(pp.name);
      const highest = (st?.versions ?? []).filter((v) => semver.valid(v)).sort(semver.rcompare)[0] ?? null;
      // The version on the registry is OURS only if its tag already points at this release's exact commit
      // (a crash after publishing lost the record's later facts). Anything else is someone else's release.
      const ours = tags.get(pp.tag) === commit;
      if (st?.versions.includes(pp.proposedVersion) && !ours) throw new Blocked(`${pp.name}@${pp.proposedVersion} appeared on the registry after approval; a new plan is needed`, false, "superseded");
      if (highest !== pp.registryVersions.highest && !(ours && highest === pp.proposedVersion)) throw new Blocked(`${pp.name}: the registry moved since the plan (${pp.registryVersions.highest} → ${highest}); a new plan is needed`, false, "superseded");
      if (ours) this.#did(r, "reconcile", "already-done", `${pp.tag} already points at the release commit: this release progressed before its record was saved`);
    }
    const head = await git.head(p.branch);
    if (head === commit) this.#did(r, "release-commit", "already-done", `${p.branch} is already at the release commit ${commit.slice(0, 12)}`);
    else if (head === p.sourceCommit) {
      if (commit !== p.sourceCommit) {
        try { await git.pushBranch(p.branch, commit, p.sourceCommit); }
        catch (e) { if (e instanceof Refused) throw new Blocked(`${p.branch} moved while releasing; a new plan is needed`, false, "superseded"); throw e; }
      }
      this.#did(r, "release-commit", "done", `${commit.slice(0, 12)} on ${p.branch} (${p.releaseCommit.files.join(", ") || "no file changes"})`);
    } else if (head && commit !== p.sourceCommit && (await git.isAncestor(commit, head))) {
      this.#did(r, "release-commit", "already-done", `release commit ${commit.slice(0, 12)} is already in ${p.branch} history`);
    } else throw new Blocked(`${p.branch} is at ${head?.slice(0, 12)}, not the approved ${p.sourceCommit.slice(0, 12)}: the repository changed after approval; a new plan is needed`, false, "superseded");
    r.facts.releaseCommit = commit;
    this.#to(r, "prepared", `release commit ${commit.slice(0, 12)}`);
  }

  async #rederive(r: ReleaseRecord): Promise<Record<string, string>> {
    return releaseFiles(this.d.git(r.plan.repository), r.plan.sourceCommit, r.plan.packages, r.plan.releaseCommit.pins);
  }

  /** prepared → built: Boundry CI builds/tests/packs the exact release commit; the artifact is verified here. */
  async #build(r: ReleaseRecord) {
    const p = r.plan;
    const n = r.attempts.filter((a) => a.step === "build" && a.outcome === "failed").length + 1;
    const recipe = buildRecipe(r);
    const { runId, duplicate } = await this.d.executor.submit({ requestId: `${r.id}/${r.planDigest.slice(0, 12)}/build-${n}`, repository: p.repository, commit: r.facts.releaseCommit!, branch: p.branch, recipe });
    const until = Date.now() + this.d.buildTimeoutMs;
    let st = await this.d.executor.status(runId);
    while (st.state === "running" && Date.now() < until) { await new Promise((res) => setTimeout(res, this.d.pollMs)); st = await this.d.executor.status(runId); }
    if (st.state === "running") throw new Blocked(`build ${runId} still running after ${this.d.buildTimeoutMs / 1000}s; execute again to keep waiting`, true);
    if (st.state !== "succeeded") {
      r.attempts.push({ at: this.d.now(), step: "build", outcome: "failed", detail: `${runId}: ${st.jobs.filter((j) => j.state !== "succeeded").map((j) => `${j.key}=${j.state}${j.reason ? ` (${j.reason})` : ""}`).join(", ")}` });
      throw new Blocked(`release build ${runId} ${st.state}; nothing was tagged or published`, true);
    }
    const pkg = await this.d.executor.artifact(runId, "step-package", "package.tar");
    if (sha256(pkg.bytes) !== pkg.sha256) throw new Blocked("package.tar does not match its digest", false);
    const work = await mkdtemp(join(tmpdir(), "boundry-release-"));
    try {
      await writeFile(join(work, "package.tar"), pkg.bytes);
      await pexec("tar", ["-xf", join(work, "package.tar"), "-C", work]);
      const artifacts: NonNullable<ReleaseRecord["facts"]["build"]>["artifacts"] = [];
      for (const pp of p.packages) {
        const file = tgzName(pp.name, pp.proposedVersion);
        const bytes = await readFile(join(work, file)).catch(() => { throw new Blocked(`the build did not produce ${file}`, false); });
        const inner = JSON.parse((await pexec("tar", ["-xzOf", join(work, file), "package/package.json"])).stdout);
        if (inner.name !== pp.name || inner.version !== pp.proposedVersion) throw new Blocked(`${file} contains ${inner.name}@${inner.version}, not ${pp.name}@${pp.proposedVersion}`, false);
        const digest = sha256(bytes);
        await mkdir(join(this.d.runtimeDir, "artifacts"), { recursive: true });
        await writeFile(join(this.d.runtimeDir, "artifacts", `${digest}.tgz`), bytes);
        artifacts.push({ package: pp.package, file, sha256: digest, sha512Integrity: integrity(bytes), size: bytes.length });
      }
      r.facts.build = { system: "boundry-ci", runId, evidenceUrl: st.evidenceUrl, artifacts, container: { name: "package.tar", sha256: pkg.sha256 } };
      this.#did(r, "build", duplicate ? "already-done" : "done", `${runId}: ${artifacts.map((a) => `${a.file} sha256:${a.sha256.slice(0, 16)}`).join(", ")}`);
      this.#to(r, "built", `built by ${runId} from ${r.facts.releaseCommit!.slice(0, 12)}`);
    } finally { await rm(work, { recursive: true, force: true }); }
  }

  /** built → tagged: one tag per package on the release commit. Existing tags are never moved. */
  async #tag(r: ReleaseRecord) {
    const git = this.d.git(r.plan.repository);
    const commit = r.facts.releaseCommit!;
    for (const pp of r.plan.packages) {
      if (r.facts.tags.some((t) => t.name === pp.tag)) continue;
      const existing = (await git.tags()).get(pp.tag);
      if (existing && existing !== commit) throw new Blocked(`tag ${pp.tag} already points at ${existing.slice(0, 12)}, not the release commit ${commit.slice(0, 12)}; tags are never moved`, false);
      if (existing) this.#did(r, "tag", "already-done", `${pp.tag} → ${commit.slice(0, 12)}`);
      else {
        try { await git.pushTag(pp.tag, commit, `${pp.name} ${pp.proposedVersion}\n\nartifact sha256:${r.facts.build!.artifacts.find((a) => a.package === pp.package)!.sha256}`, r.approval!.at); }
        catch (e) { if (e instanceof Refused) { const t = (await git.tags()).get(pp.tag); if (t !== commit) throw new Blocked(`tag ${pp.tag} appeared pointing at ${t?.slice(0, 12)}`, false); } else throw e; }
        const target = (await git.tags()).get(pp.tag);
        if (target !== commit) throw new Blocked(`tag ${pp.tag} resolves to ${target?.slice(0, 12)}, expected ${commit.slice(0, 12)}`, false);
        this.#did(r, "tag", "done", `${pp.tag} → ${commit.slice(0, 12)} (verified)`);
      }
      r.facts.tags.push({ name: pp.tag, target: commit });
    }
    this.#to(r, "tagged", r.facts.tags.map((t) => t.name).join(", "));
  }

  /** tagged → published: inspect the registry first; publish exactly the built bytes. */
  async #publish(r: ReleaseRecord) {
    for (const pp of r.plan.packages) {
      if (r.facts.published.some((x) => x.package === pp.package)) continue;
      const art = r.facts.build!.artifacts.find((a) => a.package === pp.package)!;
      const reg = this.#pkgRegistry(pp.package);
      const existing = await reg.version(pp.name, pp.proposedVersion);
      if (existing) {
        if (existing.integrity !== art.sha512Integrity) throw new Blocked(`${pp.name}@${pp.proposedVersion} is on the registry with a DIFFERENT artifact (${existing.integrity?.slice(0, 20)}…); a published version is never overwritten`, false);
        r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.sha512Integrity, alreadyPresent: true });
        this.#did(r, "publish", "already-done", `${pp.name}@${pp.proposedVersion} already on the registry with the built integrity`);
        continue;
      }
      const st = await reg.state(pp.name);
      const highest = (st?.versions ?? []).filter((v) => semver.valid(v)).sort(semver.rcompare)[0] ?? null;
      if (highest !== pp.registryVersions.highest) throw new Blocked(`${pp.name}: a newer version (${highest}) appeared on the registry after approval; publishing ${pp.proposedVersion} now would not be the release that was approved`, false, "superseded");
      const file = join(this.d.runtimeDir, "artifacts", `${art.sha256}.tgz`);
      const bytes = await readFile(file).catch(async () => {
        const again = await this.d.executor.artifact(r.facts.build!.runId, "step-package", "package.tar"); // durable copy in Boundry CI
        void again; throw new Blocked("built tarball missing from the runtime directory; re-run to fetch it again", true);
      });
      if (sha256(bytes) !== art.sha256) throw new Blocked("the tarball about to be published does not match the built digest", false);
      try { await reg.publish(file, pp.distTag); }
      catch (e) {
        // The response may have been lost after the registry accepted it: ask the registry, never assume.
        const after = await reg.version(pp.name, pp.proposedVersion).catch(() => null);
        if (after?.integrity === art.sha512Integrity) { r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.sha512Integrity, alreadyPresent: true }); this.#did(r, "publish", "already-done", `publish reported "${(e as Error).message}", but the registry has the exact artifact`); continue; }
        if (e instanceof Refused && after) throw new Blocked(`registry refused: ${pp.name}@${pp.proposedVersion} exists with a different artifact`, false);
        throw e instanceof Unavailable ? e : new Blocked(`publish failed: ${(e as Error).message}`, !(e instanceof Refused));
      }
      r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.sha512Integrity, alreadyPresent: false });
      this.#did(r, "publish", "done", `${pp.name}@${pp.proposedVersion} → ${reg.url} (dist-tag ${pp.distTag})`);
    }
    this.#to(r, "published", "registry accepted every artifact");
  }

  /** published → registry-verified: the registry serves the version, its integrity, and the same bytes. */
  async #verify(r: ReleaseRecord) {
    r.facts.registryVerification = [];
    for (const pp of r.plan.packages) {
      const art = r.facts.build!.artifacts.find((a) => a.package === pp.package)!;
      const reg = this.#pkgRegistry(pp.package);
      const v = await reg.version(pp.name, pp.proposedVersion);
      if (!v) throw new Blocked(`${pp.name}@${pp.proposedVersion} is not (yet) visible on the registry`, true);
      if (v.integrity !== art.sha512Integrity) throw new Blocked(`${pp.name}@${pp.proposedVersion}: registry integrity ${v.integrity?.slice(0, 20)}… differs from the built artifact`, false);
      const bytes = await reg.download(v.tarball!);
      if (sha256(bytes) !== art.sha256) throw new Blocked(`${pp.name}@${pp.proposedVersion}: the tarball the registry serves differs from the built artifact`, false);
      const st = await reg.state(pp.name);
      r.facts.registryVerification.push({ package: pp.package, version: pp.proposedVersion, integrity: v.integrity!, tarballSha256: sha256(bytes), distTagPointsHere: st?.distTags[pp.distTag] === pp.proposedVersion, at: this.d.now() });
    }
    this.#did(r, "verify-registry", "done", r.facts.registryVerification.map((v) => `${v.version} integrity+bytes match; ${v.distTagPointsHere ? "dist-tag points here" : "dist-tag does NOT point here"}`).join("; "));
    this.#to(r, "registry-verified", "registry serves the exact artifact");
  }

  /** registry-verified → released: GitHub release for the tag (if required). */
  async #githubRelease(r: ReleaseRecord) {
    if (r.plan.githubRelease) {
      const pp = r.plan.packages[0]!; // ReleasePlan.packages is min(1)
      const existing = await this.d.releases.find(r.plan.repository, pp.tag);
      if (existing) {
        if (existing.tag !== pp.tag) throw new Blocked(`GitHub release found for ${existing.tag}, expected ${pp.tag}`, false);
        r.facts.githubRelease = { url: existing.url, tag: pp.tag, alreadyPresent: true };
        this.#did(r, "github-release", "already-done", existing.url);
      } else {
        const body = await this.#notes(r);
        const created = await this.d.releases.create(r.plan.repository, { tag: pp.tag, name: r.plan.packages.map((x) => `${x.name} ${x.proposedVersion}`).join(", "), body, prerelease: !!semver.prerelease(pp.proposedVersion) });
        r.facts.githubRelease = { url: created.url, tag: pp.tag, alreadyPresent: false };
        this.#did(r, "github-release", "done", created.url);
      }
    } else this.#did(r, "github-release", "already-done", "skipped: the release policy does not create GitHub releases");
    this.#to(r, "released", `${r.plan.packages.map((p) => `${p.name}@${p.proposedVersion}`).join(", ")} released and verified`);
  }

  async #notes(r: ReleaseRecord): Promise<string> {
    const git = this.d.git(r.plan.repository);
    const L = ["Released by Boundry Maintenance.", ""];
    for (const pp of r.plan.packages) {
      const art = r.facts.build!.artifacts.find((a) => a.package === pp.package)!;
      L.push(`### ${pp.name} ${pp.proposedVersion}`, "", `- Commit: ${r.facts.releaseCommit} (from ${r.plan.sourceCommit.slice(0, 12)})`, `- Artifact: \`${art.file}\` sha256 \`${art.sha256}\``, `- Registry integrity: \`${art.sha512Integrity}\``, `- Built and tested by Boundry CI run \`${r.facts.build!.runId}\``, "");
      const changes = await git.log(`${r.plan.sourceCommit}`, pp.directory, 15);
      if (changes.length) L.push("Recent changes in this package:", ...changes.map((c) => `- ${c}`), "");
    }
    L.push("Why this version:", ...r.plan.decision.map((d) => `- ${d}`));
    return L.join("\n");
  }

  #pkgRegistry(id: string) { return this.d.registry(this.d.catalog.find((c) => c.id === id)!); }

  async #locked<T>(ids: string[], f: () => Promise<T>): Promise<T> {
    const dirs = ids.sort().map((id) => join(this.d.runtimeDir, "locks", id));
    await mkdir(join(this.d.runtimeDir, "locks"), { recursive: true });
    const held: string[] = [];
    try {
      for (const d of dirs) {
        try { await mkdir(d); }
        catch {
          const pid = Number(await readFile(join(d, "pid"), "utf8").catch(() => "0"));
          if (pid && alive(pid)) throw new ReleaseError("busy", `another release execution holds ${d.split("/").pop()} (pid ${pid})`);
          await rm(d, { recursive: true, force: true }); await mkdir(d);
        }
        await writeFile(join(d, "pid"), String(process.pid));
        held.push(d);
      }
      return await f();
    } finally { for (const d of held) await rm(d, { recursive: true, force: true }); }
  }
}

/** The release commit's files, derived only from the source commit and the plan (plan time and recovery agree). */
export async function releaseFiles(git: GitAuthority, source: string, planned: ReleasePlan["packages"], pins: ReleasePlan["releaseCommit"]["pins"]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const dirs = [...new Set([...planned.map((p) => p.directory), ...pins.map((p) => p.in)])].sort();
  for (const d of dirs) {
    const path = d === "." ? "package.json" : `${d}/package.json`;
    const text = await git.read(source, path);
    if (!text) throw new Error(`${path} not found at ${source.slice(0, 12)}`);
    const version = planned.find((p) => p.directory === d)?.proposedVersion ?? null;
    const next = editPackageJson(text, version, Object.fromEntries(pins.filter((p) => p.in === d).map((p) => [p.dependency, p.to])));
    if (next !== text) files[path] = next;
  }
  const lock = await git.read(source, "package-lock.json");
  if (lock) {
    const pinMap: Record<string, Record<string, string>> = {};
    for (const p of pins) (pinMap[p.in] ??= {})[p.dependency] = p.to;
    const next = editPackageLock(lock, Object.fromEntries(planned.map((p) => [p.directory, p.proposedVersion])), pinMap);
    if (next !== lock) files["package-lock.json"] = next;
  }
  return files;
}

/** The Boundry Recipe Maintenance hands to the execution substrate for a release build. */
export function buildRecipe(r: ReleaseRecord): { path: string; source: string } {
  const names = r.plan.packages.map((p) => `${p.name} ${p.proposedVersion}`).join(", ");
  const L = [`# Release build: ${names}`, "", `Build${r.plan.validation.includes("test") ? ", test" : ""} and package release commit ${r.facts.releaseCommit} for Boundry Maintenance release ${r.id}.`, "", "## When this happens", "- I start it.", ""];
  if (r.plan.validation.includes("test")) L.push("## Make sure", "- The tests pass.", "");
  L.push("## Steps", "1. Package the result.", "", "## Keep", ...(r.plan.validation.includes("test") ? ["- The test results."] : []), "- The package for 3650 days.", "- The release evidence.");
  return { path: ".boundry/recipes/boundry-release.md", source: L.join("\n") + "\n" };
}

function splitId(id: string): [string, string] { const i = id.lastIndexOf("@"); return [id.slice(0, i), id.slice(i + 1)]; }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
export { stableJson };
