// @ts-check
/**
 * Boundry Maintenance dashboard. Static, framework-free; reads the generated
 * JSON contracts in data/ (see src/contracts.ts). Type-checked by `npm run typecheck`.
 */

/** @typedef {import("../../src/contracts.ts").PackageRecord} PackageRecord */
/** @typedef {import("../../src/contracts.ts").ProjectRecord} ProjectRecord */
/** @typedef {import("../../src/contracts.ts").Installation} Installation */
/** @typedef {import("../../src/contracts.ts").MaintenanceItem} MaintenanceItem */
/** @typedef {import("../../src/contracts.ts").EvidenceRecord} EvidenceRecord */
/** @typedef {import("../../src/contracts.ts").VersionInfo} VersionInfo */
/** @typedef {import("../../src/contracts.ts").Snapshot} Snapshot */
/**
 * @typedef {{ managedPackages: number, packagesByOwnership: Record<string, number>, trackedProjects: number,
 *   packagesWithNewReleases: string[], projectsWithOutdatedInstallations: string[], outstandingMaintenance: number,
 *   awaitingVerification: number, lastScan: { status: string, at: string, runUrl: string | null, errors: number },
 *   lastSuccessfulScan: string | null, projectStatus: Record<string, string> }} Overview
 */

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @type {{ overview: Overview, packages: PackageRecord[], projects: ProjectRecord[], installations: Installation[], items: MaintenanceItem[], snapshot: Snapshot } | null} */
let state = null;
/** @type {Map<string, any>} */
const lazy = new Map();

/** @param {string} path */
async function getJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** @param {string} path */
async function getLazy(path) {
  if (!lazy.has(path)) lazy.set(path, getJson(path).catch(() => null));
  return lazy.get(path);
}

/** @param {unknown} v */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** @param {string | null | undefined} iso */
function date(iso) {
  if (!iso) return '<span class="muted">—</span>';
  const d = new Date(iso);
  return `<time datetime="${esc(iso)}" title="${esc(d.toISOString())}">${esc(d.toISOString().slice(0, 10))}</time>`;
}

/** @param {string | null | undefined} iso */
function ago(iso) {
  if (!iso) return "never";
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  return `${Math.round(days)}d ago`;
}

/** @param {string | null | undefined} v */
const ver = (v) => (v ? `<span class="mono">${esc(v)}</span>` : '<span class="muted">—</span>');
/** @param {string} sha */
const short = (sha) => esc(sha.slice(0, 7));

/** @type {Record<string, string>} */
const TONE = {
  current: "ok",
  "patch-behind": "warn",
  "minor-behind": "alert",
  "major-behind": "bad",
  prerelease: "info",
  deprecated: "bad",
  yanked: "bad",
  unavailable: "neutral",
  unknown: "neutral",
  local: "neutral",
  "update-available": "warn",
  "update-required": "bad",
  "update-in-progress": "alert",
  "updated-unverified": "info",
  "updated-verified": "ok",
  success: "ok",
  partial: "warn",
  failed: "bad",
  ok: "ok",
  inaccessible: "neutral",
  inactive: "neutral",
};
/** @param {string} s @param {string} [label] */
const pill = (s, label) => `<span class="pill ${TONE[s] ?? "neutral"}">${esc(label ?? s)}</span>`;

/** @param {string} repo */
/** @param {string} root */
const rootLabel = (root) => (root === "." ? "(repo root)" : root);
/** @param {string} repo */
const repoLink = (repo) => `<a href="https://github.com/${esc(repo)}">${esc(repo)}</a>`;
/** @param {string} id */
const pkgLink = (id) => {
  const p = state?.packages.find((x) => x.id === id);
  return `<a href="#/package/${encodeURIComponent(id)}">${esc(p ? p.name : id)}</a>`;
};
/** @param {string} id */
const projLink = (id) => {
  const p = state?.projects.find((x) => x.id === id);
  return `<a href="#/project/${encodeURIComponent(id)}">${esc(p ? p.name : id)}</a>`;
};
/** @param {"npm" | "crates"} r */
const registryName = (r) => (r === "npm" ? "npm" : "crates.io");

