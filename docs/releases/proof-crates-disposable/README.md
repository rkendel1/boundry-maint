# End-to-end proof: Rust release (disposable crate, isolated registry)

The proof is `tools/release-proof/run-proof-crates.ts`, run on 2026-11-17. Nothing touched crates.io.

## Setup

| Part | What ran |
|---|---|
| Source | a disposable Cargo workspace: `boundry-proof-core` (publishable) and `boundry-proof-app` (`publish = false`, depends on core `"0.1"` by path), with a real `Cargo.lock`. It sits in a bare git repository |
| Registry | `tools/release-proof/crates-standin.ts` (sparse index and publish API), seeded by `cargo package` with **0.1.0 and 0.1.1, then 0.1.1 yanked** |
| Build | Boundry CI with the `boundry-toolchain/rust:1` image, recipe step "Package the crates." (`cargo package --locked --workspace`), and a **build-only token** |
| Approval | **signed**: an SSH key generated for this proof and registered to `randy` for this run only |

## What happened

1. **Allocation went past the yanked version.** The highest version ever published is 0.1.1, which is yanked and therefore never reused, so the plan proposes **0.1.2**.
2. The release was proposed by `maintenance-agent`. Three attempts were refused, and the refusals are recorded:
   * approval by the agent (`person-only`);
   * execution triggered by the agent (`forbidden-effect`);
   * `randy`'s approval with a valid signature over a *different* statement (`unauthenticated-for-production`).
3. `randy` approved with a valid signature over the exact approval statement (`2-approval-statement.json` and its `.sig`), recorded as `authentication: "signature"`. At the start of execution, the release executor re-verified it.
4. Lifecycle: `proposed → validated → awaiting-approval → approved → prepared → built → tagged → published → registry-verified → released`. The GitHub release was **skipped** by policy, and the skip is recorded as such.
5. **Ambiguous publish.** The registry stored 0.1.2 and dropped the connection without answering. The Release Manager asked the registry, found the exact checksum, and recorded `already-done`. The registry received exactly **one** publish request.
6. A **separate Cargo project** declaring `boundry-proof-core = "0.1"` resolved **0.1.2**, never the yanked 0.1.1, then built and ran, printing `42`. The consumer was then recorded as installed (`0.1` → `0.1.2`), adopted, and verified, with that run as evidence.

## Independent verification (`6-independent-verification.json`)

* **Git.** The release commit's parent is the approved source. The tag points at the release commit. `Cargo.toml` and `Cargo.lock` both say 0.1.2 at the tag. Only those two files changed.
* **Registry.** The index checksum equals the sha256 of the CI-built `.crate`, and the served bytes are identical. 0.1.0's checksum is unchanged, and 0.1.1 is still yanked.
* **Boundry CI.** The run built exactly the release commit. Jobs `tests` and `step-package-crates` succeeded.

## Limits

* The crate and the registry are disposable. crates.io itself was only read, by the live plan of `ml-runtime-common`, and never written.
* The consumer is a project created by the proof, not a real downstream application.
