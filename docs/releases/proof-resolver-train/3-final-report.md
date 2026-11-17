# Release request: @appport/resolver 0.4.1 → **0.4.2**, @appport/resolver-client 0.3.0 → **0.3.1**, @appport/resolver-core 0.2.0 → **0.2.1**

Requested by maintenance-agent at 2026-11-17T01:37:42.027Z — “End-to-end proof of the Release Manager (resolver release train)”. State: **released**.

## What will happen, in order

1. A commit “Release @appport/resolver@0.4.2, @appport/resolver-client@0.3.1, @appport/resolver-core@0.2.1” is added on top of `99385866652a` on `main`, changing `package-lock.json`, `packages/client/package.json`, `packages/core/package.json`, `packages/server/package.json`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `@appport/resolver@0.4.2`, tag `@appport/resolver-client@0.3.1`, tag `@appport/resolver-core@0.2.1` on that commit. Existing tags are never moved.
4. Exactly those tarballs are published to http://127.0.0.1:4875 (declared test registry) (dist-tag `latest`). A version already on the registry is never overwritten.
5. The registry is checked: it must serve 0.4.2, 0.3.1, 0.2.1 with the same integrity and the same bytes.
6. A GitHub release is created for `@appport/resolver@0.4.2`, `@appport/resolver-client@0.3.1`, `@appport/resolver-core@0.2.1`, citing the commit, artifact digests and registry integrity.

## Why these versions

- The registry has 9 versions of @appport/resolver; the highest ever published is 0.4.1.
- The manifest at the source commit declares 0.4.1.
- Patch release from 0.4.1 gives 0.4.2 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.4).
- Version 0.4.2 is not on the registry and tag @appport/resolver@0.4.2 does not exist.
- The registry has 8 versions of @appport/resolver-client; the highest ever published is 0.3.0.
- The manifest at the source commit declares 0.3.0.
- Patch release from 0.3.0 gives 0.3.1 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.3).
- Version 0.3.1 is not on the registry and tag @appport/resolver-client@0.3.1 does not exist.
- The registry has 4 versions of @appport/resolver-core; the highest ever published is 0.2.0.
- The manifest at the source commit declares 0.2.0.
- Patch release from 0.2.0 gives 0.2.1 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.2).
- Version 0.2.1 is not on the registry and tag @appport/resolver-core@0.2.1 does not exist.
- 1 dependent manifest(s) found; none is changed or published by this release (see dependents and, after release, the downstream proposals).

## Checks

| Check | Outcome | Detail |
|---|---|---|
| @appport/resolver: publishable | **passed** | packages/server/package.json allows publishing |
| @appport/resolver: registry | **passed** | http://127.0.0.1:4875 answered: 9 version(s) ever published |
| @appport/resolver: manifest and package-lock.json agree | **passed** | both say 0.4.1 |
| @appport/resolver: version 0.4.2 free | **passed** | not on the registry (yanked versions included) and tag @appport/resolver@0.4.2 does not exist |
| @appport/resolver-client: publishable | **passed** | packages/client/package.json allows publishing |
| @appport/resolver-client: registry | **passed** | http://127.0.0.1:4875 answered: 8 version(s) ever published |
| @appport/resolver-client: manifest and package-lock.json agree | **passed** | both say 0.3.0 |
| @appport/resolver-client: version 0.3.1 free | **passed** | not on the registry (yanked versions included) and tag @appport/resolver-client@0.3.1 does not exist |
| @appport/resolver-core: publishable | **passed** | packages/core/package.json allows publishing |
| @appport/resolver-core: registry | **passed** | http://127.0.0.1:4875 answered: 4 version(s) ever published |
| @appport/resolver-core: manifest and package-lock.json agree | **passed** | both say 0.2.0 |
| @appport/resolver-core: version 0.2.1 free | **passed** | not on the registry (yanked versions included) and tag @appport/resolver-core@0.2.1 does not exist |
| workspace version inheritance | **not-applicable** | no released package inherits its version |
| workspace install after the release commit | **passed** | 3 in-plan requirement(s) rewritten; every workspace sibling's requirement accepts the new version(s) |
| build and tests | **deferred** | run by Boundry CI on the exact release commit after approval (test); nothing is tagged or published unless they pass |
| registry acceptance | **deferred** | the registry decides ownership, name and metadata at publish; a refusal stops the release before anything else is published |
| consumer verification | **deferred** | a consumer's own checks on the new version are recorded after release (release consumers), never assumed |
| external consumers | **passed** | 1 external dependent manifest(s) from the latest scan |

