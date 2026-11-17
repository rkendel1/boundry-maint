# Shop: what it is built from and what it resolves

Read at 2026-11-17T13:19:34.976Z. Maintenance project `shop` (acme/shop); Resolver consumer name: `shop`.

## Build time: packages

Authority: registries and git (facts); Boundry Maintenance (release governance and evidence).

- **@demo/core** in `acme/shop:package.json`: declares `0.2.0`, lockfile resolves `0.2.0`
  - release `demo-core@0.2.1` → 0.2.1: **released**; proposed by maintenance-agent (agent); approved by randy (asserted); commit `2b878b3e26e4`, tag `@demo/core@0.2.1`, registry integrity `sha512-T9uQpyXJI5BXK3u…`
  - proposed for this application (needs its own plan): requirement-change `0.2.0` → `0.2.1`

## Run time: Resolver references

Authority: Resolver (bindings and history), governed by Resolver Control. Read from http://127.0.0.1:47748/appport as `boundry-maintenance` at 2026-11-17T13:19:34.976Z (a projection; never a basis for a write).

- **`ref://prod/search`** (endpoint) at revision 2: https://search-b.example.com/ — owner platform-team, criticality critical, change class runtime; known by: declared + observed (product search on the storefront)
  - CHG-1 retarget: **verified**; proposed by boundry-maintenance (agent); approvals linus, ada of 2 required; verified ✔ at revision 2

## Activity (both authorities, one timeline)

| When | Domain | Authority | Subject | Event | Actor |
|---|---|---|---|---|---|
| 2026-11-17T13:19:27.048Z | runtime | Resolver Control | ref://prod/search | dependency.registered | ada |
| 2026-11-17T13:19:27.068Z | runtime | Resolver Control | ref://prod/search | consumer.declared | grace |
| 2026-11-17T13:19:29.711Z | package | Boundry Maintenance | release demo-core@0.2.1 | proposed: patch release proposed by maintenance-agent (agent) | maintenance-agent |
| 2026-11-17T13:19:29.711Z | package | Boundry Maintenance | release demo-core@0.2.1 | validated: passed: @demo/core: publishable; passed: @demo/core: registry; passed: @demo/core: manifest and package-lock.json agree; passed: @demo/core: version  |  |
| 2026-11-17T13:19:29.711Z | package | Boundry Maintenance | release demo-core@0.2.1 | awaiting-approval: needs 1 approval(s) from prod approvers; eligible: randy |  |
| 2026-11-17T13:19:30.530Z | package | Boundry Maintenance | release demo-core@0.2.1 | approved (asserted) | randy |
| 2026-11-17T13:19:30.531Z | package | Boundry Maintenance | release demo-core@0.2.1 | approved: approved by randy (asserted) for plan 6d67eb08243c |  |
| 2026-11-17T13:19:30.976Z | package | Boundry Maintenance | release demo-core@0.2.1 | prepared: release commit 2b878b3e26e4 |  |
| 2026-11-17T13:19:31.850Z | package | Boundry Maintenance | release demo-core@0.2.1 | built: built by run_1 from 2b878b3e26e4 |  |
| 2026-11-17T13:19:31.975Z | package | Boundry Maintenance | release demo-core@0.2.1 | tagged: @demo/core@0.2.1 |  |
| 2026-11-17T13:19:32.647Z | package | Boundry Maintenance | release demo-core@0.2.1 | published: registry accepted every artifact |  |
| 2026-11-17T13:19:32.936Z | package | Boundry Maintenance | release demo-core@0.2.1 | registry-verified: registry serves the exact artifact |  |
| 2026-11-17T13:19:32.940Z | package | Boundry Maintenance | release demo-core@0.2.1 | released: @demo/core@0.2.1 released and verified |  |
| 2026-11-17T13:19:32.956Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.proposed | boundry-maintenance |
| 2026-11-17T13:19:32.988Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.validated | component:resolver |
| 2026-11-17T13:19:33.778Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.approval_recorded | linus |
| 2026-11-17T13:19:33.794Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.approved | ada |
| 2026-11-17T13:19:33.794Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.approval_recorded | ada |
| 2026-11-17T13:19:34.020Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.execution_started | component:resolver |
| 2026-11-17T13:19:34.074Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.authorization_issued | component:resolver |
| 2026-11-17T13:19:34.184Z | runtime | Resolver Control | ref://prod/search change mwkpyli4d862242ba156 | change.verified | component:resolver |

## Not known

- Runtime: consumers that neither declared themselves nor resolved through a registered Resolver client are not visible.
