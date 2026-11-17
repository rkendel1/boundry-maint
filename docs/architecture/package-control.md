# Package Control and the Release Manager (Prompt 2)

This document builds on `control-plane.md`: the separate-apps decision, the governance contract, signed approvals and least-privilege CI. It records what is implemented, what proves it, and what is not done.

## Lifecycle

```
proposed → validated → awaiting-approval → approved → prepared → built → tagged → published → registry-verified → released
              │                  │             │            (failed: recoverable, resumes at the last verified state)
              │                  │             └─ superseded: facts changed after approval (reassessed before execution)
              │                  └─ superseded: facts changed before approval (reassessed before approval)
              └─ refused at planning: any failed check
```

**Built before tagged.** This deliberately differs from the order in the prompt (`tagged → built`). A tag is pushed only after Boundry CI has built and tested the exact release commit, so a failed build never leaves a tag behind. Tags are never moved or deleted.

**Skipped stages are explicit.** A stage that does not apply (for example, a GitHub release when policy says none) is recorded as an attempt with outcome `skipped` and the reason. Nothing is silently omitted.

## Guarantees and where they are enforced

| Area | Behaviour | Code | Evidence |
|---|---|---|---|
| Independent registries | `NpmRegistry` and `CratesRegistry`, one credential each (`BOUNDRY_NPM_TOKEN_FILE`, `BOUNDRY_CRATES_TOKEN_FILE`). Each reports only what its registry says | `src/release/adapters.ts` | `test/crates-registry.test.ts` (over HTTP); the proofs |
| Version allocation | From the highest version ever published, compared as semver, never as strings. Yanked versions count as published and are never reused. Works for 0.x and prereleases | `src/release/version.ts` | `test/release-version.test.ts`; `package-control: yanked…` |
| Manifest vs lockfile | Disagreement refuses the plan, naming both values (`package-lock.json`, `Cargo.lock`) | `ecosystems.ts`, `#plan` | test; **real finding below** |
| Declared vs resolved | Each dependent carries `declared` (requirement), `resolved` (lockfile) and `accepts`, as separate fields | `#impact` | `package-control: consumers…` |
| Cargo workspaces | A crate that inherits `[workspace.package]` version cannot be released alone; a train edits the workspace version once. Exact sibling pins (`=x`) are refused alone and rewritten when released together | `ecosystems.ts`, `#plan` | tests; **live finding below** |
| Validation outcomes | Every check is recorded as `passed`, `failed`, `deferred` (says when it runs), `unavailable` or `not-applicable`, with explicit `unknowns` | `ReleasePlan.checks`, `unknowns` | `package-control: every check…` |
| Impact reassessment | Fingerprint of branch head, registry versions (including yanked), tag existence and external consumers. It is recomputed before approval and before execution starts, and any change supersedes the plan (approvals never carry over). A crash's own progress is recognised and is not treated as a change | `#facts`, `#reassess`, `#ownProgress` | tests |
| Approval binding | The approval binds the plan digest: versions, source commit, destinations, production flag, pins, checks and fingerprint. Production requires an SSH-signed approval statement | `decide()`, `signatures.ts` | `governance*.test.ts` |
| Recovery | Every external mutation is reconciled against its authority before retry: deterministic release commit, tag target, registry version and integrity. An unanswered publish is ambiguous, not failed | `#prepare`, `#publish` | tests 5–9; **both proofs inject a lost publish answer** |
| Yanked after publish | Not a verified release. Verification fails and says why | `#verify` | `package-control: yanked right after…` |
| Tests vs build | "The tests failed" and "the build failed (job)" are reported distinctly | `#build` | `package-control: tests failing…` |
| Consumers | Never changed by a release. After release, `downstream[]` lists proposals (`requirement-change` or `lockfile-update`), each needing its own plan and approval. `release consumers <id>` appends observations in which installation, adoption and verification are distinct; verification needs evidence | `downstreamProposals`, `observeConsumers` | `package-control: consumers…`; Rust proof |
| Execution authority | Builds run through a Boundry CI token scoped to `executions:submit,runs:read,artifacts:read`. Execution requests are build-only: no secrets, no release or deploy permission | boundry-ci `http.ts`, `core.ts` | boundry-ci test R12 |

## Findings from real repositories (read-only)

* **`rkendel1/resolver@aaab053` has a stale lockfile.** The commit "Release @appport/resolver 0.4.1" bumped `packages/server/package.json` to 0.4.1, but `package-lock.json` still records 0.4.0. That is the commit npm's 0.4.1 was published from. The planner refuses it (`docs/releases/proof-resolver-train-stale-lockfile-refused.md`). The npm proof then repairs the lockfile in a labelled commit (`npm install --package-lock-only`) and plans from there.
* **`rkendel1/rust-ml-runtime`: every crate inherits the workspace version.** Releasing `ml-runtime-common` alone is refused, naming the 10 other publishable crates that would change version with it (`docs/releases/live-plan-ml-runtime-common.md`, planned against the live crates.io index).

## Not done, or not demonstrated

* No production publication. No production credentials are configured, and production approvals need a registered SSH key (`config/principals.json` has none yet).
* Identity at the CLI is still asserted for test registries (contract: never sufficient for production).
* crates.io itself was read (index) but never written. The publish path was exercised only against the stand-in registry.
* A consumer's own CI is not yet linked as verification evidence automatically. Verification is recorded only when evidence is supplied.
* The Release Manager's state is still files in the repository (gap G4 in `control-plane.md`). Step 3 of the plan moves it to FeltDB.
