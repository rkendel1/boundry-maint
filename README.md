# Boundry Maintenance

A central, generated view of the ecosystem's packages, releases, installations and maintenance status — for npm and crates.io.

It answers:

1. What packages and crates do we publish? → `config/packages.json` + **Releases**
2. What external packages do we deliberately track? → `ownership: managed | upstream`
3. Which projects consume our packages? → **Package detail → Consuming projects**
4. Are installed versions current with published releases? → **Projects**, `data/installations.json`
5. What needs maintenance, and what has been updated **and verified**? → **Queue**, `data/maintenance.json`

**Sources of truth:** the registries own published versions, GitHub owns repository and release data, and project manifests and lockfiles own what's installed. `config/` holds the curated inventory. `data/` is the generated, durable record of each scan; it is committed so history and evidence survive. The dashboard and badges are derived from `data/` and are not a source of truth.

There is no database, no hosted backend, and no third-party badge service. V1 only observes: it never publishes packages, changes dependencies, or opens pull requests.

## How it works

```
config/ ──► collectors (npm, crates.io, GitHub) ──► scanners (package.json + lockfiles, Cargo.toml + Cargo.lock)
                                │                                  │
                                └──────────► version engine ◄──────┘
                                                  │
                              status engine (installation status, maintenance lifecycle, verification)
                                                  │
                           data/*.json + data/history/<timestamp>.json  (committed)
                                                  │
                              report ──► _site/ (dashboard, data, badges) ──► GitHub Pages
```

| Command | What it does |
|---|---|
| `npm run scan` | Collect, scan, classify; write `data/` atomically. Exits 1 and writes nothing if the scan failed. |
| `npm run report` | Build `_site/` (dashboard + `data/` + SVG badges + `dashboard.json`). |
| `npm run validate` | Validate `config/` and every artifact in `data/` against the contracts. |
| `npm run schemas` | Regenerate `schemas/*.json` from `src/contracts.ts`. |
| `npm run check` | Typecheck, tests, validate. |

The code is TypeScript, run directly by Node ≥ 22.18 (type stripping), so there's no build step. `tsc` is used only for type checking. The dashboard (`public/assets/app.js`) is plain JavaScript with `// @ts-check` and is type-checked against the same contracts, because browsers can't run TypeScript and a bundler would add a build step that buys nothing here.

## Repository layout

```
config/       packages.json, projects.json, policies.json   (curated; edit these)
schemas/      JSON Schemas generated from src/contracts.ts  (editor validation for config/)
src/
  contracts.ts          Zod schemas: the single definition of every config and data contract
  collectors/           npm.ts, crates.ts, github.ts
  scanners/             javascript.ts, rust.ts, sources.ts (GitHub tree / local checkout)
  version/              compare.ts (semver classification), resolve.ts (npm specs, Cargo requirements)
  status/               package.ts, project.ts (installations + verification evidence), maintenance.ts (lifecycle)
  badges/generate.ts    SVG badges
  reports/generate.ts   Pages site + overview
  scan.ts, index.ts     pipeline + CLI
data/         generated and committed: packages, releases, projects, installations, maintenance,
              snapshot, events, evidence/<project>.json, history/<timestamp>.json
public/       dashboard (index.html, assets/)
test/         node:test suites, including end-to-end lifecycle and failure-preservation tests
```

## Configuration

`config/packages.json` holds one entry per published package. Several packages can share a repository; `directory` locates each one within it.

```json
{ "id": "appport-sdk", "name": "@appport/sdk", "registry": "npm", "ownership": "owned",
  "repository": "rkendel1/appport", "directory": "packages/sdk" }
```

`ownership`: `owned` (we publish it), `managed` (external dependency we deliberately track), or `upstream` (external, watched for important changes).

`config/projects.json` holds one entry per consuming project. Several projects can share a repository: use `paths` to give each one its own slice.

```json
{ "id": "feltkit", "name": "FeltKit", "repository": "rkendel1/feltkit", "defaultBranch": "main",
  "scan": { "javascript": true, "rust": true },
  "managedPackages": ["feltdb-core", "appport-sdk", "appport-services"],
  "ignorePaths": ["experiments"],
  "verification": { "workflows": ["ci.yml"] } }
```

Only `managedPackages` appear in the maintenance report. Every other dependency is still recorded under `discovered` in `data/installations.json`. A catalog package that a project uses but doesn't list shows up as a *curation hint* on that project's page. The scanner never adds anything to the inventory on its own.

`config/policies.json` sets the global prerelease default, which differences make an update *required* for each ownership type (by default: every difference for owned packages, major/minor for managed, nothing for upstream), the "new release" window, and history retention.

## Statuses

**Installation status** (`data/installations.json`): `current`, `patch-behind`, `minor-behind`, `major-behind`, `prerelease`, `deprecated`, `yanked`, `unavailable` (the registry couldn't be read, so the version can't be verified), `unknown` (no lockfile covers the manifest, or the dependency comes from git or another non-registry source), and `local` — an extension to the spec for workspace or path links inside the same repository, which aren't registry installs.

The rules:

