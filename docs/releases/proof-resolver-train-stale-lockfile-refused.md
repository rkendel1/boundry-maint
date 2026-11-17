# Release train refused: stale lockfile in rkendel1/resolver@aaab053651a9

The planner read the real commit and refused:

```
the release cannot be planned as requested:
  ✗ @appport/resolver: manifest and package-lock.json agree: packages/server/package.json declares 0.4.1 but package-lock.json records 0.4.0: the lockfile is stale or the manifest was edited without it; fix the repository first
```

Confirmed independently: at that commit `packages/server/package.json` declares 0.4.1 and `package-lock.json` records 0.4.0 (the commit "Release @appport/resolver 0.4.1" bumped the manifest without the lockfile). The proof then repairs it with `npm install --package-lock-only` in a separate commit and plans from there.