/**
 * Accessible table that stacks into cards on narrow screens.
 * @param {string[]} headers @param {string[][]} rows @param {string} [empty]
 */
function table(headers, rows, empty = "Nothing to show.") {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table class="stack"><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(headers[i])}">${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const BEHIND = new Set(["patch-behind", "minor-behind", "major-behind", "prerelease", "deprecated", "yanked"]);
const OPEN = new Set(["update-available", "update-required", "update-in-progress"]);

function scanBanner() {
  if (!state) return "";
  const s = state.snapshot.scan;
  if (s.status === "success") return "";
  const failed = s.errors.slice(0, 6).map((e) => `<li><strong>${esc(e.source)}</strong> <code>${esc(e.target)}</code>: ${esc(e.message.slice(0, 180))}</li>`).join("");
  return `<div class="banner ${s.status === "failed" ? "bad" : ""}"><strong>Last scan was ${esc(s.status)}.</strong> Data from sources that failed is carried forward from the last successful scan and marked stale; affected comparisons show as unavailable rather than current.
  <details><summary>${s.errors.length} error${s.errors.length === 1 ? "" : "s"}</summary><ul class="plain small">${failed}</ul>${s.errors.length > 6 ? `<p class="small muted">…and ${s.errors.length - 6} more in <a href="data/snapshot.json">snapshot.json</a>.</p>` : ""}</details></div>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Operational home: overview + maintenance queue. */
function viewQueue() {
  if (!state) return "";
  const o = state.overview;
  const cards = [
    ["#/releases", o.managedPackages, "Managed packages"],
    ["#/projects", o.trackedProjects, "Tracked projects"],
    ["#/releases?new=1", o.packagesWithNewReleases.length, "New releases (7d)"],
    ["#/projects", o.projectsWithOutdatedInstallations.length, "Projects with outdated installs"],
    ["#/", o.outstandingMaintenance, "Outstanding maintenance"],
    ["#/history", ago(o.lastSuccessfulScan), `Last successful scan${o.lastScan.status !== "success" ? ` (${o.lastScan.status})` : ""}`],
  ]
    .map(([href, n, l]) => `<a class="card" href="${href}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></a>`)
    .join("");

  const items = state.items;
  const open = items.filter((i) => OPEN.has(i.status));
  /** @type {[string, (i: MaintenanceItem) => boolean][]} */
  const sections = [
    ["Deprecated or yanked installations", (i) => i.priority === 0],
    ["Major updates", (i) => i.priority === 1],
    ["Minor updates", (i) => i.priority === 2],
    ["Patch updates", (i) => i.priority === 3],
    ["Prereleases", (i) => i.priority === 4],
  ];
  /** @param {MaintenanceItem} i */
  const row = (i) => [
    projLink(i.project),
    `${pkgLink(i.package)} <span class="muted small">${registryName(i.registry)}</span>`,
    ver(i.currentVersion),
    ver(i.targetVersion),
    pill(i.status),
    date(i.targetPublishedAt),
    [
      i.latestSatisfiesDeclared === true ? '<span class="chip" title="The declared range already allows the target">lockfile refresh</span>' : "",
      i.latestSatisfiesDeclared === false ? '<span class="chip" title="The declared requirement must change">manifest change</span>' : "",
      i.roots.length > 1 ? `<span class="chip" title="${esc(i.roots.join(", "))}">${i.roots.length} manifests</span>` : `<span class="chip">${esc(rootLabel(i.roots[0] ?? i.root))}</span>`,
    ].join(""),
  ];
  const headers = ["Project", "Package", "Installed", "Target", "Status", "Released", "Notes"];
  const queue = sections
    .map(([title, f]) => {
      const rows = open.filter(f);
      return rows.length ? `<h3>${esc(title)} <span class="muted">(${rows.length})</span></h3>${table(headers, rows.map(row))}` : "";
    })
    .join("");
  const unverified = items.filter((i) => i.status === "updated-unverified");
  const verified = items.filter((i) => i.status === "updated-verified");
  return `${scanBanner()}<h1>Maintenance queue</h1>
  <p class="muted">What needs updating across the ecosystem, ordered by deprecation, then major, minor and patch. A release being available is not maintenance; an updated manifest is not verification.</p>
  <div class="cards">${cards}</div>
  <h2>Outstanding (${open.length})</h2>${queue || '<p class="muted">No outstanding updates for managed packages.</p>'}
  <h2>Updated, awaiting verification (${unverified.length})</h2>
  ${table(["Project", "Package", "Installed", "Since", "Last verified commit"], unverified.map((i) => [projLink(i.project), pkgLink(i.package), ver(i.currentVersion), date(i.updatedAt), i.lastVerifiedCommit ? `<code>${short(i.lastVerifiedCommit)}</code>` : '<span class="muted">none</span>']), "Nothing waiting on verification.")}
  <h2>Recently verified (${verified.length})</h2>
  ${table(["Project", "Package", "Version", "Verified", "Evidence"], verified.map((i) => [projLink(i.project), pkgLink(i.package), ver(i.currentVersion), date(i.closedAt), evidenceLinks(i)]), "No verified updates in the retention window.")}`;
}

