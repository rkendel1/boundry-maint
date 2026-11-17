# Production readiness record: Boundry Maintenance, Resolver Control, Boundry CI

**Verdict: not production-ready.** Everything below that is marked *implemented and tested* works under test and
in controlled exercises on real persisted state. Production stays blocked on human and custody prerequisites (§4),
which code cannot satisfy and which this record does not pretend to satisfy.

Recorded 2026-11-17. This is the operational baseline; update it whenever a commit, contract version or prerequisite
changes.

## 1. What was tested, exactly

All three repositories, branch `claude/upbeat-heisenberg-j0e1gj`:

| Repository | Evidence run at | Final head |
|---|---|---|
| rkendel1/boundry-maint | `b97558a` | `32a38f5` (contract 1.2.1, editorial; §5) plus this record and the regenerated evidence |
| rkendel1/resolver-control | `19851c3` | `30193b2` (vendors 1.2.1; no code change) |
| rkendel1/boundry-ci | `1070bd3` | `1070bd3` |

None of this is on any `main` branch yet. `boundry-ci` has no `main` branch at all.

**Governance contract** `boundry.governance`. The evidence run used 1.2.0; the final heads use **1.2.1**, which is
editorial only: no rule, definition or vector changed (§5). Pinned digests at the final heads, identical in both
applications:

| File | sha256 |
|---|---|
| `contract.json` | `bca29dec…` |
| `vectors.json` | `cae84c28…` |
| `SPEC.md` | `96d38028…` |

**Governance root of trust as committed:** `config/principals.json` sha256 `d9141400…`. It declares one person
(`randy`: admin, engineer, prod_approver, **no signing key**), `maintenance-agent` and `component:release-executor`.

**Evidence run.** Fresh clones of the three commits above, run one after another on this host, all exiting 0:

| Step | Result |
|---|---|
| boundry-maint `npm run check` | 167 pass, 0 fail |
| boundry-ci `npm test` / e2e | 47 pass / 1 pass |
| resolver-control `npm test` / artifact / e2e | 93 pass / 1 pass / 2 pass |
| npm acceptance proof (`docs/releases/proof-resolver-train/`) | released; record schema 3 with claim; lost publish reconciled as `already-done`; integrity and bytes match; 3 refusals recorded |
| Cargo acceptance proof (`docs/releases/proof-crates-disposable/`) | released 0.1.2; signed approval; checksum and bytes match; exactly 1 publish request; yanked 0.1.1 untouched; consumer verified from its evidence record |
| integration proof (`docs/integration/proof-shop/`) | 14 cross-authority attempts, 0 allowed |
| operational failure exercise (`docs/readiness/ops-exercise/`) | 13 of 13 scenarios pass |

**Final-head re-test.** Fresh clones of `32a38f5` and `30193b2`: boundry-maint 167 pass; resolver-control 93 pass,
artifact 1 pass; conformance against `boundry.governance@1.2.1`: 43 conform, 13 not applicable, 0 divergences.

## 2. Implemented and tested

