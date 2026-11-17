# Release request: @demo/core 0.2.0 → **0.2.1**

Requested by maintenance-agent at 2026-11-17T13:19:29.711Z — “Integration proof: package side”. State: **released**.

## What will happen, in order

1. A commit “Release @demo/core@0.2.1” is added on top of `41153856234b` on `main`, changing `package-lock.json`, `packages/core/package.json`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `@demo/core@0.2.1` on that commit. Existing tags are never moved.
4. Exactly that tarball is published to http://127.0.0.1:49085 (declared test registry) (dist-tag `latest`). A version already on the registry is never overwritten.
5. The registry is checked: it must serve 0.2.1 with the same integrity and the same bytes.
6. No GitHub release (policy).

## Why these versions

- The registry has 1 version of @demo/core; the highest ever published is 0.2.0.
- The manifest at the source commit declares 0.2.0.
- Patch release from 0.2.0 gives 0.2.1 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.2).
- Version 0.2.1 is not on the registry and tag @demo/core@0.2.1 does not exist.
- 2 dependent manifest(s) found; none is changed or published by this release (see dependents and, after release, the downstream proposals).

## Checks

| Check | Outcome | Detail |
|---|---|---|
| @demo/core: publishable | **passed** | packages/core/package.json allows publishing |
| @demo/core: registry | **passed** | http://127.0.0.1:49085 answered: 1 version(s) ever published |
| @demo/core: manifest and package-lock.json agree | **passed** | both say 0.2.0 |
| @demo/core: version 0.2.1 free | **passed** | not on the registry (yanked versions included) and tag @demo/core@0.2.1 does not exist |
| workspace version inheritance | **not-applicable** | no released package inherits its version |
| workspace install after the release commit | **passed** | every workspace sibling's requirement accepts the new version(s) |
| build and tests | **deferred** | run by Boundry CI on the exact release commit after approval (test); nothing is tagged or published unless they pass |
| registry acceptance | **deferred** | the registry decides ownership, name and metadata at publish; a refusal stops the release before anything else is published |
| consumer verification | **deferred** | a consumer's own checks on the new version are recorded after release (release consumers), never assumed |
| external consumers | **passed** | 1 external dependent manifest(s) from the latest scan |

## Not known

- Undeclared consumers (anything that installs these packages without appearing in Maintenance's scan) are not visible.

## Who else is affected

- **@demo/client** (acme/demo:packages/client/package.json): declares `^0.2.0` for @demo/core, lockfile resolves `0.2.0`. requirement ^0.2.0 accepts 0.2.1; it builds against the new version in the workspace
- **shop** (acme/shop:package.json): declares `0.2.0` for @demo/core, lockfile resolves `0.2.0`. pins 0.2.0 exactly: keeps using it until a requirement change (its own plan)

Dependents are **not** changed or published by this release. After release, the changes they need are listed as proposals for their own plans.

## What approving does not allow

- Any other version, commit, artifact, tag or registry than the ones above.
- Publishing dependents, re-tagging, or overwriting a published version.
- Continuing if the registry or the branch changes before publication: that requires a new plan.

## Approve

Proposed by **maintenance-agent** (agent), who may not approve it. Needs **1** approval(s) from distinct people holding the prod_approver role. Eligible: randy.

Approved so far: randy (asserted, 2026-11-17T13:19:30.530Z)

Test registry only: an unsigned approval is accepted and recorded as `asserted` (not an authenticated approval).

```bash
node src/index.ts release approve demo-core@0.2.1 --as <you> --digest 6d67eb08243c58619ebfd71c26a1594748c4de66825b1f824cfa52c98812cccd
```

## Evidence so far

- Release commit: `2b878b3e26e4d716b767d2e5ef1c9e48a25424d3`
- Built by boundry-ci run `run_1`: `demo-core-0.2.1.tgz` sha256 `dbb4c334dba272010bbfb083621e03ea7007f8af7bec07a7838f43891016e3b6`
- Tag `@demo/core@0.2.1` → `2b878b3e26e4`
- Registry serves 0.2.1: integrity `sha512-T9uQpyXJI5BXK3u4N…`, bytes sha256 `dbb4c334dba27201…`, dist-tag points here
- Claimed by component:release-executor at 2026-11-17T13:19:30.693Z (triggered by randy): withdrawal and rejection are closed
- Skipped github-release: skipped: the release policy does not create GitHub releases
- Proposed for shop (acme/shop:package.json): requirement-change @demo/core `0.2.0` → `0.2.1` (proposed; needs its own plan)

Plan digest `6d67eb08243c58619ebfd71c26a1594748c4de66825b1f824cfa52c98812cccd` · record `data/release-manager/demo-core/0.2.1.json`
