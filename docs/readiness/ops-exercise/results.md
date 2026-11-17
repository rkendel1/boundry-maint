| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| S1 | Agent proposes a release | allowed | planned exercise-core@0.2.1, proposedBy maintenance-agent (agent) | pass |
| S2 | Agent attempts approval | refused | [person-only] | pass |
| S3 | Proposer withdraws before claim | allowed | cancelled; approvals kept: randy; claim null | pass |
| S5 | Executor crashes during release (SIGKILL after claim and release commit) | state remains recoverable | persisted state prepared, claim by component:release-executor, release commit 9c6d01acc3bf on main: true | pass |
| S4 | Proposer withdraws after claim | refused | [claimed] | pass |
| S6 | Publish response is lost (connection cut after the registry stored it) | reconciliation determines the actual outcome | released; already-done: publish reported "registry refused: version already present", but the registry has the exact artifact; registry integrity = built: true; same release commit as before the crash: true | pass |
| S8 | Replacement release attempted too early (predecessor stuck, not abandoned) | refused | release exercise-core@0.2.2 is tagged; | pass |
| S7 | Human abandons a stuck release | audited; no fictional rollback | agent refused: true; abandoned by randy (person) at state tagged; remains real: release commit f2c04fc4ee96 is on main and stays there; tag @demo/core@0.2.2 → f2c04fc4ee96 exists and is never moved or deleted; tag still at release commit: true | pass |
| S8b | Replacement after reconciled abandonment | allowed; the abandoned version is never reused | planned exercise-core@0.2.3 → 0.2.3; abandoned version was 0.2.2 | pass |
| S9a | Consumer observation with invalid installation data | refused explicitly; nothing recorded | does not match its schema: consumers cannot be observed (run a scan). | pass |
| S9 | Consumer has not adopted the version | not adopted | shop: resolved 0.2.0, adoption not-adopted, verification unverified | pass |
| S10 | Consumer CI hasn't verified the exact version | not verified | billing: resolved 0.2.1 (adopted: adopted); its only CI evidence resolved 0.2.0 → verification unverified | pass |
| S11 | Resolver mutation lacks its required approvals (critical: 2; 1 given) | refused | agent approval: FORBIDDEN; executor claim: FAILED_PRECONDITION: CHG-1 is ready; nothing to execute.; change status ready; direct admin-key write: error: FORBIDDEN (resolver.authorization-required): ref://prod/search is governed by mutation policy prod (ref://prod/*); Resolver revision 1 | pass |
