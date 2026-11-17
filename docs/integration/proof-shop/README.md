# Integration proof: one application, a package dependency and a Resolver dependency

`tools/integration-proof/run.ts`, run 2026-11-17 against `rkendel1/resolver-control@27e843a`. No production registry
or production Resolver was touched.

**Application `shop`:** built from `@demo/core` (a package Boundry Maintenance releases) and, while running, resolves
`ref://prod/search` (a Resolver reference Resolver Control governs). The two identities are never merged: Maintenance
links the application only by name (`config/projects.json` → `resolverApplication`).

| Part | What ran |
|---|---|
| Resolver | the real `@appport/resolver` (Resolver Control's vendored 0.4.0) **enforcing a mutation policy** on `ref://prod/*`: a write needs an authorization from Resolver Control's approval signer |
| Resolver Control | `feltkit dev` from the resolver-control checkout; its component holds the only Resolver write key; the approval signer runs as its own process with its own key |
| shop | Resolver Control's `examples/consumer-app.mjs`, registered with Resolver as consumer `shop` |
| Maintenance | this repository's AppPort application (HTTP `/appport`, MCP `/mcp`) with the Release Manager, real git and Verdaccio as a declared **test** registry. The build used the local packing executor from the tests (Boundry CI execution is proven separately in `docs/releases/`) |

## Two changes, two authorities

| | Package: `@demo/core` 0.2.0 → 0.2.1 | Runtime: `ref://prod/search` A → B |
|---|---|---|
| Authority | registry + git (facts), **Boundry Maintenance** (governance) | **Resolver** (bindings, history, enforcement), **Resolver Control** (governance) |
| Proposed by | `maintenance-agent` (agent) via Maintenance's `releases.propose` | `boundry-maintenance` (agent) via Resolver Control's own `changes.propose` |
| Approvals required | 1 person (`prod_approver`) | 2 people (critical) |
| Approved by | `randy` (recorded `asserted`: test registry) | `linus`, `ada` |
| Executed by | Maintenance's release executor (`component:release-executor`) | Resolver Control's component, with a signer authorization |
| Evidence | release commit = tag target; registry integrity = built integrity | Resolver revision 2: `governance.mode = authorized`, issuer `resolver-control`, approvers `linus, ada`; change verified; shop followed revision 2 without restarting |
| Consumer effect | a `requirement-change` **proposal** for shop (it pins 0.2.0); nothing applied | shop resolves the new binding (that is what a runtime reference is for) |

## Neither side can exercise the other's authority (`4-authority-checks.json`)

| Who | Tried | Answer |
|---|---|---|
| `maintenance-agent` (Maintenance AppPort) | approve / trigger its own release | `FORBIDDEN Missing permission: maintenance.approve` / `.trigger` |
| `boundry-maintenance` (its Resolver Control session) | approve the runtime change; claim it; repoint Resolver Control; lower the dependency's criticality | `FORBIDDEN Missing permission: changes.approve` / `changes.execute` / `settings.write` / `catalog.write` |
| `boundry-maintenance` (holds no Resolver key) | `resolver.put` directly on Resolver | `UNAUTHORIZED Authentication is required` |
| Resolver's own admin key | write `ref://prod/search` | `FORBIDDEN (resolver.authorization-required)`: only a signer authorization for an approved change opens prod |
| Resolver Control | hold a registry credential | its component declares only `resolver-api-key`, `approval-signer-token` |
| Resolver Control (no Maintenance token) | approve a release on Maintenance | `UNAUTHORIZED Authentication is required` |
| anyone without the registry token | `npm publish` a valid new version; raw `PUT` to the registry | `ENEEDAUTH`; registry `401` |
| `maintenance-agent` over Maintenance **MCP** | `releases_approve` | `FORBIDDEN: Missing permission: maintenance.approve` |
| `boundry-maintenance` over Resolver Control **MCP** | `changes_approve` | `FORBIDDEN: Missing permission: changes.approve` |

## One view (`1-application-view.md`)

Read through Maintenance's `applications.inspect` capability (as the agent). Build-time section from Maintenance's
records; run-time section read from Resolver Control at request time as `boundry-maintenance`, labelled with its read
time and "a projection; never a basis for a write"; one activity timeline with each entry's authority.

**No duplicate source of truth:** Maintenance's release record contains no `ref://` binding or revision
(`5-independent-verification.json` → `noDuplicateTruth.maintenanceRecordsMentionRef: false`); nothing about the
runtime side is stored by Maintenance.

## Limits

- Identities came from FeltKit dev sessions (Resolver Control) and bearer tokens (Maintenance): real per-person
  authentication is a deployment prerequisite. Maintenance's approval was `asserted` (test registry only).
- The proof's evidence about a failed npm attempt was first wrong: a tag name made npm refuse before authentication was
  tested. Capturing the child's own error text exposed it; the check now uses a valid tag and also asks the registry
  directly (401).
