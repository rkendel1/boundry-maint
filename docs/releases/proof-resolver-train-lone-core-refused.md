# Lone release of @appport/resolver-core refused

this release would break the workspace install: npm resolves these siblings through the workspace, and their pins do not accept the new version(s). Release them together (Boundry never adds packages to a release on its own):
  - @appport/resolver (packages/server/package.json declares @appport/resolver-core "0.2.0") → add --package appport-resolver
  - @appport/resolver-client (packages/client/package.json declares @appport/resolver-core "0.2.0") → add --package appport-resolver-client