/** @param {MaintenanceItem} i */
function evidenceLinks(i) {
  const e = i.evidence.at(-1);
  if (!e) return '<span class="muted">—</span>';
  const p = state?.projects.find((x) => x.id === i.project);
  const commit = p ? `<a href="https://github.com/${esc(p.repository)}/commit/${esc(e.commit)}"><code>${short(e.commit)}</code></a>` : `<code>${short(e.commit)}</code>`;
  return `${commit} ${e.runs.map((r) => `<a href="${esc(r.url)}">${esc(r.workflow)}</a>`).join(" ")}`;
}

/** @param {URLSearchParams} params */
function viewReleases(params) {
  if (!state) return "";
  const q = params.get("q") ?? "";
  const filters = new Set((params.get("f") ?? "").split(",").filter(Boolean));
  const onlyNew = params.get("new") === "1";
  const newSet = new Set(state.overview.packagesWithNewReleases);
  const pkgs = state.packages.filter((p) => {
    if (q && !`${p.name} ${p.id} ${p.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    const reg = [...filters].filter((f) => f === "npm" || f === "crates");
    const own = [...filters].filter((f) => ["owned", "managed", "upstream"].includes(f));
    if (reg.length && !reg.includes(p.registry)) return false;
    if (own.length && !own.includes(p.ownership)) return false;
    if (onlyNew && !newSet.has(p.id)) return false;
    return true;
  });
  const toggles = [
    ["npm", "npm"],
    ["crates", "crates.io"],
    ["owned", "Owned"],
    ["managed", "Managed"],
    ["upstream", "Upstream"],
  ]
    .map(([k = "", l]) => `<button class="toggle" data-filter="${k}" aria-pressed="${filters.has(k)}">${esc(l)}</button>`)
    .join("");
  const rows = pkgs
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .map((p) => [
      `${pkgLink(p.id)}${p.collection !== "ok" ? ` ${pill(p.collection === "stale" ? "partial" : "failed", p.collection)}` : ""}${p.deprecated ? ` ${pill("deprecated")}` : ""}${newSet.has(p.id) ? ' <span class="chip">new</span>' : ""}`,
      `${registryName(p.registry)} <span class="muted small">${esc(p.ownership)}</span>`,
      ver(p.latestVersion),
      ver(p.previousVersion),
      date(p.publishedAt),
    ]);
  return `${scanBanner()}<h1>Releases</h1><p class="muted">Published versions from the registries. GitHub releases and tags are shown separately on each package.</p>
  <div class="toolbar"><input type="search" id="q" placeholder="Search packages" value="${esc(q)}" aria-label="Search packages">${toggles}
  <button class="toggle" data-new aria-pressed="${onlyNew}">New (${state.overview.packagesWithNewReleases.length})</button></div>
  ${table(["Package", "Registry", "Latest", "Previous", "Published"], rows, "No packages match.")}`;
}

function viewProjects() {
  if (!state) return "";
  const rows = state.projects.map((p) => {
    const inst = state?.installations.filter((i) => i.project === p.id && i.status !== "local") ?? [];
    const current = inst.filter((i) => i.status === "current").length;
    const behind = inst.filter((i) => BEHIND.has(i.status)).length;
    const v = p.verification;
    const verification = !v
      ? '<span class="muted">not configured</span>'
      : v.headVerified === true
        ? pill("ok", "head verified")
        : v.headVerified === false
          ? pill("failed", "head failing")
          : pill("unknown", "pending");
    return [
      `${projLink(p.id)}<div class="muted small">${esc(p.repository)}</div>`,
      `<span class="num">${inst.length}</span>`,
      `<span class="num ok">${current}</span>`,
      `<span class="num ${behind ? "alert" : ""}">${behind}</span>`,
      `${verification}${v?.lastVerifiedCommit ? `<div class="small muted">last verified <code>${short(v.lastVerifiedCommit)}</code></div>` : ""}`,
      `${pill(p.scanStatus)} <span class="muted small">${ago(p.lastSuccessfulScan)}</span>`,
    ];
  });
  return `${scanBanner()}<h1>Projects</h1><p class="muted">Managed-package installations per project. Workspace and path links are excluded from the counts.</p>
  ${table(["Project", "Dependencies", "Current", "Behind", "Verification", "Scan"], rows, "No projects configured.")}`;
}

/** @param {string} id */
async function viewProject(id) {
  if (!state) return "";
  const p = state.projects.find((x) => x.id === id);
  if (!p) return `<h1>Unknown project</h1><p><a href="#/projects">All projects</a></p>`;
  const inst = state.installations.filter((i) => i.project === id);
  const items = state.items.filter((i) => i.project === id);
  /** @type {{ records: EvidenceRecord[] } | null} */
  const evidence = await getLazy(`data/evidence/${encodeURIComponent(id)}.json`);
  const origin = location.href.replace(/[#?].*$/, "").replace(/index\.html$/, "");
  const badgeNames = ["status", "dependencies", "behind", "scan"];
  const md = `## Maintenance\n${badgeNames.map((b) => `![${b}](${origin}badges/${id}-${b}.svg)`).join("\n")}`;
  const instRows = inst
    .sort((a, b) => a.root.localeCompare(b.root) || a.name.localeCompare(b.name))
    .map((i) => [
      `${pkgLink(i.package ?? i.name)}${i.stale ? ` ${pill("partial", "stale")}` : ""}`,
      `<span class="chip">${esc(rootLabel(i.root))}</span><div class="muted small">${esc(i.kind)}${i.optional ? ", optional" : ""}</div>`,
      i.declaredVersion ? `<code>${esc(i.declaredVersion)}</code>` : '<span class="muted">—</span>',
      i.source === "registry" ? ver(i.resolvedVersion) : `<span class="small">${esc(i.source)}</span> <span class="muted small mono">${esc(i.sourceRevision ?? "")}</span>`,
      ver(i.latestVersion),
      `${pill(i.status)}${i.lockfileInSync === false ? ' <span class="chip bad" title="Resolved version does not satisfy the declared requirement">lockfile out of sync</span>' : ""}`,
      i.verification.verified ? `${pill("ok", "verified")} <code class="small">${short(i.verification.commit ?? "")}</code>` : '<span class="muted">unverified</span>',
    ]);
  const ev = (evidence?.records ?? []).slice().reverse().slice(0, 10);
  const evRows = ev.map((r) => [
    `<a href="https://github.com/${esc(p.repository)}/commit/${esc(r.commit)}"><code>${short(r.commit)}</code></a>`,
    date(r.collectedAt),
    pill(r.passed ? "ok" : "failed", r.passed ? "passed" : "failed"),
    `resolution ${pill(r.checks.resolution === "pass" ? "ok" : "failed", r.checks.resolution)} workflows ${pill(r.checks.workflows === "pass" ? "ok" : r.checks.workflows === "pending" ? "unknown" : "failed", r.checks.workflows)}`,
    r.runs.map((x) => `<a href="${esc(x.url)}">${esc(x.workflow)}</a> <span class="muted small">${esc(x.conclusion ?? x.status)}</span>`).join("<br>") || '<span class="muted">—</span>',
    r.scanRun ? (r.scanRun.startsWith("http") ? `<a href="${esc(r.scanRun)}">scan run</a>` : esc(r.scanRun)) : '<span class="muted">local</span>',
  ]);
  return `${scanBanner()}<p class="small"><a href="#/projects">Projects</a> /</p><h1>${esc(p.name)}</h1>
  <p class="badges"><img src="badges/${esc(id)}-status.svg" alt="maintenance status"><img src="badges/${esc(id)}-dependencies.svg" alt="dependencies"><img src="badges/${esc(id)}-scan.svg" alt="last scan"></p>
  ${p.error ? `<div class="banner bad"><strong>${esc(p.scanStatus)}:</strong> ${esc(p.error)}${p.lastSuccessfulScan ? ` Showing data from the last successful scan (${date(p.lastSuccessfulScan)}).` : ""}</div>` : ""}
  <dl class="meta">
    <dt>Repository</dt><dd>${repoLink(p.repository)}</dd>
    <dt>Branch</dt><dd>${esc(p.branch ?? "—")}</dd>
    <dt>Commit scanned</dt><dd>${p.commit && p.commitUrl ? `<a href="${esc(p.commitUrl)}"><code>${short(p.commit)}</code></a>` : "—"}</dd>
    <dt>Last scan</dt><dd>${date(p.lastScanned)} ${pill(p.scanStatus)}</dd>
    <dt>Manifests</dt><dd>${p.roots.map((r) => `<span class="chip" title="${esc(r.manifest)}${r.lockfile ? " → " + esc(r.lockfile) : ""}">${esc(rootLabel(r.path))} · ${esc(r.ecosystem)}</span>`).join("") || "—"}</dd>
    <dt>Verification</dt><dd>${p.verification ? `${esc(p.verification.workflows.join(", "))} must pass on the commit, with every managed dependency resolved from the lockfile` : '<span class="muted">not configured — updates can never become verified</span>'}</dd>
  </dl>
  ${p.missingManagedPackages.length ? `<div class="banner">Configured as managed but not found in any manifest: ${p.missingManagedPackages.map(pkgLink).join(", ")}</div>` : ""}
  <h2>Managed dependencies</h2>
  ${table(["Package", "Manifest", "Declared", "Resolved", "Latest", "Status", "Verification"], instRows, "No managed packages found in this project.")}
  <h2>Maintenance</h2>
  ${table(["Package", "Installed", "Target", "Status", "History"], items.map((i) => [pkgLink(i.package), ver(i.currentVersion), ver(i.targetVersion), pill(i.status), `<span class="small muted">${i.history.slice(-4).map((h) => `${esc(h.status)} ${esc(h.at.slice(0, 10))}`).join(" → ")}</span>`]), "No maintenance items.")}
  <h2>Verification evidence</h2>
  ${table(["Commit", "Collected", "Result", "Checks", "Workflow runs", "Scan"], evRows, p.verification ? "No evidence collected yet (workflow runs may still be pending)." : "Verification is not configured for this project.")}
  ${p.catalogPackagesNotManaged.length ? `<h2>Curation hints</h2><p class="muted">Catalog packages used here but not listed in this project's <code>managedPackages</code>: ${p.catalogPackagesNotManaged.map(pkgLink).join(", ")}</p>` : ""}
  ${p.warnings.length ? `<details><summary>${p.warnings.length} scan warning${p.warnings.length === 1 ? "" : "s"}</summary><ul class="plain small">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
  <h2>README badges</h2><pre class="snippet">${esc(md)}</pre>`;
}

/** @param {string} id */
async function viewPackage(id) {
  if (!state) return "";
  const p = state.packages.find((x) => x.id === id);
  if (!p) return `<h1>Unknown package</h1><p><a href="#/releases">All packages</a></p>`;
  /** @type {{ releases: { package: string, versions: VersionInfo[] }[] } | null} */
  const releases = await getLazy("data/releases.json");
  const history = releases?.releases.find((r) => r.package === id)?.versions ?? [];
  const consumers = state.installations.filter((i) => i.package === id);
  /** @type {Map<string, number>} */
  const dist = new Map();
  for (const i of consumers) {
    const k = i.status === "local" ? "workspace/path link" : (i.resolvedVersion ?? "unresolved");
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  const max = Math.max(1, ...dist.values());
  const gh = p.github;
  const origin = location.href.replace(/[#?].*$/, "").replace(/index\.html$/, "");
  const md = ["version", "release", "consumers"].map((b) => `![${b}](${origin}badges/${id}-${b}.svg)`).join("\n");
  const tags = p.distTags ? Object.entries(p.distTags).map(([t, v]) => `<span class="chip">${esc(t)}: ${esc(v)}</span>`).join("") : "";
  return `${scanBanner()}<p class="small"><a href="#/releases">Releases</a> /</p><h1>${esc(p.name)}</h1>
  <p class="muted">${esc(p.description ?? "")}</p>
  <p class="badges"><img src="badges/${esc(id)}-version.svg" alt="latest version"><img src="badges/${esc(id)}-release.svg" alt="latest release"><img src="badges/${esc(id)}-consumers.svg" alt="consumers"></p>
  ${p.collection !== "ok" ? `<div class="banner ${p.collection === "failed" ? "bad" : ""}"><strong>Registry ${esc(p.collection)}:</strong> ${esc(p.error ?? "")}${p.collection === "stale" ? " Showing the last successfully collected data." : ""}</div>` : ""}
  ${p.deprecated ? `<div class="banner bad"><strong>Latest version is deprecated:</strong> ${esc(p.deprecated)}</div>` : ""}
  <dl class="meta">
    <dt>Registry</dt><dd><a href="${esc(p.registryUrl)}">${registryName(p.registry)}</a> · ${esc(p.ownership)}</dd>
    <dt>Repository</dt><dd>${p.repository ? repoLink(p.repository) : '<span class="muted">unknown</span>'}${p.directory ? ` <span class="chip">${esc(p.directory)}</span>` : ""}</dd>
    <dt>Latest published</dt><dd>${ver(p.latestVersion)} ${date(p.publishedAt)}</dd>
    <dt>Latest stable</dt><dd>${ver(p.latestStable)}</dd>
    <dt>Latest prerelease</dt><dd>${ver(p.latestPrerelease)}${p.trackPrereleases ? ' <span class="chip">tracked</span>' : ""}</dd>
    ${tags ? `<dt>Dist-tags</dt><dd>${tags}</dd>` : ""}
    <dt>GitHub release</dt><dd>${gh?.latestRelease ? `<a href="${esc(gh.latestRelease.url)}">${esc(gh.latestRelease.tag)}</a> ${date(gh.latestRelease.publishedAt)}` : gh ? '<span class="muted">none</span>' : '<span class="muted">not collected</span>'}</dd>
    <dt>GitHub latest tag</dt><dd>${gh?.latestTag ? `<code>${esc(gh.latestTag)}</code>` : '<span class="muted">—</span>'}</dd>
    <dt>Repository activity</dt><dd>${gh?.pushedAt ? `last push ${date(gh.pushedAt)}` : '<span class="muted">—</span>'}${gh?.archived ? " " + pill("deprecated", "archived") : ""}</dd>
    <dt>Versions</dt><dd>${p.versionCount}${p.yankedVersions.length ? ` · yanked: ${p.yankedVersions.map((v) => `<code>${esc(v)}</code>`).join(", ")}` : ""}${Object.keys(p.deprecatedVersions).length ? ` · ${Object.keys(p.deprecatedVersions).length} deprecated` : ""}</dd>
  </dl>
  <h2>Consuming projects (${new Set(consumers.map((c) => c.project)).size})</h2>
  ${table(["Project", "Manifest", "Declared", "Resolved", "Status"], consumers.map((i) => [projLink(i.project), `<span class="chip">${esc(rootLabel(i.root))}</span>`, i.declaredVersion ? `<code>${esc(i.declaredVersion)}</code>` : "—", ver(i.resolvedVersion), pill(i.status)]), "No tracked project lists this package in managedPackages.")}
  <h2>Installed version distribution</h2>
  ${table(["Version", "Installations", ""], [...dist.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => [`<code>${esc(v)}</code>`, String(n), `<div class="bar" style="width:${Math.round((n / max) * 100)}%"></div>`]), "Not installed by any tracked project.")}
  <h2>Release history</h2>
  ${table(["Version", "Published", "Notes"], history.map((v) => [ver(v.version), date(v.publishedAt), [v.prerelease ? '<span class="chip">prerelease</span>' : "", v.yanked ? pill("yanked") : "", v.deprecated ? `${pill("deprecated")} <span class="small muted">${esc(v.deprecated)}</span>` : ""].join(" ")]), "No release history collected.")}
  <h2>README badges</h2><pre class="snippet">${esc(md)}</pre>`;
}

async function viewHistory() {
  /** @type {{ snapshots: { file: string, at: string, status: string, counts: Record<string, number>, changes: Record<string, number> }[] } | null} */
  const idx = await getLazy("data/history/index.json");
  const changes = state?.snapshot.changes;
  const list = (/** @type {string} */ title, /** @type {string[]} */ rows) => (rows.length ? `<h3>${esc(title)}</h3><ul class="plain small">${rows.join("")}</ul>` : "");
  return `${scanBanner()}<h1>Scan history</h1><p class="muted">Every successful or partial scan is retained as a timestamped snapshot. Failed scans write nothing.</p>
  ${changes ? `<h2>Changes in the latest scan</h2>
  ${list("New releases", changes.newReleases.map((c) => `<li>${pkgLink(c.package)} ${ver(c.from)} → ${ver(c.to)}</li>`))}
  ${list("Installed version changes", changes.versionChanges.map((c) => `<li>${projLink(c.project)} <span class="chip">${esc(c.root)}</span> ${esc(c.name)} ${ver(c.from)} → ${ver(c.to)}</li>`))}
  ${list("Maintenance status changes", changes.statusChanges.map((c) => `<li><code>${esc(c.key)}</code> ${c.from ? pill(c.from) : "new"} → ${pill(c.to)}</li>`))}
  ${list("New verification evidence", changes.newEvidence.map((c) => `<li>${projLink(c.project)} <code>${short(c.commit)}</code> ${pill(c.passed ? "ok" : "failed", c.passed ? "passed" : "failed")}</li>`))}
  ${list("Newly discovered dependencies", changes.newDependencies.slice(0, 50).map((c) => `<li>${projLink(c.project)} <span class="chip">${esc(c.root)}</span> ${esc(c.name)} ${ver(c.version)}</li>`))}
  ${list("Removed dependencies", changes.removedDependencies.slice(0, 50).map((c) => `<li>${projLink(c.project)} <span class="chip">${esc(c.root)}</span> ${esc(c.name)}</li>`))}` : ""}
  <h2>Snapshots</h2>
  ${table(["Scan", "Status", "Packages", "Projects", "Open items", "Changes"], (idx?.snapshots ?? []).map((s) => [`<a href="${esc(s.file)}">${esc(s.at.replace("T", " ").slice(0, 16))}</a>`, pill(s.status), `${s.counts.packages ?? 0} <span class="muted small">(${s.counts.packagesFailed ?? 0} failed)</span>`, `${s.counts.projects ?? 0} <span class="muted small">(${s.counts.projectsFailed ?? 0} failed)</span>`, String(s.counts.maintenanceOpen ?? 0), `<span class="small">${s.changes.newReleases ?? 0} releases · ${s.changes.versionChanges ?? 0} version · ${s.changes.statusChanges ?? 0} status</span>`]), "No snapshots yet.")}`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function render() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  const parts = (path ?? "/").split("/").filter(Boolean).map(decodeURIComponent);
  const section = parts[0] === "project" ? "projects" : parts[0] === "package" ? "releases" : (parts[0] ?? "queue");
  document.querySelectorAll("nav a").forEach((a) => a.toggleAttribute("aria-current", false));
  document.querySelector(`nav a[data-nav="${section}"]`)?.setAttribute("aria-current", "page");
  let html;
  if (parts[0] === "releases") html = viewReleases(params);
  else if (parts[0] === "projects") html = viewProjects();
  else if (parts[0] === "project" && parts[1]) html = await viewProject(parts[1]);
  else if (parts[0] === "package" && parts[1]) html = await viewPackage(parts[1]);
  else if (parts[0] === "history") html = await viewHistory();
  else html = viewQueue();
  app.innerHTML = html;
  const title = app.querySelector("h1")?.textContent;
  document.title = title ? `${title} · Boundry Maintenance` : "Boundry Maintenance";
  wireReleases(params);
}

/** @param {URLSearchParams} params */
function wireReleases(params) {
  const q = /** @type {HTMLInputElement | null} */ (document.getElementById("q"));
  const update = (/** @type {(p: URLSearchParams) => void} */ fn, refocusSearch = false) => {
    const next = new URLSearchParams(params);
    fn(next);
    for (const [k, v] of [...next.entries()]) if (!v) next.delete(k);
    const qs = next.toString();
    history.replaceState(null, "", `#/releases${qs ? "?" + qs : ""}`);
    void render().then(() => {
      const box = /** @type {HTMLInputElement | null} */ (document.getElementById("q"));
      if (refocusSearch && box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    });
  };
  q?.addEventListener("input", () => update((p) => p.set("q", q.value), true));
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () =>
      update((p) => {
        const f = new Set((p.get("f") ?? "").split(",").filter(Boolean));
        const k = /** @type {HTMLElement} */ (b).dataset.filter ?? "";
        f.has(k) ? f.delete(k) : f.add(k);
        p.set("f", [...f].join(","));
      }),
    ),
  );
  document.querySelector("[data-new]")?.addEventListener("click", () => update((p) => p.set("new", p.get("new") === "1" ? "" : "1")));
}

async function main() {
  try {
    const [dashboard, packages, projects, installations, maintenance, snapshot] = await Promise.all([
      getJson("data/dashboard.json"),
      getJson("data/packages.json"),
      getJson("data/projects.json"),
      getJson("data/installations.json"),
      getJson("data/maintenance.json"),
      getJson("data/snapshot.json"),
    ]);
    state = { overview: dashboard.overview, packages: packages.packages, projects: projects.projects, installations: installations.installations, items: maintenance.items, snapshot };
  } catch (e) {
    app.innerHTML = `<h1>No inventory yet</h1><p class="muted">The dashboard reads generated data from <code>data/</code>. Run a scan (<code>npm run scan</code>) and build the site (<code>npm run report</code>).</p><p class="small muted">${esc(e instanceof Error ? e.message : e)}</p>`;
    return;
  }
  window.addEventListener("hashchange", () => void render());
  await render();
}

void main();
