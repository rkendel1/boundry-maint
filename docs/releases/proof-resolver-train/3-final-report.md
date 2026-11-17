# Release request: @appport/resolver 0.4.1 → **0.4.2**, @appport/resolver-client 0.3.0 → **0.3.1**, @appport/resolver-core 0.2.0 → **0.2.1**

Requested by maintenance-agent at 2026-11-17T00:40:16.890Z — “End-to-end proof of the Release Manager (resolver release train)”. State: **released**.

## What will happen, in order

1. A commit “Release @appport/resolver@0.4.2, @appport/resolver-client@0.3.1, @appport/resolver-core@0.2.1” is added on top of `aaab053651a9` on `main`, changing `package-lock.json`, `packages/client/package.json`, `packages/core/package.json`, `packages/server/package.json`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `@appport/resolver@0.4.2`, tag `@appport/resolver-client@0.3.1`, tag `@appport/resolver-core@0.2.1` on that commit. Existing tags are never moved.
4. Exactly those tarballs are published to http://127.0.0.1:4874 (dist-tag `latest`). A version already on the registry is never overwritten.
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
- 1 dependent manifest(s) found; none is changed or published by this release (see dependents).

## Who else is affected

- **feltkit** (rkendel1/feltkit:packages/sdk/package.json, declares `0.3.0`): pins 0.3.0 exactly: keeps using 0.3.0 until it is released with an updated pin

Dependents are **not** changed or published by this release. Each needs its own release request.

## What approving does not allow

- Any other version, commit, artifact, tag or registry than the ones above.
- Publishing dependents, re-tagging, or overwriting a published version.
- Continuing if the registry or the branch changes before publication: that requires a new plan.

## Approve

Proposed by **maintenance-agent** (agent), who may not approve it. Needs **1** approval(s) from distinct people holding the prod_approver role. Eligible: randy.

Approved so far: randy (asserted, 2026-11-17T00:40:17.775Z)

```bash
node src/index.ts release approve appport-resolver@0.4.2 --as <your principal id> --digest 38e9e5c1fc26de698578fd52f79cee6ce6c253ab5357ad350e378013dbe82ca2
```

## Evidence so far

- Release commit: `f3e19fbbfe1112233b02fb683d1ca403b14da849`
- Built by boundry-ci run `run_e53a50bab6a93365208fbe82`: `appport-resolver-0.4.2.tgz` sha256 `312ecf060a121326658aa8faf4f0060807ad364fddb0cc0a83b75205a637d3ad`, `appport-resolver-client-0.3.1.tgz` sha256 `eafb495680050af107e8cbfd82169186b6f654cf7cd2ff60b639a69665240664`, `appport-resolver-core-0.2.1.tgz` sha256 `b001e5edaaee97103e55647ad18856d24632d23fdd14a6a2d2ce193821ea179b`
- Tag `@appport/resolver@0.4.2` → `f3e19fbbfe11`
- Tag `@appport/resolver-client@0.3.1` → `f3e19fbbfe11`
- Tag `@appport/resolver-core@0.2.1` → `f3e19fbbfe11`
- Registry serves 0.4.2: integrity `sha512-mujrA+1DEDQDaSvpJ…`, bytes sha256 `312ecf060a121326…`, dist-tag points here
- Registry serves 0.3.1: integrity `sha512-k4T8jxl4P8ytaHzcr…`, bytes sha256 `eafb495680050af1…`, dist-tag points here
- Registry serves 0.2.1: integrity `sha512-gXGxWKf2SHcIeiZnT…`, bytes sha256 `b001e5edaaee9710…`, dist-tag points here
- GitHub release: http://127.0.0.1:34787/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver%400.4.2
- GitHub release: http://127.0.0.1:34787/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver-client%400.3.1
- GitHub release: http://127.0.0.1:34787/stand-in/rkendel1/resolver/releases/tag/%40appport%2Fresolver-core%400.2.1

Plan digest `38e9e5c1fc26de698578fd52f79cee6ce6c253ab5357ad350e378013dbe82ca2` · record `data/release-manager/appport-resolver/0.4.2.json`
