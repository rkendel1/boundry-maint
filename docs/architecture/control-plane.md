# One Boundry ecosystem control plane

Status: **Prompt 1 deliverable.** Written after inspecting three repositories, and before the Package Control (Prompt 2) and Resolver Control integration (Prompt 3) work:

* `rkendel1/boundry-maint` on this branch;
* `rkendel1/resolver-control@d41ef9e` (read only);
* `rkendel1/boundry-ci` on this branch.

The only thing implemented by this step is the governance foundation described in [§6](#6-contract-and-schema-changes-implemented-now). Everything else here is design, and is labelled as such.

The end state the user asked for: one control plane that governs both **what applications are built from** (packages, releases) and **what running applications depend on** (Resolver references).

## Contents

1. [Architecture map](#1-architecture-map)
2. [Domain ownership and source-of-truth matrix](#2-domain-ownership-and-source-of-truth-matrix)
3. [Integration design](#3-integration-design)
4. [Reuse versus new](#4-reuse-versus-new)
5. [Platform gap register](#5-platform-gap-register)
6. [Contract and schema changes](#6-contract-and-schema-changes-implemented-now)
7. [Incremental plan with acceptance criteria](#7-incremental-plan-with-acceptance-criteria)

---

## 1. Architecture map

### What exists today (verified in code)

| System | What it is | Governed state | Interfaces | Executes side effects |
|---|---|---|---|---|
| **Boundry Maintenance** (`boundry-maint`) | Observational scan of npm, crates.io, GitHub and CI, and the Release Manager | `config/*.json` (curated). `data/` is a generated projection, committed. Release records are `data/release-manager/**`, JSON files written atomically | CLI only (`node src/index.ts …`). No AppPort, no MCP, no authentication | Release Manager only: git push, registry publish, GitHub release, CI submit |
| **Resolver Control** (`resolver-control`) | FeltKit 0.3.25 application governing Resolver references | FeltDB collections: `dependencies`, `consumers`, `observations`, `policies`, `changes`, `candidates`, `events`, `settings`, `syncStatus` | 30 AppPort capabilities, exposed over MCP. FeltKit roles and sessions | Only its `resolver` component (Resolver key), through the approval signer (signing key, a separate process) |
| **Boundry CI** (`boundry-ci`) | Execution substrate: recipes compiled to plans, scheduler, leases, Docker workers, CAS artifacts | Its own FeltDB: runs, jobs, attempts, leases, artifacts, evidence | HTTP API: SCM webhook intake, `POST /v1/executions`, run evidence. Operator token | Runs untrusted repository code with no secrets. Never decides versions or releases |
| **Resolver** (`@appport/resolver`, external authority) | Runtime reference store | References, revisions, history, grants, consumers, adoption, mutation policies | `resolver-client` | — |
| **Registries, git hosts, GitHub** (external authorities) | Published versions, commits and tags, release pages | — | Their APIs | — |

### Target shape (design)

```
                        people (UI/CLI)        agents (MCP)          consuming applications
                              │                     │                         │
                              ▼                     ▼                         ▼
             ┌──────────── AppPort capabilities (one discovery surface, per-app authorization) ────────────┐
             │                                                                                            │
   ┌─────────┴──────────────────────────────┐                ┌─────────────────────────────────┴────────┐
   │ Boundry Maintenance  (ecosystem authority) │  read-only    │ Resolver Control  (runtime-reference domain)  │
   │ catalog: applications, packages, owners,   │◀─capabilities─│ dependencies, consumers, policies, changes,   │
   │ criticality · release governance ·         │  (projection, │ observations · approval signer (separate)     │
   │ cross-domain impact                        │  never auth.) │                                               │
   │ components (each holds ONE credential):    │──propose────▶ │ component `resolver` (Resolver key only)      │
   │  registry-npm · registry-crates · git ·    │  (agent role, │                                               │
   │  github-releases · ci-submit               │   never       │                                               │
   └───────┬──────────────┬──────────────┬──────┘   approve)    └───────────────────────┬───────────────────────┘
           │ submit        │ publish      │ push/tag                                    │ conditional write
           ▼               ▼              ▼                                             ▼
     Boundry CI      npm / crates.io   git host                                     Resolver
   (execution only)  (authority)       (authority)                                  (authority)
```

**Decision: federation under one governance contract, not one merged application.** The reasons come from the code:

1. **Credential custody.** In FeltKit, a component runs with the application's trust: same process, same host credentials (Resolver Control gap F6). Merging Resolver Control into Maintenance would put the Resolver key and the npm publish token in one trust boundary. The user's constraint is to keep "package registry credentials separate from Resolver credentials and CI execution authority". Two applications give two trust boundaries.
2. **Resolver Control works and has independent value.** It has 20 governance tests against real Resolver 0.4.0, plus a multi-process end-to-end test. Rebuilding it inside Maintenance would be a rewrite with no new capability.
3. **"One control plane" is delivered by three things, not by one process:**
   * one governance vocabulary and one set of rules (§6, taken from Resolver Control's);
   * one discovery surface (AppPort, where each application publishes its capabilities and an agent sees both);
   * one catalog of applications that links both domains (§3.2).

**What this decision costs:**

* Two deployables instead of one.
* Cross-domain impact needs a read across an API boundary.
* Two FeltDB stores. Each is authoritative for its own domain, so this is not duplication.

---

## 2. Domain ownership and source-of-truth matrix

**Rule:** each fact has exactly one authority. Everything else is a projection, stamped with when and from where it was read. Projections are never the basis of an irreversible action.

| Fact | Authority | Projections (never authority) | Who may change it |
|---|---|---|---|
| Published package versions, integrity, dist-tags, yanked and deprecated | **Registry** (npm, crates.io) | `data/packages.json`, `data/releases.json`; `ReleasePlan.registryVersions` | Release executor only (`registry-*` component), only for an approved plan, never overwriting |
| Commits, branches, tags | **Git host** | `ReleaseRecord.facts.tags`; Boundry CI's mirror cache | Release executor (`git` component): fast-forward the release commit and create tags, never move them |
| GitHub release pages | **GitHub** | `facts.githubReleases` | Release executor (`github-releases` component) |
| Declared versions and dependencies | **Manifests and lockfiles at a commit** | `data/installations.json` | Repository owners. The release commit edits only versions and in-plan pins |
| Package catalog, ownership, criticality, release policy | **Maintenance** `config/packages.json` (FeltDB after step 3) | dashboard | `catalog.write` (people) |
| Applications and which packages they manage | **Maintenance** `config/projects.json` | dashboard | `catalog.write` |
| Principals and roles | **Maintenance** `config/principals.json` today (asserted identity). After step 3: FeltKit/AppBoundry sessions for identity; roles in the application | — | admin |
| Release proposals, plans, impact, approvals, lifecycle, attempts, evidence | **Maintenance** `data/release-manager/**` today (FeltDB after step 3) | approval request markdown, dashboard | propose: engineer or agent. Approve: person. Execute: release executor |
| Build and test executions, artifacts and their digests, logs | **Boundry CI** (its FeltDB and CAS) | `ReleaseRecord.facts.build` (run id and digests, re-verified against the registry bytes) | CI workers only |
| What `ref://…` resolves to; revisions, history, grants, consumers, adoption | **Resolver** | Resolver Control `observations` | Resolver Control's `resolver` component, for an approved change, with a conditional write |
| Reference ownership, criticality, change class, declared consumers, policies, changes | **Resolver Control** (FeltDB) | Maintenance's cross-domain view (step 4) | Resolver Control capabilities and roles |
| Observed runtime consumers | **Resolver** (resolution records, observed) | Resolver Control `observations.observedConsumers` | — |
| Observed build-time consumers | **Manifests** of consuming repositories (observed by Maintenance's scan) | `data/installations.json` | — |

**Credentials: one holder each, never shared**

| Credential | Holder | Never held by |
|---|---|---|
| npm and crates.io publish tokens | Maintenance `registry-*` component (today: the CLI process, `BOUNDRY_NPM_TOKEN_FILE`) | CI workers, Resolver Control, agents |
| Git push token | Maintenance `git` component (today: `BOUNDRY_GIT_TOKEN_FILE`) | CI workers |
| GitHub release token | Maintenance `github-releases` component | CI workers |
| Boundry CI operator token | Maintenance `ci-submit` component (today: `BOUNDRY_CI_OPERATOR_TOKEN_FILE`) | Resolver Control |
| Resolver API key | Resolver Control `resolver` component | Maintenance, CI |
| Change-authorization signing key | Resolver Control's approval signer (separate process) | Resolver Control, Maintenance |

---

## 3. Integration design

### 3.1 Boundry CI (exists; built and proven)

* Maintenance submits `POST /v1/executions` with:
  * the exact commit (40 hex);
  * a generated recipe (`.boundry/recipes/boundry-release.md`) that runs tests and `npm pack`.
* Boundry CI returns run evidence and artifact digests. Maintenance downloads the artifact and recomputes sha256 and sha512. It publishes those exact bytes, then verifies the registry serves the same bytes.
* Boundry CI holds no publish credential and decides nothing. Proven by `docs/releases/proof-resolver-train/`.
* **Gap G5:** the operator token can do everything an operator can. Maintenance needs a token that can only submit executions and read their evidence.

### 3.2 Resolver Control (design; Prompt 3)

1. **Read: no new authority.** Maintenance reads Resolver Control through its existing capabilities: `dependencies.list`, `dependencies.inspect` and `changes.list`. It does so as its own principal, with Resolver Control's `viewer` role. These become a projection in Maintenance's cross-domain view, stamped with the time read.
   * Maintenance never talks to Resolver.
   * Maintenance never holds the Resolver key.
2. **Link: the application catalog.** `config/projects.json` gains, per application, the Resolver namespaces and references it resolves. That link is declared; the observed counterpart is Resolver's consumer records, read through Resolver Control. Impact assessment for an application can then say:
   * what it is built from (Maintenance installations);
   * what it resolves at run time (Resolver Control dependencies).
3. **Propose: through Resolver Control's own capability.** When an ecosystem action needs a runtime change, Maintenance calls `changes.propose` as a principal with Resolver Control's `agent` role. Example: retarget `ref://prod/…` after a release.
   * Resolver Control validates, collects approvals from people (2 for critical), executes through its component and signer, and verifies.
   * Maintenance records the change id and reads the outcome.
   * Maintenance **cannot** approve or execute. Resolver Control's rules already refuse non-person approvals and approvals by the proposer.
4. **Not built yet, and not claimable:** AppBoundry-hosted execution of Resolver Control's component (gap A1). Under `feltkit dev`/`start` it works (Resolver Control's e2e).

### 3.3 Shared governance sequence (both domains)

```
propose → impact (declared + observed consumers, explicit unknowns)
        → validate (passed | failed | deferred, each labelled)
        → approve × N (people, not the proposer, not twice, prod_approver if protected, refused when frozen)
        → authorize (approval binds one plan digest / one change; re-checked at execution)
        → execute conditionally (expected revision / expected branch head / version absent)
        → reconcile (on lost answers: ask the authority, never assume)
        → verify (the authority serves exactly what was approved)
        → evidence (append-only)  →  adoption observed separately
```

| Stage | Releases (Maintenance) | References (Resolver Control) |
|---|---|---|
| Propose | `releases.propose` → `ReleasePlan` | `changes.propose` |
| Impact | `plan.dependents`, workspace pins, external installations | `computeImpact` |
| Validate | allocation, collision, private flag, workspace install. The CI build runs after approval | `checkBinding` and freshness. Catalog and schema checks are **deferred** |
| Approve | `checkApproval` (§6), digest-bound | `changes.approve` |
| Conditional execution | branch must equal the approved source; version must be absent; tags must be free | `expectedRevision` plus a signer authorization |
| Reconcile | deterministic release commit; tag target; registry integrity | jti or tag in Resolver history |
| Verify | registry bytes, integrity, dist-tag, tag target | history, binding, fresh resolution |
| Adoption | consumers' manifests, observed by the next scan (classification only) | fetched (observed) or adopted (asserted) |

---

## 4. Reuse versus new

| Need | Reuse | New (justified) |
|---|---|---|
| Roles, person-only approval, not-the-proposer, N-of-M, critical ≥ 2, protected, frozen, re-check at execution | **Resolver Control's rules**, ported to `src/governance/rules.ts` with the same role names | The release subject's adapter (approvals bind a plan digest) |
| Capabilities, MCP, sessions, audit-in-transaction, components with credential custody | **FeltKit / AppPort** (as Resolver Control uses them) | Maintenance as a FeltKit application (step 3). Not a new framework |
| Execution isolation, artifacts, evidence | **Boundry CI** | Narrow submit token (G5) |
| Registry, git and GitHub facts | Maintenance collectors and Release Manager adapters | crates publishing (Prompt 2) |
| Runtime reference governance | **Resolver Control, unchanged** | Nothing |
| Approval signer pattern (signing key outside the application) | Resolver Control's `signer/` | Not needed for releases yet: registries do not verify approval tokens. Recorded as G9 |
| Storage | FeltDB, as Resolver Control and Boundry CI use it | No new database, no new service, no sidecar |

**Rejected:**

* A third "governance service" between the two applications. It would be a third authority for approvals.
* Copying Resolver Control's collections into Maintenance.
* Giving Maintenance a Resolver key "for convenience".

---

## 5. Platform gap register

Evidence is code or a test unless stated. **Severity:** H means it blocks a claim the user asked for; M weakens it; L is a known limit.

| # | Gap | Evidence | Effect | Smallest closing change | Sev |
|---|---|---|---|---|---|
| G1 | **Maintenance identity is asserted.** `--as <id>` is trusted; nothing authenticates the person at the CLI | `src/index.ts` `release` | Separation of duties holds only if people do not impersonate each other on the operator's machine. Approvals are recorded `authentication: "asserted"` so the evidence says so | Step 3: run as a FeltKit app; identity from sessions; `authentication: "session"` | H |
| G2 | **Before this step: the proposer could approve their own release, and one approval sufficed for anything.** The end-to-end proof showed `randy` proposing and approving | `docs/releases/proof-resolver-train` (first run) | — | **Closed by §6** (tests in `test/governance.test.ts`) | closed |
| G3 | **No AppPort capabilities or MCP for Maintenance.** Agents can only use the CLI | `src/index.ts` | "All operations are AppPort capabilities" is **not true yet** for Maintenance. The capability table exists (§6), but no AppPort binding does | Step 3 | H |
| G4 | **Release records live in the working tree.** They are durable only once committed and pushed. Concurrency control is a local lock file | `src/release/manager.ts` `#locked`, `data/release-manager` | Two operators on two machines are not fenced | Step 3: FeltDB transactions (as Resolver Control's claim) | M |
| G5 | **Boundry CI operator token is all-powerful.** Submitting an execution needs the same token that administers CI | `boundry-ci/src/control/http.ts` | Maintenance holds more CI authority than it needs | Scoped `executions:submit` and `runs:read` token in Boundry CI | M |
| G6 | **crates.io release unsupported** | `ReleaseError("unsupported")` | Rust packages cannot be released | Prompt 2 | M |
| G7 | **AppBoundry cannot run components** (Resolver Control A1). It applies equally to Maintenance's future components | resolver-control `docs/PLATFORM-GAPS.md` A1 | A deployed artifact of either app cannot execute side effects. `feltkit start` can | AppBoundry: publish companion and runtime | H for hosted claims |
| G8 | **Resolver Control docs are stale.** They say Resolver 0.4.0 is "unpublished", but npm serves 0.4.0 (2026-11-12) and 0.4.1 (2026-11-16). Resolver Control vendors 0.4.0 tarballs | `npm view @appport/resolver time`; resolver-control `README.md`, `vendor/` | An operator would believe a published dependency is unpublished. The vendored bytes may differ from the published ones (unverified) | Compare vendored sha256 to npm `dist.integrity`; switch to the registry version | L |
| G9 | **Release approvals are not cryptographically bound.** A registry accepts any valid token, unlike Resolver 0.4.0, which verifies a signer's authorization | design | An administrator of Maintenance's store (today: anyone who can commit `data/`) could forge an approval record | Same as Resolver Control's open limit: approver-held keys. Not planned | L |
| G10 | **No cross-domain link** between applications and the references they resolve | `config/projects.json` has no reference field | Impact cannot yet say "this app also depends on `ref://prod/…`" | Step 4 | M |
| G11 | **Maintenance has no separate append-only audit log with request ids.** History lives inside each record | `ReleaseRecord.history` | Each record is append-only, but there is no global trail | Step 3: FeltKit `auditTrail` (as Resolver Control's `_audit.ts`) | L |
| G12 | **Boundry CI is not deployed.** The Hetzner prerequisites are not satisfied | boundry-ci `docs/` (Slice 2) | Releases can only build where an operator runs Boundry CI | Hetzner readiness steps (user decisions pending) | M |
| G13 | **One flaky test, not identified.** One failure in 4 runs of `npm test` in this repository, which did not recur in 3 targeted reruns | test output, 2026-11-17 | — | Find it with repeated runs | L |

---

## 6. Contract and schema changes (implemented now)

This is the smallest safe foundation, and it is the only code in this step. Scanning is unchanged: `maintenance.scan` is an `observe` capability, and no scan code was touched.

| Change | Where |
|---|---|
| `Criticality` (`low` / `medium` / `high` / `critical`), `PrincipalType` (`person` / `agent` / `component`), `Role` (Resolver Control's names), `Principal`, `PrincipalCatalog`, `Authentication` (`asserted` / `session`) | `src/contracts.ts` |
| `config/principals.json`, validated by `npm run validate`; schema `schemas/principals.schema.json`. The catalog itself refuses an agent holding approver or admin roles, and a non-component holding executor | `config/`, `schemas/` |
| `PackageConfig.criticality` (default `medium`) | `src/contracts.ts` |
| `ReleasePolicy.approvalsRequired` (default 1), `protected` (default **true**: a public registry is production), `frozen`, `freezeReason` | `src/contracts.ts` |
| `ReleasePlan.requestedByType`, `requiredApprovals` (critical ⇒ ≥ 2), `protected` (all bound into the plan digest) | `src/contracts.ts` |
| `ReleaseRecord` schema version 2: `approvals[]` (`by`, `principalType`, `authentication`, `at`, `planDigest`) and `revocation`. These replace the single `approval` | `src/contracts.ts` |
| Role → permission table; one capability table (`maintenance.scan`, `releases.list`, `releases.inspect`, `releases.propose`, `releases.approve`, `releases.withdraw`, `releases.execute`), each with its effect; `authorize`, `requiredApprovals`, `checkApproval` | `src/governance/rules.ts` |
| Release Manager enforces them at the domain level, not only in the CLI. Any later binding (AppPort) gets the same checks. The rules: propose needs `releases.propose`; approve needs a person who is not the proposer, has not approved before, holds `prod_approver` when protected, and acts while not frozen; execute needs `releases.trigger` (agents never have it); at execution, the current policy is re-checked (tightened → back to awaiting approval; frozen → waits); a plan that nobody could approve is refused at proposal | `src/release/manager.ts` |

**Evidence:** `test/governance.test.ts`, 8 tests. Among them:

* an agent proposes, cannot approve, cannot execute, and a person's approval then releases;
* the proposer is refused;
* a double approval is refused;
* an unknown principal is refused;
* critical needs 2;
* protected needs `prod_approver`;
* frozen waits;
* a tightened policy sends the release back for approval;
* an unapprovable plan is refused.

`npm run check`: 62 tests pass, and validation passes.

**Operational consequence (decision for the user):** with one person in `config/principals.json`, a release must be **proposed by someone else** (an engineer, or `maintenance-agent`) and approved by that person. A `critical` package cannot be released until a second person is added.

---

## 7. Incremental plan with acceptance criteria

| Step | Scope | Acceptance criteria |
|---|---|---|
| **0. Governance foundation** (done) | §6 | `test/governance.test.ts` passes. End-to-end proof re-run with agent-proposed, person-approved release; the agent's approval and execution are refused in the evidence |
| **1. Package Control completeness** (Prompt 2) | crates allocation and publish (yanked crates count as published); manifest/lockfile disagreement detected and refused; prereleases and 0.x; major bumps only with explicit policy; build failure vs test failure distinguished; impact reassessed when the registry, branch or consumers change before approval (new digest, approvals reset); validation results recorded as `passed`, `failed` or `deferred`; explicit unknowns in the plan; consumer adoption kept separate from consumer verification | Each listed case has a test that fails without the change. Lifecycle states are explicit, including skipped stages. Proof re-run |
| **2. Narrow CI authority** | Boundry CI submit-only token (G5) | Maintenance runs the proof with a token that cannot cancel or administer; that refusal is tested |
| **3. Maintenance as a FeltKit application** | Collections: `packages`, `releases`, `approvals`, `events`. Capabilities = the §6 table. Components `registry-npm`, `registry-crates`, `git`, `github-releases`, `ci-submit`, one credential each. Release execution runs in a component under the `executor` role. Identity from sessions. The CLI becomes an AppPort client. The scan and `data/` projection unchanged | Over MCP, an agent proposes and is refused approve and execute. Approvals record `authentication: "session"`. Two executors cannot double-execute (FeltDB conflict). No credential is visible to the guest (artifact test, as Resolver Control's) |
| **4. Resolver Control integration** (Prompt 3) | §3.2: read-only projection, application → reference links, proposals through `changes.propose` as an agent principal | Maintenance shows one application's build-time and run-time dependencies. A proposed reference change is approved by two people in Resolver Control and verified by a fresh resolution. Maintenance never holds the Resolver key (asserted by test). The agent is refused approval. AppBoundry-hosted execution is **not** claimed while A1 is open |
| **5. Deployment** | Only after the Hetzner prerequisites (Slice 2) and the user's approval | Independent health verification; no claim without it |