## Not known

- Undeclared consumers (anything that installs these packages without appearing in Maintenance's scan) are not visible.

## Who else is affected

- **feltkit** (rkendel1/feltkit:packages/sdk/package.json): declares `0.3.0` for @appport/resolver-client, lockfile resolves `0.3.0`. pins 0.3.0 exactly: keeps using it until a requirement change (its own plan)

Dependents are **not** changed or published by this release. After release, the changes they need are listed as proposals for their own plans.

## What approving does not allow

- Any other version, commit, artifact, tag or registry than the ones above.
- Publishing dependents, re-tagging, or overwriting a published version.
- Continuing if the registry or the branch changes before publication: that requires a new plan.

## Approve

Proposed by **maintenance-agent** (agent), who may not approve it. Needs **1** approval(s) from distinct people holding the prod_approver role. Eligible: randy.

Approved so far: randy (asserted, 2026-11-17T01:37:43.637Z)

Test registry only: an unsigned approval is accepted and recorded as `asserted` (not an authenticated approval).

```bash
node src/index.ts release approve appport-resolver@0.4.2 --as <you> --digest 0c9abf10b85cdf0ca89cdd3ddb40af1b6556956e24a692f57d70bf4ea2e04897
```

## Evidence so far

- Release commit: `df70ca12d7baf95dbf157b8352c589af702683b7`
- Built by boundry-ci run `run_aebf83650374724391632644`: `appport-resolver-0.4.2.tgz` sha256 `312ecf060a121326658aa8faf4f0060807ad364fddb0cc0a83b75205a637d3ad`, `appport-resolver-client-0.3.1.tgz` sha256 `eafb495680050af107e8cbfd82169186b6f654cf7cd2ff60b639a69665240664`, `appport-resolver-core-0.2.1.tgz` sha256 `b001e5edaaee97103e55647ad18856d24632d23fdd14a6a2d2ce193821ea179b`
- Tag `@appport/resolver@0.4.2` → `df70ca12d7ba`
- Tag `@appport/resolver-client@0.3.1` → `df70ca12d7ba`
- Tag `@appport/resolver-core@0.2.1` → `df70ca12d7ba`
- Registry serves 0.4.2: integrity `sha512-mujrA+1DEDQDaSvpJ…`, bytes sha256 `312ecf060a121326…`, dist-tag points here
- Registry serves 0.3.1: integrity `sha512-k4T8jxl4P8ytaHzcr…`, bytes sha256 `eafb495680050af1…`, dist-tag points here
- Registry serves 0.2.1: integrity `sha512-gXGxWKf2SHcIeiZnT…`, bytes sha256 `b001e5edaaee9710…`, dist-tag points here
- GitHub release: http://127.0.0.1:43859/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver%400.4.2
- GitHub release: http://127.0.0.1:43859/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver-client%400.3.1
- GitHub release: http://127.0.0.1:43859/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver-core%400.2.1
- Proposed for feltkit (rkendel1/feltkit:packages/sdk/package.json): requirement-change @appport/resolver-client `0.3.0` → `0.3.1` (proposed; needs its own plan)

Plan digest `0c9abf10b85cdf0ca89cdd3ddb40af1b6556956e24a692f57d70bf4ea2e04897` · record `data/release-manager/appport-resolver/0.4.2.json`
