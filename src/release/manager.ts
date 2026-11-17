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
import { ReleaseRecord, ReleasePolicy, type EvidenceRecord, type Principal, type PackageConfig, type ReleaseBump, type ReleasePlan, type ReleaseState, type Installation, type ValidationResult, type Dependent } from "../contracts.ts";
import { writeAllAtomic, stableJson } from "../lib/files.ts";
import { withLocks, LockHeld } from "../lib/lock.ts";
import { allocate, tagFor, AllocationError } from "./version.ts";
import { ecosystemFor, type Ecosystem } from "./ecosystems.ts";
import { installKey } from "../status/project.ts";
import { CONTRACT_VERSION, authorize, can, decide, counted, principal, requiredApprovals, GovernanceError, type Subject } from "../governance/rules.ts";
import { approvalStatement, verifyApproval } from "../governance/signatures.ts";
import { Unavailable, Refused, type RegistryAdapter, type RegistryState, type GitAuthority, type ReleasesAdapter, type Executor } from "./adapters.ts";

const pexec = promisify(execFile);
const TERMINAL: ReleaseState[] = ["released", "failed", "cancelled", "superseded", "abandoned"];
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
  /** config/principals.json: who may propose, approve and trigger (docs/architecture/control-plane.md). */
  principals: Principal[];
  /** The component principal that performs releases (governance contract §8). */
  executorPrincipal?: string;
  /** Registry URLs explicitly declared as test registries. Every other destination is production. */
  testRegistries?: string[];
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

export class ReleaseManager {
  readonly d: Required<Omit<ManagerDeps, "installations">> & { installations: Installation[] };
  constructor(deps: ManagerDeps) {
    this.d = { installations: [], executorPrincipal: "component:release-executor", testRegistries: [], now: () => new Date().toISOString(), buildTimeoutMs: 30 * 60_000, pollMs: 2_000, ...deps } as any;
  }