- Versions are compared with `semver`, never as strings.
- A yanked crate version is never chosen as a target.
- Prereleases are targets only when the package or the policy tracks them.
- A failed registry request gives `unavailable`, never `current`.
- The declared requirement (`^1.4.0`, Cargo's `1`) is kept next to the resolved lockfile version.
- `latestSatisfiesDeclared` tells you whether a lockfile refresh is enough or the manifest has to change.
- `lockfileInSync: false` flags a lockfile that no longer satisfies its manifest.
- For 0.x packages, a minor bump is reported literally as `minor-behind`. Check `latestSatisfiesDeclared` to see whether it's compatible.

**Maintenance lifecycle** (`data/maintenance.json`), one item per *project × lockfile × package*. Installations that share a lockfile are a single maintenance action; for example, one `cargo update -p tokio` fixes a whole workspace.

```
update-available → update-required → update-in-progress → updated-unverified → updated-verified
```

- **available / required** comes from `policies.requireUpdate`. Deprecated or yanked installs are always required.
- **in-progress** is set only by an explicit signal: a `maintenance-started` repository dispatch. Nothing is inferred.
- **updated-unverified**: the lockfile now resolves the target, but no passing evidence exists for that exact resolved version. A matching version on its own never counts as verification.
- **updated-verified**: there is evidence for a commit in which every managed dependency resolved from the lockfile, and every workflow in `verification.workflows` concluded `success` on that same commit SHA. Evidence is stored append-only in `data/evidence/<project>.json` and records the commit, the workflow run URLs, the scan run, and the resolved versions. A project without `verification` configured can never reach *verified*, and the dashboard says so.
- A newer release reopens a verified item. Each item keeps its own status history.

Queue order: deprecated/yanked → major → minor → patch → prerelease; within each group, required before available.

## Failure handling

- **Whole scan failed** (every registry request and every project failed, or the config is invalid): the scan exits 1 and writes nothing. The workflow stops before committing, so the last successful snapshot stays in place.
- **Registry failure for one package**: its last-known data is kept with `collection: "stale"` and the error. The installations it affects become `unavailable`.
- **Project unreadable**: the project is marked `inaccessible` or `failed`, its last installations are carried forward with `stale: true`, and `lastSuccessfulScan` is preserved. Open maintenance items are kept as they were, not closed.
- Every error is recorded in `data/snapshot.json → scan.errors`, in the workflow step summary, and on the dashboard banner. A scan with any error is `partial`.
- Files are written atomically: either the whole set lands or none of it does.

## Setup

1. **Pages:** Settings → Pages → Source: **GitHub Actions**. The dashboard is then served at `https://rkendel1.github.io/boundry-maint/`.
2. **Private repositories:** the built-in `GITHUB_TOKEN` can read public repositories but not your other private ones. In the current catalog, `rkendel1/feltkit`, `rkendel1/appport` and `rkendel1/flow_db` are private. To scan them, create a fine-grained token with **read-only** access to those repositories (Contents, Metadata, Actions) and save it as the repository secret `MAINTENANCE_READ_TOKEN`. Without it, those projects show as `inaccessible`, and their GitHub release fields stay empty. They are never reported as current.
3. **Run:** Actions → *Scan* → Run workflow. After that it runs daily (`scheduled.yml`), whenever `config/` or `src/` changes, and on repository dispatch.

No credentials for publishing packages are stored or used anywhere.

### Event-driven scans from managed repositories

The daily scan already discovers changes on its own. If you want faster updates, a managed repository can notify this one. This needs a token whose only permission is to dispatch to `rkendel1/boundry-maint` (fine-grained, Contents: read & write on this single repository):

```yaml
# in a managed repo's workflow, after a push to main or a release
- run: |
    curl -fsS -X POST https://api.github.com/repos/rkendel1/boundry-maint/dispatches \
      -H "Authorization: Bearer ${{ secrets.MAINTENANCE_DISPATCH_TOKEN }}" \
      -d '{"event_type":"project-pushed"}'
```

Event types: `scan`, `package-released`, `project-pushed`. To signal that work has started (this moves an item to *update-in-progress*):

```json
{"event_type":"maintenance-started","client_payload":{"project":"feltkit","package":"appport-sdk","targetVersion":"1.4.1","ref":"https://github.com/rkendel1/feltkit/pull/42"}}
```

## Badges

Badges are generated into `/badges/` on every report run.

- **Project:** `<id>-status.svg`, `<id>-dependencies.svg`, `<id>-behind.svg`, `<id>-scan.svg`
- **Package:** `<id>-version.svg` (npm or crates.io), `<id>-release.svg` (GitHub release), `<id>-consumers.svg`

```markdown
## Maintenance
![Maintenance](https://rkendel1.github.io/boundry-maint/badges/feltkit-status.svg)
![Dependencies](https://rkendel1.github.io/boundry-maint/badges/feltkit-dependencies.svg)
![Last Scan](https://rkendel1.github.io/boundry-maint/badges/feltkit-scan.svg)
```

Every project and package page on the dashboard shows the snippet ready to copy.

## Local development

```bash
npm ci
npm run check
```

Scan with a token. `--local owner/repo=path` maps a repository to a local checkout instead of fetching it through the GitHub API:

```bash
GITHUB_TOKEN=… node src/index.ts scan --data /tmp/data --local rkendel1/feltkit=../feltkit
```

```bash
node src/index.ts report --data /tmp/data --out /tmp/site
```

```bash
python3 -m http.server -d /tmp/site
```

Behind an HTTPS proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## Known limitations (V1)

- Lockfiles supported: `package-lock.json` (v1–v3), `npm-shrinkwrap.json`, `pnpm-lock.yaml` (v5–v9), `yarn.lock` (classic and Berry), and `Cargo.lock`. `bun.lock` is not supported; those manifests resolve as `unknown`.
- Git and alternative-registry dependencies are reported with their source revision and status `unknown`. They aren't compared against crates.io or npm.
- If the GitHub tree API truncates a very large repository, the project gets a warning, and manifests beyond the cut-off are missed.
- `data/history/` keeps the newest `maxSnapshots` (90) snapshots on disk. Older ones are deleted from the working tree but remain in git history.
- Security advisories, licenses, SBOMs, automated upgrades and pull requests are out of scope for V1.
- `@appport/chip` is published under the `@appport` scope, but its registry metadata points to `vercel/eve`, so it isn't in the owned catalog. Add it if it's yours.
