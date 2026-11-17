<!-- Generated read-only by tools/release-proof/live-plan.ts at 2026-11-17T00:18:54.608Z against registry.npmjs.org and github.com. -->

# Release request refused: appport-resolver-core (patch)

this release would break the workspace install: npm resolves these siblings through the workspace, and their pins do not accept the new version(s). Release them together (Boundry never adds packages to a release on its own):
- @appport/resolver (packages/server/package.json declares @appport/resolver-core "0.2.0") → add --package appport-resolver
- @appport/resolver-client (packages/client/package.json declares @appport/resolver-core "0.2.0") → add --package appport-resolver-client
