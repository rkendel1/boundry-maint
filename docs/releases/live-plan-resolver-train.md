<!-- Generated read-only by tools/release-proof/live-plan.ts at 2026-11-17T00:19:00.498Z against registry.npmjs.org and github.com. Not approved; not executed. -->

# Release request: @appport/resolver 0.4.1 → **0.4.2**, @appport/resolver-client 0.3.0 → **0.3.1**, @appport/resolver-core 0.2.0 → **0.2.1**

Requested by randy at 2026-11-17T00:18:55.324Z — “Proof of the release plan against the live registry and repository (not approved, not executed)”. State: **awaiting-approval**.

## What will happen, in order

1. A commit “Release @appport/resolver@0.4.2, @appport/resolver-client@0.3.1, @appport/resolver-core@0.2.1” is added on top of `aaab053651a9` on `main`, changing `package-lock.json`, `packages/client/package.json`, `packages/core/package.json`, `packages/server/package.json`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `@appport/resolver@0.4.2`, tag `@appport/resolver-client@0.3.1`, tag `@appport/resolver-core@0.2.1` on that commit. Existing tags are never moved.
4. Exactly that tarball is published to https://registry.npmjs.org (dist-tag `latest`, dist-tag `latest`, dist-tag `latest`). A version already on the registry is never overwritten.
5. The registry is checked: it must serve 0.4.2, 0.3.1, 0.2.1 with the same integrity and the same bytes.
6. A GitHub release is created for `@appport/resolver@0.4.2`, citing the commit, artifact digest and registry integrity.

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

Approvers: randy

```bash
node src/index.ts release approve appport-resolver@0.4.2 --as <your name> --digest fab33d4978e85f2ea489169cc9a038d554f6286be643d6aabc1ca2b5a63e1706
```

Plan digest `fab33d4978e85f2ea489169cc9a038d554f6286be643d6aabc1ca2b5a63e1706` · record `data/release-manager/appport-resolver/0.4.2.json`
