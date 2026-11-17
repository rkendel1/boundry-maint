# Lone release of @appport/resolver-core refused

the release cannot be planned as requested:
  ✗ workspace install after the release commit: 2 sibling requirement(s) would not accept the new version
Release these together (Boundry never adds packages to a release on its own):
  - @appport/resolver-client (packages/client) declares @appport/resolver-core "0.2.0", which does not accept 0.2.1 → add --package appport-resolver-client
  - @appport/resolver (packages/server) declares @appport/resolver-core "0.2.0", which does not accept 0.2.1 → add --package appport-resolver
