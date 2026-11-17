# Conformance with the Boundry governance contract

Not normative. Each implementation runs `vectors.json` against its own enforcement; this file records the results.
The normative files are `contract.json`, `vectors.json` and `SPEC.md`; their sha256 digests are what implementations pin.

## Status

| Application | Conforms to | Evidence |
|---|---|---|
| Boundry Maintenance | 1.2.0 | `test/governance-contract.test.ts` runs `vectors.json` against `src/governance/rules.ts` `decide()`, which the Release Manager uses for every decision |
| Resolver Control | 1.2.0 (43 conform, 13 not applicable, 0 divergences at resolver-control `19851c3`) | `tests/governance-contract.test.ts` in resolver-control runs the vendored vectors against its own mutations and writes `docs/governance-conformance.json` |

