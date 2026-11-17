# Release request: boundry-proof-core 0.1.1 → **0.1.2**

Requested by maintenance-agent at 2026-11-17T12:55:26.912Z — “End-to-end proof of a Rust release (disposable crate, isolated registry)”. State: **released**.

## What will happen, in order

1. A commit “Release boundry-proof-core@0.1.2” is added on top of `af91218d46b5` on `main`, changing `Cargo.lock`, `crates/core/Cargo.toml`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `boundry-proof-core@0.1.2` on that commit. Existing tags are never moved.
4. Exactly that tarball is published to http://127.0.0.1:46803 (declared test registry) (dist-tag `latest`). A version already on the registry is never overwritten.
5. The registry is checked: it must serve 0.1.2 with the same integrity and the same bytes.
6. No GitHub release (policy).

## Why these versions

- The registry has 2 versions of boundry-proof-core; the highest ever published is 0.1.1.
- Yanked: 0.1.1. A yanked version stays published and is never reused, so it counts toward the highest version.
- The manifest at the source commit declares 0.1.0.
- Patch release from 0.1.1 gives 0.1.2 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.1).
- Version 0.1.2 is not on the registry and tag boundry-proof-core@0.1.2 does not exist.
- 1 dependent manifest(s) found; none is changed or published by this release (see dependents and, after release, the downstream proposals).

## Checks

| Check | Outcome | Detail |
|---|---|---|
| boundry-proof-core: publishable | **passed** | crates/core/Cargo.toml allows publishing |
| boundry-proof-core: registry | **passed** | http://127.0.0.1:46803 answered: 2 version(s) ever published, 1 yanked (0.1.1) |
| boundry-proof-core: manifest and Cargo.lock agree | **passed** | both say 0.1.0 |
| boundry-proof-core: version 0.1.2 free | **passed** | not on the registry (yanked versions included) and tag boundry-proof-core@0.1.2 does not exist |
| workspace version inheritance | **not-applicable** | no released package inherits its version |
| workspace install after the release commit | **passed** | every workspace sibling's requirement accepts the new version(s) |
| build and tests | **deferred** | run by Boundry CI on the exact release commit after approval (test); nothing is tagged or published unless they pass |
| registry acceptance | **deferred** | the registry decides ownership, name and metadata at publish; a refusal stops the release before anything else is published |
| consumer verification | **deferred** | a consumer's own checks on the new version are recorded after release (release consumers), never assumed |
| external consumers | **unavailable** | no installations data (run a scan): consumers in other repositories are unknown |

## Not known

- Consumers in other repositories: no scan data was available.
- Undeclared consumers (anything that installs these packages without appearing in Maintenance's scan) are not visible.

## Who else is affected

- **boundry-proof-app** (boundry-proof/crates:crates/app/Cargo.toml): declares `0.1` for boundry-proof-core, lockfile resolves `0.1.0`. requirement 0.1 accepts 0.1.2; it builds against the new version in the workspace

Dependents are **not** changed or published by this release. After release, the changes they need are listed as proposals for their own plans.

## What approving does not allow

- Any other version, commit, artifact, tag or registry than the ones above.
- Publishing dependents, re-tagging, or overwriting a published version.
- Continuing if the registry or the branch changes before publication: that requires a new plan.

## Approve

Proposed by **maintenance-agent** (agent), who may not approve it. Needs **1** approval(s) from distinct people holding the prod_approver role. Eligible: randy.

Approved so far: randy (signature, 2026-11-17T12:55:27.384Z)

Test registry only: an unsigned approval is accepted and recorded as `asserted` (not an authenticated approval).

```bash
node src/index.ts release approve boundry-proof-core@0.1.2 --as <you> --digest 17039aba042cf9c079faa7f07c0171ecf755c0933ebf5c24fc6b5dd5feeecdf1
```

## Evidence so far

- Release commit: `e01898148a6fedab290813debc95c18046ca26f5`
- Built by boundry-ci run `run_e429ead80bd1599f4deb0254`: `boundry-proof-core-0.1.2.crate` sha256 `a26d047fdf094de50aaf1e9a8f7e4989bfe34c55bec62c5f273171bec6b97df3`
- Tag `boundry-proof-core@0.1.2` → `e01898148a6f`
- Registry serves 0.1.2: integrity `a26d047fdf094de50aaf1e9a…`, bytes sha256 `a26d047fdf094de5…`, not yanked
- Claimed by component:release-executor at 2026-11-17T12:55:27.438Z (triggered by randy): withdrawal and rejection are closed
- Skipped github-release: skipped: the release policy does not create GitHub releases
- Consumer proof-consumer (boundry-proof/consumer:Cargo.toml) at 2026-11-17T12:56:00.966Z: installed 0.1 → resolved 0.1.2; adoption **adopted**; verification **verified** (proof: cargo generate-lockfile in a separate consumer project)

Plan digest `17039aba042cf9c079faa7f07c0171ecf755c0933ebf5c24fc6b5dd5feeecdf1` · record `data/release-manager/boundry-proof-core/0.1.2.json`