| Capability | Evidence |
|---|---|
| Release lifecycle: plan → approve → claim → prepare → build → tag → publish → registry-verify → release | npm acceptance proof (real resolver source, real npmjs tarballs in Verdaccio, Boundry CI); Cargo acceptance proof (disposable crate, stand-in registry, Boundry CI with the pinned Rust image) |
| Never overwrite or reuse a published version; yanked versions are taken | tests; Cargo proof (allocation past yanked 0.1.1) |
| Manifest/lockfile disagreement refused | test; **real finding**: rkendel1/resolver `aaab053` (refused in the npm proof, then repaired in a labelled commit) |
| Workspace version inheritance (Cargo) | test; live read-only plan of rkendel1/rust-ml-runtime against crates.io |
| Governance contract enforced in both applications | Maintenance: all 56 vectors (`decide()`); Resolver Control: 43 conform, 13 not applicable (reasons recorded), 0 divergences |
| Claim ends withdrawal; person-only abandonment after reconciliation; replacement needs reconciliation and never reuses a claimed version | `test/abandon.test.ts`; RC `tests/governance-abandon.test.ts`; exercise S4, S7, S8, S8b |
| Crash recovery and ambiguous publish reconciliation | exercise S5 (real SIGKILL), S6 (connection cut after the registry stored the publish); both proofs |
| Production refuses missing or invalid identity evidence | `test/readiness-identity.test.ts` with the committed principals: asserted names, unregistered keys, edited records (refused before the claim), token-only AppPort approvals |
| Separate authorities: Maintenance cannot write Resolver; Resolver Control cannot publish; agents cannot approve or execute | integration proof (14 cross-authority attempts, all refused by the owning authority) |
| Least-privilege CI: build-only execution tokens, no secrets for execution requests | boundry-ci test R12; every proof uses the scoped token |
| Consumer facts kept separate: installed, adopted, verified (from the consumer's own CI evidence for the exact version), release verification | `test/consumer-verification.test.ts` (11 tests: wrong version, wrong manifest, older commit, incomplete workflow, no CI, and the real 251 installations); exercise S9, S9a, S10 |

## 3. Defects found during readiness work (all fixed, each covered by a test)

| Found by | Defect | Fix |
|---|---|---|
| exercise S1–S3 | A version withdrawn before any claim could never be planned again (record id = package@version) | A new plan gets its own record (`<pkg>@<version>_r<n>`); the withdrawn record is kept |
| exercise S5 | That fix's first id used `~`, which Boundry CI's request-id rule refuses (400, after the release commit had been pushed) | `_` separator; the test checks ids against CI's actual pattern. The fakes in unit tests had accepted any id |
| exercise S9 | `release consumers` silently observed nothing when `installations.json` was invalid | Explicit refusal; nothing recorded (exercise S9a) |
| review | A claimed release that failed fatally did not reserve its version | Reserved, like an abandoned one |
| digest check | `SPEC.md` drifted from its pin with no version change (§5) | Contract 1.2.1: status moved to `CONFORMANCE.md` |
| earlier phases | Concurrent plans could overwrite each other; lock release race | Atomic locks with stress tests (fail 8/8 before, pass after) |

## 4. Production prerequisites and owners

| # | Prerequisite | State | Owner |
|---|---|---|---|
| P1 | An independent second human reviewer for principals, roles, criticality, approval policies, registry destinations | **Not designated** | Randy (accountable owner) designates |
| P2 | Branch protection and CODEOWNERS for `config/principals.json`, `config/packages.json`, `config/policies.json`, `contracts/governance/`; verified to require that reviewer | **Absent**: no branch is protected in any of the three repositories (GitHub, 2026-11-17), no CODEOWNERS file exists | Randy, once P1 is done |
| P3 | SSH approval keys registered for each approver, through a custody process (who generates, where the private key lives, rotation, revocation) | **None registered**; process not defined | Randy + P1 reviewer |
| P4 | Production registry credentials (npm, crates.io) in the intended custody (secret files read by the registry adapters only) | **Not configured**; custody process not defined | Randy |
| P5 | Production identity for AppPort/MCP approvals | **Design gap.** Bearer tokens identify a client process, not a person; such approvals are `asserted` and refused for production unless they carry an SSH signature. Options to decide: (a) production approvals only through the signed-statement path (works today, no new system); (b) platform sessions with real per-person authentication (FeltKit/AppBoundry accounts), recorded as `session` | Randy decides |
| P6 | Resolver Control production identity | Under `feltkit dev`, sessions are created by an operator command: equivalent to asserted. Production needs real accounts | Randy (Resolver Control deployment) |
| P7 | Critical production releases need two distinct people | Impossible with one person; correctly refused at planning | follows from P1 |
| P8 | Merge to `main` with review | Nothing is merged; all work is on feature branches | Randy |
| P9 | Toolchain image availability | The pinned Rust image (`add5bb0d…`) exists only in this host's image store and is not reproducible from its Dockerfile (a rebuild gave `a989e6ae…` with the same toolchain versions). If the store is lost, Rust jobs are refused until a reviewed pin change. Publish pinned images to a registry by digest | Boundry CI owner (Randy) |
| P10 | Hosting (Hetzner) for Boundry CI | Deployment-readiness prerequisites from the earlier slice remain unmet; nothing is deployed | Randy |

**Explicitly not done, by decision:** production publication; synthetic principals or keys; policy changes;
AppBoundry component hosting; migrating records to FeltDB; automatic consumer updates; AI approval or execution.

## 5. Known limitations of the evidence

- The disposable consumer in the Cargo proof has no real CI. Its evidence record is the proof's own `cargo run`, labelled as a stand-in.
- The integration proof builds with a local packing executor (labelled); Boundry CI execution is proven by the two release proofs and the exercise.
- Resolver Control's conformance has 13 vectors not applicable to it, each with a recorded reason (for example trigger, digest argument, per-change allowlist, production authentication level).
- `agent-obstacle` (2 installations) has no CI at all; its consumers stay unverified by design.
- Contract 1.2.1 was cut after the evidence run (editorial only). The final heads were re-tested with the suites listed in §1; the proofs and the exercise were not re-run for an editorial change.
