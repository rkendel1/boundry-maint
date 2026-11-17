# Boundry governance contract, version 1.1.0

This contract is normative for every Boundry application that governs change: Boundry Maintenance (releases) and Resolver Control (runtime references). The same semantics apply to both. Each application **enforces** them in its own trust boundary, with its own credentials. The contract is not a service, not a library dependency and not a shared credential.

| File | What it is |
|---|---|
| `contract.json` | Machine-readable definitions: principal types, effects, roles, defaults, authentication levels, refusal codes. Maintenance derives its role table from this file at run time |
| `vectors.json` | Conformance cases: inputs and the decision every conforming implementation must reach. An application conforms when its enforcement reaches every expected decision |
| `SPEC.md` | This text. On a disagreement, the text and the vectors are fixed together in a new version |

**Versioning.**

* Semantic.
* A change that makes any existing vector's decision different is a **major** version.
* Adding vectors or effects that existing applications do not use is **minor**.
* An application states the version it conforms to, and its test suite runs that version's vectors.

## Changes

| Version | Change | Found by |
|---|---|---|
| 1.1.0 | The `agent` role gains `withdraw`: an agent may withdraw its own proposal, never anyone else's. Before, the role table and §3.6 disagreed. **When several rules refuse, any of their codes conforms** (§2 orders authorization before the handler's rules, so an agent asking to approve may be refused as `forbidden-effect` or `person-only`); vectors list the acceptable codes in `expect.codes` | running the vectors against Resolver Control (a second implementation) |
| 1.0.0 | First version | — |

## 1. Principals

| Type | May | Never |
|---|---|---|
| `person` | read, propose, approve, reject, withdraw, administer, trigger (by role) | execute |
| `agent` | read, propose, withdraw its own proposal | approve, administer, trigger, execute, sign |
| `component` | execute (`executor`) or sign (`signer`), and read | propose, approve, administer |

Two rules about the principal catalog:

* A role may only be held by the principal types listed for it in `contract.json`. An application must refuse a catalog that violates this.
* An unknown principal is refused (`unknown-principal`) for every operation.
* When more than one rule refuses an operation, reporting any one of them conforms. A vector lists every acceptable code in `expect.codes`.

Each application maps its platform's principal kinds onto these types. In FeltKit, `user` → person, `agent` → agent, and `service` (component principal) → component.

## 2. Operation authorization

* Every operation an application exposes declares one **effect** (`contract.json` → `effects`).
* A principal may perform it only if one of its roles grants that effect. Otherwise the refusal is `forbidden-effect`.
* Authorization is decided **before** the operation's handler runs.
* The handler then applies the rules below.

## 3. Separation of duties

1. Only a person approves or rejects (`person-only`).
2. The proposer of a subject may not approve it (`proposer-cannot-approve`).
3. A person approves a given subject at most once (`already-approved`).
4. Approvals are counted by **distinct** people. An approval by the proposer, by a non-person, or for another digest never counts, whatever is recorded.
5. Only a component executes. The person who triggers execution grants no authority over what runs: the component re-checks §7.
6. Withdrawing is for the proposer. Rejecting is for a person with `approve`. Anyone else gets `forbidden-effect`.

## 4. Criticality and approval thresholds

```
required = max(policy.approvalsRequired, criticality == "critical" ? 2 : 1)
```

`approvalsRequired` is between 1 and 5. A subject reaches `approved` when its counted approvals reach `required`.

**Ratchet.** A subject's threshold is the larger of the threshold recorded when it was proposed and the threshold under the current policy and criticality:

* Tightening a policy or raising criticality applies to open subjects.
* **Lowering never reduces what an open subject needs.** Otherwise anyone who can edit criticality or policy, including the proposer, could remove the second approver from their own change.

The same ratchet applies to `protected`. `requiredAtProposal` in the vectors is the recorded threshold.

## 5. Protected scopes

* In a protected scope, approving additionally needs `approve.protected` (`protected-scope`).
* A scope with no recorded policy is protected and needs one approval. Unknown is never treated as safe.
* For releases, a publication destination is a protected scope unless policy says otherwise.

## 6. Freeze

* While a scope is frozen, nothing is approved there (`frozen`).
* An approved subject does not start executing; it **waits** (`frozen`, result `wait`) and resumes when unfrozen.
* Freezing does not interrupt an execution already past its first external mutation. Stopping half-way would leave a state nobody approved.

## 7. Approval validity and revocation

**Validity.**

* An approval binds the subject's **digest**: every fact the approver was shown, such as plan, source revision and destination.
* An approval for another digest is `digest-mismatch` when given, and is not counted at execution.
* If any bound fact changes, the subject must be re-proposed with a new digest. Approvals never carry over.
* Only a subject in `awaiting-approval` can be approved (`wrong-state`).

**Revocation.**

* Withdrawal or rejection is possible until the first irreversible external mutation (`irreversible` after it).
* A revoked subject never executes (`revoked`).

## 8. Execution authorization

Decided by the executing component, at the start of execution, from the record. It does not trust the caller.

1. The principal is a component with `execute`.
2. Not revoked.
3. The scope is not frozen (otherwise wait).
4. Counted approvals (§3.4) reach `required` (§4, including the ratchet). Otherwise the subject returns to `awaiting-approval` (`insufficient-approvals`): a tightened policy applies to work not yet started.
5. **Production:** if the destination is production, every counted approval must have authentication `session` or `signature`. `asserted` (a name typed by the caller) never authorizes a production mutation (`unauthenticated-for-production`).
6. The external mutation itself is conditional on the facts the digest bound: expected revision, expected branch head, version absent. Evidence is append-only.

## 9. Authentication levels

| Level | Meaning | Production |
|---|---|---|
| `asserted` | The caller typed a principal id. Nothing verified it | never |
| `session` | The application's platform authenticated the principal (FeltKit/AppPort session) | yes |
| `signature` | The approval is a signature over the approval statement, by a key registered to that principal, verified by the executing component | yes |

## Conformance status (recorded by each application)

| Application | Conforms to | Evidence |
|---|---|---|
| Boundry Maintenance | 1.1.0 | `test/governance-contract.test.ts` runs `vectors.json` against `src/governance/rules.ts` `decide()`, which the Release Manager uses for every decision |
| Resolver Control | 1.1.0, except where its own conformance report says otherwise | `tests/governance-contract.test.ts` in resolver-control runs the vendored vectors against its own mutations and writes `docs/governance-conformance.json` |
