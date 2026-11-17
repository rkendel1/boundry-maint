# Principal readiness: who must exist before which release can happen

Governance contract `boundry.governance@1.0.0`. The Release Manager **refuses a plan that its approval policy can never satisfy**, at proposal time. It never weakens separation of duties to make a release possible. This page states the minimum set of principals per kind of release. It also states what `config/principals.json` holds today.

## Today (`config/principals.json`)

| Principal | Type | Roles | Signing key |
|---|---|---|---|
| `randy` | person | admin, engineer, prod_approver | **none registered** |
| `maintenance-agent` | agent | agent | — |
| `component:release-executor` | component | executor | — |

What this allows today:

| Release | Possible today? | Why |
|---|---|---|
| Ordinary, to a declared **test** registry | **Yes**, when someone other than `randy` proposes it (`maintenance-agent`, or another engineer). `randy` approves; the approval is recorded `asserted` | — |
| Ordinary, to a **production** registry (npmjs.org, crates.io) | **No** | Production approvals must be signed, and `randy` has no registered key. Also, no production publish token is configured, and production publication has not been authorized by you |
| Critical, any registry | **No** | It needs two distinct people other than the proposer. One person exists |
| Proposed by `randy` | **No** | The proposer cannot approve, and nobody else can |

## Minimum per kind of release

| Kind | Proposer | Approvers (distinct, none of them the proposer) | Authentication | Trigger |
|---|---|---|---|---|
| Ordinary, test registry | an engineer, or the agent | 1 person with `approver`, or `prod_approver` if the package policy is protected (the default) | asserted is accepted, and recorded as such | a person with `admin` |
| Ordinary, production | an engineer, or the agent | 1 `prod_approver` | **signature** (SSH key registered in `config/principals.json`) | `admin` |
| Critical (`criticality: "critical"`) | an engineer, or the agent | **2** `prod_approver` people (or the policy's count, if higher) | signature for production | `admin` |
| Protected production, policy `approvalsRequired: n` | an engineer, or the agent | **n** `prod_approver` people | signature | `admin` |
| Recovery: resuming a release stopped at a recoverable step | — | **no new approval**: the same plan digest, re-checked at start under the current policy | the stored signatures are re-verified | `admin` |
| Plan changed (registry, branch or consumers moved) | a new proposal | a new approval | as above | as above |
| Emergency (publish outside the process) | **not supported.** There is no break-glass in Maintenance. A registry owner can still publish by hand; the next scan observes it and the Release Manager treats it as someone else's version (it is never overwritten) | — | — | — |

The **smallest configuration that makes every kind above possible** is:

* 3 people: one engineer who proposes, and two `prod_approver`s, each with a registered SSH public key (`keys`);
* `maintenance-agent`;
* `component:release-executor`.

For example:

```json
{ "id": "randy",  "name": "Randy",   "type": "person", "roles": ["admin", "prod_approver"], "keys": ["ssh-ed25519 AAAA… randy"] },
{ "id": "<second person>", "name": "…", "type": "person", "roles": ["prod_approver"], "keys": ["ssh-ed25519 AAAA…"] },
{ "id": "<engineer>",      "name": "…", "type": "person", "roles": ["engineer"] }
```

**Human prerequisites (yours to decide):**

* who the second approver is;
* registering each approver's SSH public key;
* the production publish credentials;
* protecting changes to `config/principals.json`, for example with branch protection plus CODEOWNERS requiring review. The key registry is only as trustworthy as who can change it.