  path(id: string) { const [pkg, version] = splitId(id); return join(this.d.dataDir, "release-manager", pkg, `${version}.json`); }
  async load(id: string): Promise<ReleaseRecord> { return ReleaseRecord.parse(JSON.parse(await readFile(this.path(id), "utf8"))); }
  async #save(r: ReleaseRecord) {
    if (r.schemaVersion === 2) {
      // Not silent: the upgrade and any inferred claim are written into the record's own history.
      const claim = claimOf(r);
      r.schemaVersion = 3;
      if (!r.claim && claim) r.claim = claim;
      r.history.push({ at: this.d.now(), state: r.state, note: `record schema 2 → 3 (governance contract 1.2.0)${claim ? `: claim inferred from history (${claim.triggeredBy ? `first execution attempt at ${claim.at}` : `state ${r.state}`})` : ": not claimed"}` });
    }
    await writeAllAtomic({ [this.path(r.id)]: ReleaseRecord.parse(r) });
  }
  async list(): Promise<ReleaseRecord[]> {
    const base = join(this.d.dataDir, "release-manager");
    const out: ReleaseRecord[] = [];
    for (const pkg of existsSync(base) ? (await readdir(base)).sort() : []) for (const f of (await readdir(join(base, pkg))).sort()) out.push(ReleaseRecord.parse(JSON.parse(await readFile(join(base, pkg, f), "utf8"))));
    return out;
  }

  // ───────── plan ─────────
  async plan(req: PlanRequest): Promise<ReleaseRecord> {
    // Under the packages' locks: two concurrent requests can never both record a plan (the second is busy).
    return this.#locked([...new Set(req.packages)], () => this.#plan(req));
  }
  async #plan(req: PlanRequest): Promise<ReleaseRecord> {
    const proposer = this.#principal(req.requestedBy);
    this.#gov(() => authorize(proposer, "releases.propose"));
    const pkgs = req.packages.map((id) => {
      const p = this.d.catalog.find((c) => c.id === id);
      if (!p) throw new ReleaseError("invalid", `unknown package ${id}`);
      if (p.ownership !== "owned") throw new ReleaseError("not-allowed", `${p.name} is ${p.ownership}, not owned: Boundry only releases owned packages`);
      if (!p.release) throw new ReleaseError("not-allowed", `${p.name} has no release policy in config/packages.json; releases are disabled for it`);
      if (!p.repository) throw new ReleaseError("invalid", `${p.name} has no repository`);
      return p as PackageConfig & { release: ReleasePolicy; repository: string };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const first = pkgs[0];
    if (!first) throw new ReleaseError("invalid", "a release needs at least one package");
    const repo = first.repository;
    if (pkgs.some((p) => p.repository !== repo)) throw new ReleaseError("invalid", "packages released together must share one repository (one release commit)");
    if (pkgs.some((p) => p.registry !== first.registry)) throw new ReleaseError("invalid", "packages released together must go to one registry kind (npm or crates)");
    const branch = first.release.branch;
    if (pkgs.some((p) => p.release.branch !== branch)) throw new ReleaseError("invalid", "packages released together must share a release branch");
    // Abandoned predecessors (contract §7a): a replacement needs their reconciliation, and never reuses a version
    // they claimed (its commit, tag or publication may be real).
    const reserved: Record<string, { version: string; why: string }[]> = {};
    for (const r of await this.list()) {
      if (!TERMINAL.includes(r.state) && r.plan.packages.some((x) => pkgs.some((p) => p.id === x.package))) throw new ReleaseError("busy", `release ${r.id} is ${r.state}; finish, abandon or cancel it first`);
      if (r.state !== "abandoned") continue;
      for (const pp of r.plan.packages.filter((x) => pkgs.some((p) => p.id === x.package))) {
        const d = decide("propose", proposer, undefined, undefined, { predecessor: { state: "abandoned", reconciled: !!r.abandonment?.reconciliation } });
        if (!d.allow) throw new ReleaseError("not-allowed", `${pp.name}: abandoned release ${r.id}: ${d.message} [${d.code}]`);
        (reserved[pp.package] ??= []).push({ version: pp.proposedVersion, why: `claimed by abandoned release ${r.id}` });
      }
    }
    const eco = ecosystemFor(first.registry);
    const git = this.d.git(repo);
    const source = await git.head(branch);
    if (!source) throw new ReleaseError("invalid", `${repo} has no branch ${branch}`);
    const tags = [...(await git.tags()).keys()];
    const now = this.d.now();
    const rootText = await git.read(source, eco.manifestPath("."));
    const lockText = await git.read(source, eco.lockfile);
    const checks: ValidationResult[] = [];
    const unknowns: string[] = [];
    const check = (c: string, outcome: ValidationResult["outcome"], detail: string) => checks.push({ check: c, outcome, detail });
    const decision: string[] = [];
    const planned: ReleasePlan["packages"] = [];

    for (const p of pkgs) {
      const dir = p.directory ?? ".";
      const manifestPath = eco.manifestPath(dir);
      const manifestText = await git.read(source, manifestPath);
      if (!manifestText) throw new ReleaseError("invalid", `${p.name}: ${manifestPath} not found at ${source.slice(0, 12)}`);
      const m = eco.readManifest(manifestText, rootText);
      if (m.name !== p.name) throw new ReleaseError("invalid", `${manifestPath} is "${m.name}", but the catalog says ${p.name}`);
      check(`${p.name}: publishable`, m.unpublishable ? "failed" : "passed", m.unpublishable ? `${manifestPath} marks it unpublishable (${eco.id === "npm" ? '"private": true' : "publish = false"})` : `${manifestPath} allows publishing`);
      const reg = this.d.registry(p);
      let st: RegistryState | null;
      try { st = await reg.state(p.name); }
      catch (e) { check(`${p.name}: registry`, "unavailable", (e as Error).message); throw new ReleaseError("invalid", `cannot plan without the registry: ${(e as Error).message}`); }
      check(`${p.name}: registry`, "passed", `${reg.url} answered: ${st ? `${st.versions.length} version(s) ever published${st.yanked.length ? `, ${st.yanked.length} yanked (${st.yanked.join(", ")})` : ""}` : "never published"}`);
      if (lockText) {
        const locked = eco.lockedVersion(lockText, dir, p.name);
        if (locked === null) check(`${p.name}: manifest and ${eco.lockfile} agree`, "unavailable", `${eco.lockfile} has no single local entry for ${p.name}`);
        else check(`${p.name}: manifest and ${eco.lockfile} agree`, locked === m.version ? "passed" : "failed", locked === m.version ? `both say ${m.version}` : `${manifestPath} declares ${m.version} but ${eco.lockfile} records ${locked}: the lockfile is stale or the manifest was edited without it; fix the repository first`);
      } else check(`${p.name}: manifest and lockfile agree`, "not-applicable", `no ${eco.lockfile} at the source commit`);
      let alloc;
      try { alloc = allocate(p.name, { published: st?.versions ?? [], repositoryVersion: m.version, tags, yanked: st?.yanked ?? [], reserved: reserved[p.id] ?? [] }, req.bump, p.release); }
      catch (e) { if (e instanceof AllocationError) throw new ReleaseError(e.kind === "collision" ? "collision" : e.kind === "decision" ? "decision" : "not-allowed", e.message); throw e; }
      decision.push(...alloc.explanation);
      check(`${p.name}: version ${alloc.version} free`, "passed", `not on the registry (yanked versions included) and tag ${alloc.tag} does not exist`);
      const highest = (st?.versions ?? []).filter((v) => semver.valid(v)).sort(semver.rcompare)[0] ?? null;
      planned.push({
        package: p.id, name: p.name, registry: p.registry, directory: dir,
        registryVersions: { count: st?.versions.length ?? 0, highest, latestTag: st?.distTags.latest ?? null, yanked: [...(st?.yanked ?? [])].sort(), observedAt: now },
        inherited: m.inherited,
        repositoryVersion: m.version, proposedVersion: alloc.version, tag: alloc.tag,
        distTag: semver.prerelease(alloc.version) ? "next" : p.release.distTag, destination: reg.url, production: !this.d.testRegistries.map(norm).includes(norm(reg.url)),
      });
    }

    // Cargo: a version inherited from [workspace.package] is one version for every crate that inherits it.
    const mustJoin: string[] = [];
    const members = await workspaceMembers(git, source, eco, rootText);
    if (planned.some((p) => p.inherited)) {
      const versions = [...new Set(planned.filter((p) => p.inherited).map((p) => p.proposedVersion))];
      if (versions.length > 1) throw new ReleaseError("decision", `these crates inherit one workspace version, but their registries put them at different next versions (${planned.filter((p) => p.inherited).map((p) => `${p.name} → ${p.proposedVersion}`).join(", ")}). Choose one version deliberately (bump "repository" after setting [workspace.package] version), Boundry will not pick one`);
      for (const d of members) {
        const text = await git.read(source, eco.manifestPath(d));
        const mm = text ? eco.readManifest(text, rootText) : null;
        if (mm?.inherited && !mm.unpublishable && !planned.some((p) => p.directory === d)) {
          const id = this.d.catalog.find((c) => c.name === mm.name && c.registry === first.registry)?.id ?? mm.name;
          mustJoin.push(`${mm.name} (${d}) also inherits [workspace.package] version ${planned.find((p) => p.inherited)!.repositoryVersion}; bumping it changes this crate's version too → add --package ${id}, or give it its own version`);
        }
      }
      check("workspace version inheritance", mustJoin.length ? "failed" : "passed", mustJoin.length ? `${mustJoin.length} other publishable crate(s) inherit the same version` : "every publishable crate that inherits the workspace version is in this release");
    } else check("workspace version inheritance", "not-applicable", "no released package inherits its version");

    const impact = await this.#impact(git, source, eco, rootText, lockText, members, planned, repo);
    mustJoin.push(...impact.mustJoin);
    check("workspace install after the release commit", impact.mustJoin.length ? "failed" : "passed", impact.mustJoin.length ? `${impact.mustJoin.length} sibling requirement(s) would not accept the new version` : `${impact.pins.length ? `${impact.pins.length} in-plan requirement(s) rewritten; ` : ""}every workspace sibling's requirement accepts the new version(s)`);
    check("build and tests", "deferred", `run by Boundry CI on the exact release commit after approval (${first.release.validation.join(", ") || "build only"}); nothing is tagged or published unless they pass`);
    check("registry acceptance", "deferred", "the registry decides ownership, name and metadata at publish; a refusal stops the release before anything else is published");
    check("consumer verification", "deferred", "a consumer's own checks on the new version are recorded after release (release consumers), never assumed");
    if (!this.d.installations.length) { check("external consumers", "unavailable", "no installations data (run a scan): consumers in other repositories are unknown"); unknowns.push("Consumers in other repositories: no scan data was available."); }
    else check("external consumers", "passed", `${impact.dependents.filter((d) => !d.where.startsWith(`${repo}:`)).length} external dependent manifest(s) from the latest scan`);
    unknowns.push("Undeclared consumers (anything that installs these packages without appearing in Maintenance's scan) are not visible.");

    const failed = checks.filter((c) => c.outcome === "failed");
    if (mustJoin.length || failed.length) {
      const detail = [...new Set(mustJoin)].map((x) => `  - ${x}`).join("\n");
      throw new ReleaseError("decision", `the release cannot be planned as requested:\n${failed.map((c) => `  ✗ ${c.check}: ${c.detail}`).join("\n")}${detail ? `\nRelease these together (Boundry never adds packages to a release on its own):\n${detail}` : ""}`);
    }
    const files = await eco.editFiles((path) => git.read(source, path), planned, impact.pins);
    if (impact.dependents.length) decision.push(`${impact.dependents.length} dependent manifest(s) found; none is changed or published by this release (see dependents and, after release, the downstream proposals).`);

    const policy = first.release;
    const plan: ReleasePlan = {
      repository: repo, branch, sourceCommit: source, bump: req.bump, requestedBy: req.requestedBy, requestedByType: proposer.type, requestedAt: now, reason: req.reason ?? null,
      packages: planned, decision, dependents: impact.dependents,
      checks, unknowns, impactFingerprint: (await this.#facts(repo, branch, planned)).fingerprint,
      releaseCommit: { message: `Release ${planned.map((p) => `${p.name}@${p.proposedVersion}`).join(", ")}`, files: Object.keys(files).sort(), pins: impact.pins },
      validation: [...policy.validation], githubRelease: pkgs.every((p) => p.release.githubRelease),
      approvers: [...new Set(pkgs.flatMap((p) => p.release.approvers))].filter((a) => pkgs.every((p) => p.release.approvers.includes(a))).sort(),
      requiredApprovals: requiredFor(pkgs), protected: pkgs.some((p) => p.release.protected),
    };
    if (!plan.approvers.length) throw new ReleaseError("not-allowed", "no person may approve every package in this release");
    const able = plan.approvers.filter((a) => a !== proposer.id && this.d.principals.some((x) => x.id === a && x.type === "person" && can(x, plan.protected ? "approve.protected" : "approve")));
    if (able.length < plan.requiredApprovals) throw new ReleaseError("not-allowed", `this release needs ${plan.requiredApprovals} approval(s) from people other than ${proposer.id}, but only ${able.length} eligible approver(s) exist (${able.join(", ") || "none"}): it could never be approved`);
    const lead = planned[0]!; // planned has one entry per package (≥ 1)
    const id = `${lead.package}@${lead.proposedVersion}`;
    if (existsSync(this.path(id))) throw new ReleaseError("busy", `a release record for ${id} already exists`);
    const rec: ReleaseRecord = {
      schemaVersion: 3, id, planDigest: planDigestOf(plan), plan, state: "awaiting-approval", approvals: [], revocation: null, claim: null, abandonment: null,
      facts: { releaseCommit: null, build: null, tags: [], published: [], registryVerification: [], githubReleases: [] },
      failure: null,
      history: [
        { at: now, state: "proposed", note: `${req.bump} release proposed by ${req.requestedBy} (${proposer.type})` },
        { at: now, state: "validated", note: checks.map((c) => `${c.outcome}: ${c.check}`).join("; ") },
        { at: now, state: "awaiting-approval", note: `needs ${plan.requiredApprovals} approval(s)${plan.protected ? " from prod approvers" : ""}; eligible: ${able.join(", ")}` },
      ],
      attempts: [], downstream: [], consumers: [],
    };
    await mkdir(join(this.d.runtimeDir, "files", id), { recursive: true });
    await writeFile(join(this.d.runtimeDir, "files", id, "files.json"), JSON.stringify(files)); // edited file contents (derivable; not committed)
    await this.#save(rec);
    return rec;
  }

  /**
   * Who depends on the released packages, and how: workspace siblings at the source commit (whose requirements
   * must accept the new version, or be rewritten when they are released together) and external consumers from
   * Maintenance's scan. Declared requirement and resolved version are separate facts.
   */
  async #impact(git: GitAuthority, source: string, eco: Ecosystem, rootText: string | null, lockText: string | null, members: string[], planned: ReleasePlan["packages"], repo: string) {
    const dependents: Dependent[] = [];
    const pins: ReleasePlan["releaseCommit"]["pins"] = [];
    const mustJoin: string[] = [];
    for (const d of members) {
      const text = await git.read(source, eco.manifestPath(d));
      if (!text) continue;
      const holder = eco.readManifest(text, rootText).name ?? d;
      const inPlan = planned.some((p) => p.directory === d);
      for (const pp of planned) {
        if (pp.directory === d) continue;
        const declared = eco.requirement(text, rootText, pp.name);
        if (declared === null) continue;
        const range = eco.range(declared);
        const accepts = declared === "*" || (range !== null && semver.satisfies(pp.proposedVersion, range));
        const loc = eco.id === "crates" && new RegExp(`^${pp.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.workspace\\s*=\\s*true|\\s*=\\s*\\{[^}]*workspace\\s*=\\s*true)`, "m").test(text) ? "." : d;
        if (inPlan && !accepts) { if (!pins.some((x) => x.in === loc && x.dependency === pp.name)) pins.push({ in: loc, dependency: pp.name, from: declared, to: eco.followRequirement(declared, pp.proposedVersion) }); continue; }
        if (!accepts) {
          const id = this.d.catalog.find((c) => c.name === holder)?.id ?? holder;
          mustJoin.push(`${holder} (${d}) declares ${pp.name} "${declared}", which does not accept ${pp.proposedVersion} → add --package ${id}`);
          continue;
        }
        dependents.push({ package: holder, where: `${repo}:${eco.manifestPath(d)}`, dependency: pp.name, declared, resolved: eco.resolved(lockText, pp.name, pp.repositoryVersion), accepts, effect: effectOf(declared, accepts, eco.isExact(declared), pp.proposedVersion, true) });
      }
    }
    for (const inst of this.d.installations) {
      const pp = planned.find((p) => p.package === inst.package);
      if (!pp || inst.repository === repo || !inst.declaredVersion) continue;
      const e = ecosystemFor(pp.registry);
      const range = e.range(inst.declaredVersion);
      const accepts = range !== null && semver.satisfies(pp.proposedVersion, range);
      dependents.push({ package: inst.project, where: `${inst.repository}:${inst.manifest}`, dependency: pp.name, declared: inst.declaredVersion, resolved: inst.resolvedVersion ?? null, accepts, effect: effectOf(inst.declaredVersion, accepts, e.isExact(inst.declaredVersion), pp.proposedVersion, false) });
    }
    return { dependents: dependents.sort((a, b) => (a.package + a.where + a.dependency).localeCompare(b.package + b.where + b.dependency)), pins: pins.sort((a, b) => (a.in + a.dependency).localeCompare(b.in + b.dependency)), mustJoin };
  }

  /**
   * The facts an approval depends on that can change after planning: the branch head, every registry's versions
   * (yanked included), whether the tags exist, and the external consumers. Fingerprinted at plan time; recomputed
   * before approval and before execution starts.
   */
  async #facts(repo: string, branch: string, planned: ReleasePlan["packages"]) {
    const git = this.d.git(repo);
    const tags = await git.tags();
    const registries = [];
    for (const pp of planned) {
      const st = await this.#pkgRegistry(pp.package).state(pp.name);
      registries.push({ package: pp.name, versions: [...(st?.versions ?? [])].sort(), yanked: [...(st?.yanked ?? [])].sort() });
    }
    const consumers = this.d.installations.filter((i) => planned.some((p) => p.package === i.package) && i.repository !== repo)
      .map((i) => `${i.repository}:${i.manifest} ${i.package} ${i.declaredVersion ?? "-"} ${i.resolvedVersion ?? "-"}`).sort();
    const facts = { head: await git.head(branch), tags: planned.map((p) => `${p.tag}=${tags.get(p.tag) ?? "absent"}`), registries, consumers };
    return { facts, fingerprint: createHash("sha256").update(canonical(facts)).digest("hex") };
  }

  /** True when the branch head or a planned tag is this release's own deterministic release commit. */
  async #ownProgress(r: ReleaseRecord): Promise<boolean> {
    const git = this.d.git(r.plan.repository);
    const files = await this.#rederive(r);
    const ours = Object.keys(files).length ? await git.makeCommit(r.plan.sourceCommit, files, r.plan.releaseCommit.message, approvedAt(r)) : r.plan.sourceCommit;
    if (ours === r.plan.sourceCommit) return false;
    const tags = await git.tags();
    return (await git.head(r.plan.branch)) === ours || r.plan.packages.some((p) => tags.get(p.tag) === ours);
  }

  /** What changed since the plan, in words (empty: nothing relevant changed). */
  async #reassess(r: ReleaseRecord): Promise<string[]> {
    const now = await this.#facts(r.plan.repository, r.plan.branch, r.plan.packages);
    if (now.fingerprint === r.plan.impactFingerprint) return [];
    const out: string[] = [];
    if (now.facts.head !== r.plan.sourceCommit) out.push(`${r.plan.branch} moved from ${r.plan.sourceCommit.slice(0, 12)} to ${now.facts.head?.slice(0, 12) ?? "(gone)"}`);
    for (const reg of now.facts.registries) {
      const pp = r.plan.packages.find((p) => p.name === reg.package)!;
      if (reg.versions.length !== pp.registryVersions.count) out.push(`${reg.package}: the registry now has ${reg.versions.length} version(s), the plan saw ${pp.registryVersions.count}`);
      if (canonical(reg.yanked) !== canonical(pp.registryVersions.yanked)) out.push(`${reg.package}: yanked versions changed (${pp.registryVersions.yanked.join(", ") || "none"} → ${reg.yanked.join(", ") || "none"})`);
    }
    for (const t of now.facts.tags) if (!t.endsWith("=absent")) out.push(`tag ${t.split("=")[0]} now exists`);
    if (!out.length) out.push("the consumers of the released packages changed since the impact assessment");
    return out;
  }

  // ───────── approval ─────────
  /** The approval statement a person signs for this release (src/governance/signatures.ts). */
  async statement(id: string, approverId: string): Promise<string> { return approvalStatement(await this.load(id), this.#principal(approverId).id); }

  /**
   * Record one person's approval of the exact plan. For a production destination the approval must carry a
   * valid signature by a key registered to that person: an asserted name never authorizes production.
   */
  async approve(id: string, approverId: string, planDigest: string, signature?: string): Promise<ReleaseRecord> {
    const who = this.#principal(approverId);
    const r = await this.load(id);
    if (planDigestOf(r.plan) !== r.planDigest) throw new ReleaseError("not-allowed", "the recorded plan does not match its digest");
    const d = decide("approve", who, this.#subject(r), planDigest);
    if (!d.allow) throw new ReleaseError("not-allowed", `${id}: ${d.message} [${d.code}]`);
    // Reassess immediately before approval: an approval binds the facts the approver was shown.
    const changed = await this.#reassess(r);
    if (changed.length) {
      this.#to(r, "superseded", `facts changed before approval: ${changed.join("; ")}. Approvals never carry over; plan again`);
      await this.#save(r);
      throw new ReleaseError("not-allowed", `${id} is superseded, not approved: ${changed.join("; ")} [digest-mismatch]`);
    }
    const signed = signature ? await verifyApproval(who, approvalStatement(r, who.id), signature) : false;
    if (signature && !signed) throw new ReleaseError("not-allowed", `${id}: the signature does not verify against ${who.id}'s registered keys for this exact approval statement [unauthenticated-for-production]`);
    if (r.plan.packages.some((p) => p.production) && !signed)
      throw new ReleaseError("not-allowed", `${id} publishes to a production registry: the approval must be signed by ${who.id} (release statement, then ssh-keygen -Y sign -n boundry-release-approval). An asserted name is not an authenticated approval [unauthenticated-for-production]`);
    const at = this.d.now();
    r.approvals.push({ by: who.id, principalType: who.type, authentication: signed ? "signature" : "asserted", at, planDigest, signature: signature ?? null });
    if (d.result === "approved") this.#to(r, "approved", `approved by ${r.approvals.map((a) => `${a.by} (${a.authentication})`).join(", ")} for plan ${planDigest.slice(0, 12)}`);
    else { const c = counted(this.#subject(r)); r.history.push({ at, state: r.state, note: `approval ${c.valid.length} of ${c.required} by ${who.id} (${signed ? "signature" : "asserted"})` }); }
    await this.#save(r);
    return r;
  }

  /** The proposer withdraws, or an approver rejects. Never after publication (the irreversible step). */
  async revoke(id: string, byId: string, reason: string): Promise<ReleaseRecord> {
    const who = this.#principal(byId);
    const r = await this.load(id);
    if (TERMINAL.includes(r.state)) throw new ReleaseError("not-allowed", `release ${id} is ${r.state}`);
    const d = decide("withdraw", who, this.#subject(r));
    if (!d.allow) throw new ReleaseError("not-allowed", `${id}: ${d.message} [${d.code}]`);
    r.revocation = { by: who.id, at: this.d.now(), reason };
    this.#to(r, "cancelled", `revoked by ${who.id}: ${reason}${r.facts.tags.length ? ` (tag ${r.facts.tags.map((t) => t.name).join(", ")} remains; tags are never moved or deleted)` : ""}`);
    await this.#save(r);
    return r;
  }

  /**
   * Record what Maintenance's scan observes about each consumer of a released version, append-only.
   * Installation (declared, resolved), adoption (resolved is the released version or newer) and verification
   * (the consumer's own checks passed on it) are separate facts; verification is never inferred from adoption.
   */
  async observeConsumers(id: string, installations: Installation[], basis: string, evidence: EvidenceRecord[] = []): Promise<ReleaseRecord> {
    const r = await this.load(id);
    if (r.state !== "released") throw new ReleaseError("not-allowed", `release ${id} is ${r.state}; consumers are observed after release`);
    const at = this.d.now();
    for (const pp of r.plan.packages) {
      for (const inst of installations.filter((i) => i.package === pp.package && i.repository !== r.plan.repository)) {
        const where = `${inst.repository}:${inst.manifest}`;
        const resolved = inst.resolvedVersion ?? null;
        const adoption = resolved && semver.valid(resolved) ? (semver.gte(resolved, pp.proposedVersion) ? "adopted" : "not-adopted") : "unknown";
        // Verification of THIS version: the consumer's own evidence for a commit whose lockfile resolved exactly it,
        // for this manifest root. Its CI on a commit using another version says nothing about this one.
        const key = installKey(inst.root, inst.registry, inst.name);
        const records = evidence
          .filter((e) => e.project === inst.project && e.resolved[key] === pp.proposedVersion && e.checks.resolution === "pass" && e.checks.workflows !== "pending")
          .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
        const rec = records.find((e) => e.passed) ?? records[0] ?? null;
        const verification = rec ? (rec.passed ? "verified" : "failed") : "unverified";
        r.consumers.push({
          at, consumer: inst.project, where, dependency: pp.name, released: pp.proposedVersion, basis,
          installation: { declared: inst.declaredVersion ?? null, resolved, commit: inst.commit ?? null }, adoption, verification,
          verificationEvidence: rec ? `${rec.passed ? "passed" : "failed"}: ${rec.runs.map((x) => `${x.workflow} run ${x.runId} ${x.conclusion}`).join(", ") || "no runs"} on ${inst.project}@${rec.commit.slice(0, 12)}, which resolved ${pp.name} ${pp.proposedVersion}` : null,
          verificationRecord: rec ? { commit: rec.commit, collectedAt: rec.collectedAt, resolved: pp.proposedVersion, runs: rec.runs.map((x) => ({ workflow: x.workflow, runId: x.runId, url: x.url, conclusion: x.conclusion })) } : null,
        });
      }
    }
    await this.#save(r);
    return r;
  }

  /**
   * A person stops pursuing a claimed release that cannot or should not finish (contract §7a). Every authority is
   * asked what is real first (branch, tags, registry); if one cannot answer, nothing changes. Nothing is rolled back:
   * the record says which commit, tags and versions remain. Not withdrawal (the claim happened), not rollback.
   */
  async abandon(id: string, byId: string, reason: string): Promise<ReleaseRecord> {
    const who = this.#principal(byId);
    let r = await this.load(id);
    const pre = decide("abandon", who, this.#subject(r), undefined, { reason, reconciled: true });
    if (!pre.allow) throw new ReleaseError("not-allowed", `${id}: ${pre.message} [${pre.code}]`);
    return this.#locked(r.plan.packages.map((p) => p.package), async () => {
      r = await this.load(id);
      let rec: NonNullable<ReleaseRecord["abandonment"]>["reconciliation"] | null = null, why = "";
      try { rec = await this.#reconcileAll(r); } catch (e) { why = (e as Error).message; }
      const d = decide("abandon", who, this.#subject(r), undefined, { reason, reconciled: rec !== null });
      if (!d.allow) throw new ReleaseError("not-allowed", `${id}: ${d.message}${why ? ` (${why})` : ""} [${d.code}]`);
      const real: string[] = [];
      if (rec!.releaseCommitOnBranch) real.push(`release commit ${rec!.releaseCommit?.slice(0, 12)} is on ${rec!.branch} and stays there`);
      for (const t of rec!.tags) if (t.target) real.push(`tag ${t.name} → ${t.target.slice(0, 12)} exists and is never moved or deleted`);
      for (const g of rec!.registry) if (g.present) real.push(`${g.package}@${g.version} IS published on the registry${g.matchesBuiltArtifact === true ? " with exactly the built artifact" : g.matchesBuiltArtifact === false ? " with a DIFFERENT artifact than this release built" : " (this release recorded no build to compare)"}${g.yanked ? ", yanked" : ""}; a version is never unpublished or reused`);
      if (!real.length) real.push("nothing: no release commit on the branch, no tags, no published versions");
      r.abandonment = { by: who.id, byType: who.type, at: this.d.now(), reason: reason.trim(), atState: r.state, reconciliation: rec!, remainsReal: real };
      this.#to(r, "abandoned", `abandoned by ${who.id}: ${reason.trim()}. Reconciled first; what remains real: ${real.join("; ")}`);
      await this.#save(r);
      return r;
    });
  }

  /** Ask git and every registry what is real now for this release. Throws if any authority cannot answer. */
  async #reconcileAll(r: ReleaseRecord): Promise<NonNullable<ReleaseRecord["abandonment"]>["reconciliation"]> {
    const git = this.d.git(r.plan.repository);
    const head = await git.head(r.plan.branch);
    let commit = r.facts.releaseCommit;
    if (!commit && r.approvals.length) {
      const files = await this.#rederive(r); // the deterministic release commit, as #prepare would make it
      commit = Object.keys(files).length ? await git.makeCommit(r.plan.sourceCommit, files, r.plan.releaseCommit.message, approvedAt(r)) : r.plan.sourceCommit;
    }
    const onBranch = !!(commit && head && commit !== r.plan.sourceCommit && (head === commit || (await git.isAncestor(commit, head))));
    const tags = await git.tags();
    const registry = [];
    for (const pp of r.plan.packages) {
      const v = await this.#pkgRegistry(pp.package).version(pp.name, pp.proposedVersion);
      const built = r.facts.build?.artifacts.find((a) => a.package === pp.package);
      registry.push({ package: pp.package, version: pp.proposedVersion, present: !!v, integrity: v?.integrity ?? null, matchesBuiltArtifact: v && built ? v.integrity === built.integrity : null, yanked: !!v?.yanked });
    }
    return { at: this.d.now(), branch: r.plan.branch, branchHead: head, releaseCommit: onBranch ? commit : r.facts.releaseCommit, releaseCommitOnBranch: onBranch, tags: r.plan.packages.map((p) => ({ name: p.tag, target: tags.get(p.tag) ?? null })), registry };
  }

  #principal(id: string): Principal { try { return principal(this.d.principals, id); } catch (e) { throw this.#asRelease(e); } }
  #gov(f: () => void) { try { f(); } catch (e) { throw this.#asRelease(e); } }
  #asRelease(e: unknown) { return e instanceof GovernanceError ? new ReleaseError("not-allowed", `${e.message} [${e.code}]`) : e; }
  #pkgs(r: ReleaseRecord) { return r.plan.packages.map((pp) => this.d.catalog.find((c) => c.id === pp.package)).filter((p): p is PackageConfig & { release: ReleasePolicy } => !!p?.release); }

  /** The release as a governance subject, under the CURRENT policy of its packages (contract §7, §8). */
  #subject(r: ReleaseRecord, approvals: Subject["approvals"] = r.approvals.map((a) => ({ by: a.by, principalType: a.principalType, authentication: a.authentication, digest: a.planDigest }))): Subject {
    const pkgs = this.#pkgs(r);
    const frozen = pkgs.find((p) => p.release.frozen);
    return {
      state: r.state, proposedBy: r.plan.requestedBy, digest: r.planDigest,
      criticality: pkgs.some((p) => p.criticality === "critical") ? "critical" : "medium",
      policy: {
        approvalsRequired: Math.max(1, ...pkgs.map((p) => p.release.approvalsRequired)),
        protected: r.plan.protected || pkgs.some((p) => p.release.protected),
        frozen: !!frozen, ...(frozen ? { freezeReason: `${frozen.name} is frozen${frozen.release.freezeReason ? `: ${frozen.release.freezeReason}` : ""}` } : {}),
      },
      production: r.plan.packages.some((p) => p.production),
      approvals, revoked: !!r.revocation,
      irreversible: ORDER.indexOf(r.state) >= ORDER.indexOf("published"),
      claimed: claimOf(r) !== null,
      eligible: r.plan.approvers,
      requiredAtProposal: r.plan.requiredApprovals,
    };
  }

  /** Approvals with their authentication re-established by the executor: a stored "signature" label is not trusted. */
  async #verifiedApprovals(r: ReleaseRecord): Promise<Subject["approvals"]> {
    const out: Subject["approvals"] = [];
    for (const a of r.approvals) {
      const p = this.d.principals.find((x) => x.id === a.by);
      const ok = !!(p && a.signature && (await verifyApproval(p, approvalStatement(r, a.by), a.signature)));
      out.push({ by: a.by, principalType: p?.type ?? "unknown", authentication: ok ? "signature" : "asserted", digest: a.planDigest });
    }
    return out;
  }

  // ───────── execution ─────────
  /**
   * A person (or automation holding the trigger effect) asks for an approved release to be carried out. The
   * release executor, a component principal, then decides on its own whether it may execute (contract §8).
   */
  async execute(id: string, triggeredBy: string): Promise<ReleaseRecord> {
    const who = this.#principal(triggeredBy);
    this.#gov(() => authorize(who, "releases.trigger"));
    const executor = this.#principal(this.d.executorPrincipal);
    let r = await this.load(id);
    return this.#locked(r.plan.packages.map((p) => p.package), async () => {
      r = await this.load(id); // re-read under the lock
      if (TERMINAL.includes(r.state)) return r;
      if (r.failure && !r.failure.recoverable) return r;
      if (r.state === "approved" && !claimOf(r)) {
        let changed: string[];
        try { changed = await this.#reassess(r); }
        catch (e) {
          if (!(e instanceof Unavailable)) throw e;
          r.attempts.push({ at: this.d.now(), step: "reassess", outcome: "failed", detail: `${(e as Error).message}; nothing was changed` });
          r.failure = { at: r.state, reason: `cannot reassess: ${(e as Error).message}`, recoverable: true, when: this.d.now() };
          await this.#save(r);
          return r;
        }
        // A crash after this release started (record not saved) changes the branch, tags and registry by its
        // OWN deterministic release commit: that is not a change of facts; #prepare reconciles it.
        if (changed.length && (await this.#ownProgress(r))) {
          r.attempts.push({ at: this.d.now(), step: "reassess", outcome: "already-done", detail: `changes are this release's own progress (its deterministic release commit): ${changed.join("; ")}` });
          changed = [];
        }
        if (changed.length) {
          r.attempts.push({ at: this.d.now(), step: "reassess", outcome: "refused", detail: changed.join("; ") });
          this.#to(r, "superseded", `facts changed after approval, before execution: ${changed.join("; ")}. Nothing was changed; plan again`);
          await this.#save(r);
          return r;
        }
        const d = decide("execute", executor, this.#subject(r, await this.#verifiedApprovals(r)));
        if (!d.allow) {
          r.attempts.push({ at: this.d.now(), step: "authorize", outcome: "refused", detail: `${executor.id}: ${d.message} [${d.code}] (triggered by ${who.id})` });
          if (d.result === "awaiting-approval") this.#to(r, "awaiting-approval", `${d.message}: back to approval`);
          else if (d.result !== "wait") { r.failure = { at: r.state, reason: `${d.message} [${d.code}]`, recoverable: false, when: this.d.now() }; this.#to(r, "failed", d.message); }
          await this.#save(r);
          return r;
        }
        r.attempts.push({ at: this.d.now(), step: "authorize", outcome: "done", detail: `${executor.id} authorized execution under ${CONTRACT_REF} (triggered by ${who.id})` });
        // The claim: from here on the release can no longer be withdrawn or rejected, only finished or abandoned.
        r.claim = { by: executor.id, at: this.d.now(), triggeredBy: who.id, inferred: false };
        r.attempts.push({ at: this.d.now(), step: "claim", outcome: "done", detail: `claimed by ${executor.id}; withdrawal ends here (contract §7)` });
        await this.#save(r);
      } else r.attempts.push({ at: this.d.now(), step: "trigger", outcome: "done", detail: `execution resumed by ${who.id}` });
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

  /** Before every step that precedes publication: still not revoked, still the approved plan, still approved. */
  #checkAuthority(r: ReleaseRecord) {
    if (ORDER.indexOf(r.state) >= ORDER.indexOf("published")) return; // after publication only verification remains
    if (r.revocation) throw new Blocked(`revoked by ${r.revocation.by}`, false, "cancelled");
    if (planDigestOf(r.plan) !== r.planDigest) throw new Blocked("the plan no longer matches what was approved", false);
    const c = counted(this.#subject(r));
    if (c.valid.length < c.required) throw new Blocked("not approved by enough distinct people", false, "cancelled");
  }

  #to(r: ReleaseRecord, state: ReleaseState, note: string) { r.state = state; r.history.push({ at: this.d.now(), state, note }); }
  #did(r: ReleaseRecord, step: string, outcome: "done" | "already-done", detail: string) { r.attempts.push({ at: this.d.now(), step, outcome, detail }); }

  /** approved → prepared: the release commit, deterministic, fast-forwarded onto the branch. */
  async #prepare(r: ReleaseRecord) {
    const p = r.plan;
    const git = this.d.git(p.repository);
    const files = JSON.parse(await readFile(join(this.d.runtimeDir, "files", r.id, "files.json"), "utf8").catch(async () => JSON.stringify(await this.#rederive(r))));
    const at = approvedAt(r);
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
    const git = this.d.git(r.plan.repository);
    return ecosystemFor(r.plan.packages[0]!.registry).editFiles((path) => git.read(r.plan.sourceCommit, path), r.plan.packages, r.plan.releaseCommit.pins);
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
      // Tests failing and the build/packaging failing are different facts: name which one.
      const failedJobs = st.jobs.filter((j) => j.state === "failed");
      const what = failedJobs.some((j) => /test/i.test(j.key)) ? "the tests failed" : failedJobs.length ? `the build failed (${failedJobs.map((j) => j.key).join(", ")})` : `the build ${st.state}`;
      throw new Blocked(`release build ${runId}: ${what} on the release commit; nothing was tagged or published`, true);
    }
    const pkg = await this.d.executor.artifact(runId, "step-package", "package.tar");
    if (sha256(pkg.bytes) !== pkg.sha256) throw new Blocked("package.tar does not match its digest", false);
    const work = await mkdtemp(join(tmpdir(), "boundry-release-"));
    try {
      await writeFile(join(work, "package.tar"), pkg.bytes);
      await pexec("tar", ["-xf", join(work, "package.tar"), "-C", work]);
      const artifacts: NonNullable<ReleaseRecord["facts"]["build"]>["artifacts"] = [];
      for (const pp of p.packages) {
        const eco = ecosystemFor(pp.registry);
        const file = eco.artifactFile(pp.name, pp.proposedVersion);
        const bytes = await readFile(join(work, file)).catch(() => { throw new Blocked(`the build did not produce ${file}`, false); });
        const inner = await eco.readArtifactManifest(async (path) => (await pexec("tar", ["-xzOf", join(work, file), path])).stdout, pp.name, pp.proposedVersion)
          .catch(() => { throw new Blocked(`${file} has no readable manifest`, false); });
        if (inner.name !== pp.name || inner.version !== pp.proposedVersion) throw new Blocked(`${file} contains ${inner.name}@${inner.version}, not ${pp.name}@${pp.proposedVersion}`, false);
        const digest = sha256(bytes);
        await mkdir(join(this.d.runtimeDir, "artifacts"), { recursive: true });
        await writeFile(join(this.d.runtimeDir, "artifacts", `${digest}-${file}`), bytes);
        artifacts.push({ package: pp.package, file, sha256: digest, integrity: this.#pkgRegistry(pp.package).integrityOf(bytes), size: bytes.length });
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
        try { await git.pushTag(pp.tag, commit, `${pp.name} ${pp.proposedVersion}\n\nartifact sha256:${r.facts.build!.artifacts.find((a) => a.package === pp.package)!.sha256}`, approvedAt(r)); }
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
        if (existing.integrity !== art.integrity) throw new Blocked(`${pp.name}@${pp.proposedVersion} is on the registry with a DIFFERENT artifact (${existing.integrity?.slice(0, 20)}…); a published version is never overwritten`, false);
        r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.integrity, alreadyPresent: true });
        this.#did(r, "publish", "already-done", `${pp.name}@${pp.proposedVersion} already on the registry with the built integrity`);
        continue;
      }
      const st = await reg.state(pp.name);
      const highest = (st?.versions ?? []).filter((v) => semver.valid(v)).sort(semver.rcompare)[0] ?? null;
      if (highest !== pp.registryVersions.highest) throw new Blocked(`${pp.name}: a newer version (${highest}) appeared on the registry after approval; publishing ${pp.proposedVersion} now would not be the release that was approved`, false, "superseded");
      const file = join(this.d.runtimeDir, "artifacts", `${art.sha256}-${art.file}`);
      const bytes = await readFile(file).catch(async () => {
        const again = await this.d.executor.artifact(r.facts.build!.runId, "step-package", "package.tar"); // durable copy in Boundry CI
        void again; throw new Blocked("built tarball missing from the runtime directory; re-run to fetch it again", true);
      });
      if (sha256(bytes) !== art.sha256) throw new Blocked("the tarball about to be published does not match the built digest", false);
      try { await reg.publish(file, { distTag: pp.distTag }); }
      catch (e) {
        // The response may have been lost after the registry accepted it: ask the registry, never assume.
        const after = await reg.version(pp.name, pp.proposedVersion).catch(() => null);
        if (after?.integrity === art.integrity) { r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.integrity, alreadyPresent: true }); this.#did(r, "publish", "already-done", `publish reported "${(e as Error).message}", but the registry has the exact artifact`); continue; }
        if (e instanceof Refused && after) throw new Blocked(`registry refused: ${pp.name}@${pp.proposedVersion} exists with a different artifact`, false);
        throw e instanceof Unavailable ? e : new Blocked(`publish failed: ${(e as Error).message}`, !(e instanceof Refused));
      }
      r.facts.published.push({ package: pp.package, version: pp.proposedVersion, integrity: art.integrity, alreadyPresent: false });
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
      if (v.yanked) throw new Blocked(`${pp.name}@${pp.proposedVersion} is yanked on the registry: a yanked version is not a resolution target, so this release is not verified`, false);
      if (v.integrity !== art.integrity) throw new Blocked(`${pp.name}@${pp.proposedVersion}: registry integrity ${v.integrity?.slice(0, 20)}… differs from the built artifact`, false);
      const bytes = await reg.download(v.tarball!);
      if (sha256(bytes) !== art.sha256) throw new Blocked(`${pp.name}@${pp.proposedVersion}: the tarball the registry serves differs from the built artifact`, false);
      const st = await reg.state(pp.name);
      r.facts.registryVerification.push({ package: pp.package, version: pp.proposedVersion, integrity: v.integrity!, tarballSha256: sha256(bytes), distTagPointsHere: reg.kind === "npm" ? st?.distTags[pp.distTag] === pp.proposedVersion : null, at: this.d.now() });
    }
    this.#did(r, "verify-registry", "done", r.facts.registryVerification.map((v) => `${v.version} integrity+bytes match; ${v.distTagPointsHere === null ? "not yanked (no dist-tags on this registry)" : v.distTagPointsHere ? "dist-tag points here" : "dist-tag does NOT point here"}`).join("; "));
    this.#to(r, "registry-verified", "registry serves the exact artifact");
  }

  /** registry-verified → released: GitHub release for the tag (if required). */
  async #githubRelease(r: ReleaseRecord) {
    if (r.plan.githubRelease) {
      const body = await this.#notes(r);
      for (const pp of r.plan.packages) {
        if (r.facts.githubReleases.some((g) => g.package === pp.package)) continue;
        const existing = await this.d.releases.find(r.plan.repository, pp.tag);
        if (existing) {
          if (existing.tag !== pp.tag) throw new Blocked(`GitHub release found for ${existing.tag}, expected ${pp.tag}`, false);
          r.facts.githubReleases.push({ package: pp.package, url: existing.url, tag: pp.tag, alreadyPresent: true });
          this.#did(r, "github-release", "already-done", existing.url);
          continue;
        }
        const created = await this.d.releases.create(r.plan.repository, { tag: pp.tag, name: `${pp.name} ${pp.proposedVersion}`, body, prerelease: !!semver.prerelease(pp.proposedVersion) });
        r.facts.githubReleases.push({ package: pp.package, url: created.url, tag: pp.tag, alreadyPresent: false });
        this.#did(r, "github-release", "done", created.url);
      }
    } else r.attempts.push({ at: this.d.now(), step: "github-release", outcome: "skipped", detail: "skipped: the release policy does not create GitHub releases" });
    r.downstream = downstreamProposals(r);
    if (r.downstream.length) this.#did(r, "downstream", "done", `${r.downstream.length} consumer change(s) proposed (never applied by this release): ${r.downstream.map((d) => `${d.consumer} ${d.kind}`).join(", ")}`);
    this.#to(r, "released", `${r.plan.packages.map((p) => `${p.name}@${p.proposedVersion}`).join(", ")} released and verified`);
  }

  async #notes(r: ReleaseRecord): Promise<string> {
    const git = this.d.git(r.plan.repository);
    const L = ["Released by Boundry Maintenance.", ""];
    for (const pp of r.plan.packages) {
      const art = r.facts.build!.artifacts.find((a) => a.package === pp.package)!;
      L.push(`### ${pp.name} ${pp.proposedVersion}`, "", `- Commit: ${r.facts.releaseCommit} (from ${r.plan.sourceCommit.slice(0, 12)})`, `- Artifact: \`${art.file}\` sha256 \`${art.sha256}\``, `- Registry integrity: \`${art.integrity}\``, `- Built and tested by Boundry CI run \`${r.facts.build!.runId}\``, "");
      const changes = await git.log(`${r.plan.sourceCommit}`, pp.directory, 15);
      if (changes.length) L.push("Recent changes in this package:", ...changes.map((c) => `- ${c}`), "");
    }
    L.push("Why this version:", ...r.plan.decision.map((d) => `- ${d}`));
    return L.join("\n");
  }

  #pkgRegistry(id: string) { return this.d.registry(this.d.catalog.find((c) => c.id === id)!); }

  /** Exclusive per-package locks (atomic; see src/lib/lock.ts). Held by one plan or one execution at a time. */
  async #locked<T>(ids: string[], f: () => Promise<T>): Promise<T> {
    try { return await withLocks(ids.map((id) => join(this.d.runtimeDir, "locks", id)), f); }
    catch (e) { if (e instanceof LockHeld) throw new ReleaseError("busy", `another release plan or execution holds ${e.lock.split("/").pop()}`); throw e; }
  }
}

/** The Boundry Recipe Maintenance hands to the execution substrate for a release build. */
export function buildRecipe(r: ReleaseRecord): { path: string; source: string } {
  const names = r.plan.packages.map((p) => `${p.name} ${p.proposedVersion}`).join(", ");
  const L = [`# Release build: ${names}`, "", `Build${r.plan.validation.includes("test") ? ", test" : ""} and package release commit ${r.facts.releaseCommit} for Boundry Maintenance release ${r.id}.`, "", "## When this happens", "- I start it.", ""];
  if (r.plan.validation.includes("test")) L.push("## Make sure", "- The tests pass.", "");
  L.push("## Steps", `1. ${ecosystemFor(r.plan.packages[0]!.registry).packageStep}`, "", "## Keep", ...(r.plan.validation.includes("test") ? ["- The test results."] : []), "- The package for 3650 days.", "- The release evidence.");
  return { path: ".boundry/recipes/boundry-release.md", source: L.join("\n") + "\n" };
}

function splitId(id: string): [string, string] { const i = id.lastIndexOf("@"); return [id.slice(0, i), id.slice(i + 1)]; }
export { stableJson };

/** When the plan became approved (the last approval): the fixed date of the release commit and tags. */
function approvedAt(r: ReleaseRecord): string { const a = r.approvals.at(-1); if (!a) throw new Blocked("not approved", false, "cancelled"); return a.at; }
const CONTRACT_REF = CONTRACT_VERSION;
const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
const requiredFor = (pkgs: (PackageConfig & { release: ReleasePolicy })[]) => Math.max(1, ...pkgs.map((p) => requiredApprovals(p.release.approvalsRequired, p.criticality)));

/** Workspace member directories at the source commit ("dir/*" patterns expanded through git). */
async function workspaceMembers(git: GitAuthority, source: string, eco: Ecosystem, rootText: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of eco.workspacePatterns(rootText)) {
    const m = /^(.*)\/\*$/.exec(pattern);
    const parent = m?.[1];
    if (parent !== undefined) for (const d of (await git.list(source, parent)) ?? []) out.push(`${parent}/${d}`);
    else out.push(pattern.replace(/\/$/, ""));
  }
  return [...new Set(out)].sort();
}

function effectOf(declared: string, accepts: boolean, exact: boolean, version: string, sibling: boolean): string {
  if (exact) return accepts ? `pins ${declared} exactly, which is the new version` : `pins ${declared} exactly: keeps using it until a requirement change (its own plan)`;
  if (!accepts) return `requirement ${declared} does NOT accept ${version}: needs a requirement change (its own plan)`;
  return sibling ? `requirement ${declared} accepts ${version}; it builds against the new version in the workspace` : `requirement ${declared} accepts ${version} on its next lockfile update`;
}

/**
 * The consumer changes a release makes necessary, as proposals for their own plans. Exact pins and requirements
 * that do not accept the version need a requirement change; accepting requirements whose lockfile resolves an
 * older version need a lockfile update. Workspace siblings released together are not consumers.
 */
export function downstreamProposals(r: ReleaseRecord): ReleaseRecord["downstream"] {
  const out: ReleaseRecord["downstream"] = [];
  for (const d of r.plan.dependents) {
    const pp = r.plan.packages.find((p) => p.name === d.dependency);
    if (!pp) continue;
    const eco = ecosystemFor(pp.registry);
    const note = "Proposed only: it needs its own plan and approval in the consumer's repository. This release never changes consumers.";
    if (!d.accepts) out.push({ consumer: d.package, where: d.where, dependency: d.dependency, toVersion: pp.proposedVersion, kind: "requirement-change", from: d.declared, to: eco.isExact(d.declared) ? eco.followRequirement(d.declared, pp.proposedVersion) : eco.id === "npm" ? `^${pp.proposedVersion}` : pp.proposedVersion, state: "proposed", note });
    else if (d.resolved && semver.valid(d.resolved) && semver.lt(d.resolved, pp.proposedVersion) && !d.where.startsWith(`${r.plan.repository}:`))
      out.push({ consumer: d.package, where: d.where, dependency: d.dependency, toVersion: pp.proposedVersion, kind: "lockfile-update", from: d.resolved, to: pp.proposedVersion, state: "proposed", note });
  }
  return out;
}

/**
 * The claim on a release. Schema-3 records carry it. For a schema-2 record (before contract 1.2.0) it is inferred:
 * claimed if execution was ever authorized or triggered, or the release moved past "approved".
 */
export function claimOf(r: ReleaseRecord): ReleaseRecord["claim"] {
  if (r.claim) return r.claim;
  if (r.schemaVersion !== 2) return null;
  const first = r.attempts.find((a) => (a.step === "authorize" && a.outcome === "done") || a.step === "trigger" || a.step === "release-commit");
  if (first) return { by: "component:release-executor", at: first.at, triggeredBy: "unknown (schema 2)", inferred: true };
  if (ORDER.indexOf(r.state) > ORDER.indexOf("approved")) return { by: "component:release-executor", at: r.history.at(-1)!.at, triggeredBy: null, inferred: true };
  return null;
}
