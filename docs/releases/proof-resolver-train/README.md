# End-to-end proof: resolver release train (stand-in registry)

`tools/release-proof/run-proof.ts`, run on 2026-11-17. Nothing was published to npmjs.org and nothing was pushed to GitHub.

| Part | What ran |
|---|---|
| Source | a bare git repository seeded with the real `rkendel1/resolver` at `aaab053` |
| Registry | Verdaccio 6.2.4 on 127.0.0.1:4874, seeded with the **real** npmjs tarballs of every published version of the three packages |
| Build | Boundry CI (FeltDB, control plane with `BCI_SCM=git`, a Docker worker) through `POST /v1/executions` |
| GitHub releases | an HTTP stand-in; its URLs say `/stand-in/` so they cannot be mistaken for real releases |

## Results (from `5-independent-verification.json`, read by the script, not by the Release Manager)

* A lone `@appport/resolver-core` release was **refused** before approval: client and server pin it exactly ([lone refusal](../proof-resolver-train-lone-core-refused.md)).
* The train `@appport/resolver` 0.4.1→0.4.2, `-client` 0.3.0→0.3.1, `-core` 0.2.0→0.2.1 was **proposed by `maintenance-agent` (an agent)** and approved by digest by `randy` (a person, `prod_approver`; identity asserted at the CLI). Refused, and recorded in `5-independent-verification.json` → `governance`: an unknown principal's approval, the agent's approval of its own proposal, and execution triggered by the agent.
* One release commit `bd665ed` on top of the approved source; client and server pins rewritten to 0.2.1; three tags, all on that commit.
* Boundry CI built and tested exactly that commit. Run state: succeeded.
* For each package, the registry serves the new version, its integrity equals the built artifact's, the downloaded bytes hash to the built artifact, and every earlier version's integrity still equals npmjs.org's.
* One release per tag at the GitHub stand-in, each citing the commit and every artifact digest.
* Consumers: Maintenance's unmodified collector sees client 0.3.1, and classifies feltkit (pins 0.3.0) as `patch-behind`. Adoption is **not** claimed: feltkit was not changed.

## Known weaknesses

* The first run of this proof (same day, before the governance foundation) had `randy` both propose and approve. The Release Manager now refuses that (`test/governance.test.ts`); this evidence is from the re-run.
* Identity is asserted (`--as`), not authenticated: gap G1 in `docs/architecture/control-plane.md`.
* The build ran before tagging, not after. This is deliberate: a failed build never leaves a tag behind.
