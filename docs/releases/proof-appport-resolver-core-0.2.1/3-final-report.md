# Release request: @appport/resolver-core 0.2.0 → **0.2.1**

Requested by randy at 2026-11-17T00:15:09.402Z — “End-to-end proof of the Release Manager”. State: **prepared**.

## What will happen, in order

1. A commit “Release @appport/resolver-core@0.2.1” is added on top of `aaab053651a9` on `main`, changing `package-lock.json`, `packages/core/package.json`. If `main` has moved, the release stops.
2. Boundry CI runs the tests on that exact commit and packages it. The package's SHA-256 is recorded.
3. Only after the build succeeds: tag `@appport/resolver-core@0.2.1` on that commit. Existing tags are never moved.
4. Exactly that tarball is published to http://127.0.0.1:4874 (dist-tag `latest`). A version already on the registry is never overwritten.
5. The registry is checked: it must serve 0.2.1 with the same integrity and the same bytes.
6. A GitHub release is created for `@appport/resolver-core@0.2.1`, citing the commit, artifact digest and registry integrity.

## Why these versions

- The registry has 4 versions of @appport/resolver-core; the highest ever published is 0.2.0.
- The manifest at the source commit declares 0.2.0.
- Patch release from 0.2.0 gives 0.2.1 (0.x: under semver a patch bump of a 0.x version is the compatible channel for consumers using ^0.2).
- Version 0.2.1 is not on the registry and tag @appport/resolver-core@0.2.1 does not exist.
- 2 dependent manifest(s) found; none is changed or published by this release (see dependents).

## Who else is affected

- **@appport/resolver-client** (rkendel1/resolver:packages/client/package.json, declares `0.2.0`): pins 0.2.0 exactly: keeps using 0.2.0 until it is released with an updated pin
- **@appport/resolver** (rkendel1/resolver:packages/server/package.json, declares `0.2.0`): pins 0.2.0 exactly: keeps using 0.2.0 until it is released with an updated pin

Dependents are **not** changed or published by this release. Each needs its own release request.

## What approving does not allow

- Any other version, commit, artifact, tag or registry than the ones above.
- Publishing dependents, re-tagging, or overwriting a published version.
- Continuing if the registry or the branch changes before publication: that requires a new plan.

## Approve

Approvers: randy

```bash
node src/index.ts release approve appport-resolver-core@0.2.1 --as <your name> --digest 5fcde4ab404b6e23f6c9f58a3bbb5376dbae1147371cff114cd2dd21a0c0c2df
```

## Evidence so far

- Release commit: `ca3b0bf15daeaedceee69ff9a8dc057397fda5b0`
- **Stopped at prepared:** release build run_e0fe52cf5f301ac719c23f60 failed; nothing was tagged or published (recoverable: run execute again)

Plan digest `5fcde4ab404b6e23f6c9f58a3bbb5376dbae1147371cff114cd2dd21a0c0c2df` · record `data/release-manager/appport-resolver-core/0.2.1.json`
