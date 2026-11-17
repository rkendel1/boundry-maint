# End-to-end proof: resolver release train (npm, stand-in registry)

The proof is `tools/release-proof/run-proof.ts`, run on 2026-11-17. Nothing was published to npmjs.org, and nothing was pushed to GitHub.

## Setup

| Part | What ran |
|---|---|
| Source | a bare git repository seeded with the real `rkendel1/resolver` at `aaab053` |
| Registry | Verdaccio 6.2.4 on 127.0.0.1:4874, seeded with the **real** npmjs tarballs of every published version of the three packages. Release traffic went through 127.0.0.1:4875, a path that cuts the connection after the first publish is stored |
| Build | Boundry CI (FeltDB, control plane with `BCI_SCM=git`, Docker worker) through `POST /v1/executions`, with a **build-only token** (`executions:submit,runs:read,artifacts:read`) |
| GitHub releases | an HTTP stand-in whose URLs say `/stand-in/` |
| Governance | contract `boundry.governance@1.0.0`. The registry is a declared **test** registry, so an asserted approval is accepted and recorded as `asserted` |

## What happened

1. **The real source commit was refused.** At `aaab053`, `packages/server/package.json` declares 0.4.1 and `package-lock.json` records 0.4.0: the commit "Release @appport/resolver 0.4.1" bumped the manifest without the lockfile. See [stale lockfile refused](../proof-resolver-train-stale-lockfile-refused.md).
2. The proof repaired the lockfile the way a maintainer would. `npm install --package-lock-only` produced a one-line change, committed separately as `9938586` "Repair package-lock.json". The plan is based on that commit. `5-independent-verification.json` confirms `approvedSourceIsRepairOfReal: true`.
3. A lone `@appport/resolver-core` release was refused: its workspace siblings pin it exactly. See [lone release refused](../proof-resolver-train-lone-core-refused.md).
4. The train was proposed by `maintenance-agent`, an agent. Three attempts were refused, and the refusals are recorded:
   * approval by an unknown principal;
   * approval by the agent of its own proposal;
   * execution triggered by the agent.
5. `randy` approved by digest. The lifecycle then ran: `proposed → validated → awaiting-approval → approved → prepared → built → tagged → published → registry-verified → released`.
6. **Ambiguous publish.** The registry stored `@appport/resolver@0.4.2`, and the connection was cut before npm received the answer. npm's own retry got "already present". The Release Manager then asked the registry, found the exact built artifact (same integrity), and recorded `already-done`. Nothing was overwritten or duplicated.

## Independent verification (`5-independent-verification.json`)

Each fact below was read directly from its authority, not from the Release Manager's record.

* **Git.** One release commit sits on top of the approved source. All three tags point at it, and the manifests at the tags carry the new versions.
* **Registry.** For each package: integrity equals the built artifact's, the served bytes equal the built bytes, and the integrity of every earlier version still equals npmjs.org's.
* **Boundry CI.** It built and tested exactly the release commit.
* **Checks.** All are recorded. Build and tests, registry acceptance and consumer verification are `deferred`, each saying when it runs.
* **Downstream.** feltkit pins `@appport/resolver-client` exactly at 0.3.0. A `requirement-change` to 0.3.1 is **proposed** and not applied.
* **Consumers.** Maintenance's unmodified collector classifies feltkit as `patch-behind`. Adoption is not claimed.

## Limits

* Identity was asserted (`--as`). This is acceptable only because the registry is a declared test registry. Production requires signed approvals.
* Build before tag is deliberate: a failed build never leaves a tag behind.
