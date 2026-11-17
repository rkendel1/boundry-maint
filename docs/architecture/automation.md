# Boundry Maintenance as the ecosystem automation and release authority

Status: architecture map for Slice 1 (Recipes, Execution and Release Management). Written after inspecting
`rkendel1/boundry-maint@5bc45cb` and `rkendel1/boundry-ci@fa1d9fb`, before implementation.

## One authority, one execution substrate

```
                     Boundry Maintenance  (ecosystem authority — this repository)
   config/ (curated)   ──►  observation pipeline (scan)  ──►  data/ (generated, committed, validated)
                                    │                                │
                                    ▼                                ▼
                          Release Manager (new)  ───────────►  data/release-manager/  (plans, approvals,
                          version allocation · release plans        lifecycle, attempts, evidence;
                          approvals · lifecycle · reconciliation    append-only history; committed)
                                    │  side-effect adapters (narrow, reconciling)
              ┌──────────────┬──────┴─────────┬──────────────────┐
              ▼              ▼                ▼                  ▼
        Git (authority   Boundry CI       npm registry      GitHub Releases
        for commits      (execution:      (authority for    (authority for
        and tags)        build/test/pack   published         release pages)
                         → artifact digest) versions)
```

Boundry Maintenance decides **what should be true** (which version, which commit, which artifact, which
destination) and records **what is true** (verified against each external authority). Boundry CI runs
untrusted repository code in isolation and returns durable execution evidence; it never decides versions,
release state or installation status.

## What exists, what is reused, what is extended, what stays separate

| Responsibility | Exists today | Decision |
|---|---|---|
| Package inventory, ownership, repository + directory | `config/packages.json`, `PackageConfig` | **Reuse** as the release unit catalog. Extend `PackageConfig` with an optional `release` policy. |
| Consumers of each package | `config/projects.json`, `data/installations.json` | **Reuse** for dependent/consumer impact in release plans. |
| Published versions (registry authority) | `collectors/npm.ts`, `collectors/crates.ts` (yanked, deprecated, dist-tags) | **Reuse** for allocation and for post-publish verification; registry base URL made configurable so a stand-in registry can be used. |
| Version comparison | `version/compare.ts` (semver, never strings) | **Reuse**; add allocation (`semver.inc`, prerelease ids) beside it. |
| GitHub repository and release facts | `collectors/github.ts` (read-only) | **Reuse** for reads. GitHub *writes* (release creation) are a new, separate adapter with its own credential. |
| Atomic generated data, zod contracts, validation | `lib/files.ts` `writeAllAtomic`, `contracts.ts`, `validate` | **Reuse**. Release records are new contracts in `contracts.ts` and new files under `data/`, validated by `npm run validate`. |
| Append-only evidence | `data/evidence/<project>.json` | **Pattern reused**: release evidence is append-only inside each release record. |
| Maintenance lifecycle + explicit signals | `status/maintenance.ts`, `data/events.json` | **Unchanged.** A release never moves a maintenance item by itself; the next scan observes the new registry version and the normal lifecycle applies. |
| CI enforcement discovery and results | `ci/*`, `data/ci.json` | **Unchanged.** Execution evidence from Boundry CI is a different fact from GitHub Actions results and is not mixed into CI Health. |
| Dashboard, badges | `reports/`, `public/` | **Projection only.** A Releases-in-progress panel can be added later; it never becomes authoritative. |
| Job execution, isolation, retries, logs, artifacts, attempts | `boundry-ci` (scheduler, workers, executor, CAS, FeltDB execution state) | **Reuse as the execution substrate.** Maintenance submits an execution request; Boundry CI returns run evidence and artifact digests. No second scheduler or job store. |
| Recipes, capability catalog, deterministic compiler | `boundry-ci/src/recipes` (prototype, proven on 3 real repositories) | **Ownership moves to Maintenance** (it decides what work means). This slice consumes the compiler through Boundry CI's API; physically moving the code is a follow-up once the boundary is proven, to avoid two copies. |
| Release decisions, version allocation, tags, publishing, GitHub releases | nothing (V1 never publishes) | **New: Release Manager** in this repository. |

## Release Manager boundaries

- **Version authority stays external.** The registry owns published versions; Git owns commits and tags;
  manifests and lockfiles own declared versions. The Release Manager reads all of them before every decision and
  never treats its own records as proof that something happened.
- **Publishing credentials never meet repository code.** Boundry CI build workers run project scripts with
  build permissions only and no secrets. The Release Manager performs the few side effects itself (commit + tag
  push, registry publish of the exact built tarball, GitHub release) through narrow adapters, and never executes
  repository code. This is the strict separation between build authority and release authority.
- **An approval authorizes one plan.** It binds the plan digest: package(s), version(s), source commit,
  destination registry and tag names. Anything that changes the plan (a newer registry version, a moved branch)
  invalidates the approval.
- **Recovery reconciles.** Every non-idempotent step first inspects the authority: is the commit there, does the
  tag exist and where does it point, is the version on the registry and with which integrity, does the GitHub
  release exist. Only a step that verifiably has not happened is performed.

## State: no new database

The committed `data/` model is preserved. Release plans, approvals, lifecycle transitions, attempts and evidence
live in `data/release-manager/<package-id>/<version>.json`, validated by zod and written atomically, with
append-only history. The one genuinely transactional need, *one active release per package*, is an exclusive
lock in a non-committed runtime directory. Boundry CI keeps its own FeltDB for execution state (leases,
attempts), which is not ecosystem state.

## Evidence found while mapping (relevant to release design)

- `appport` and `resolver` publish with **no git tags and no GitHub releases** at all.
- `flow_db`'s newest tag `v0.18.0` matches none of its 11 packages' versions, and its newest GitHub release is
  `rust_crate_feltdb_0.2.0`: in multi-package repositories a bare `vX.Y.Z` tag cannot say *which* package was
  released. The Release Manager uses per-package tags: `<package name>@<version>` (e.g. `@appport/resolver-core@0.2.1`).
- Committed `data/packages.json` (2026-11-16 07:40Z) says `@appport/resolver` is 0.4.0; npm already serves 0.4.1.
  Snapshots go stale; release decisions re-read the registry.
- Existing publish scripts (`resolver/scripts/publish-packages.mjs`) skip a version if it is already published
  but rebuild and republish otherwise, with no tag, no recorded artifact digest and no verification: the Release
  Manager replaces this per-repository logic with one verified lifecycle.
