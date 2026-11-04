/** Self-contained SVG badges (flat style). No third-party badge service involved. */
import type { CiFile, Installation, MaintenanceItem, PackageRecord, ProjectRecord } from "../contracts.ts";

export const COLORS = {
  green: "#2e7d32",
  yellow: "#a87b00",
  orange: "#c25100",
  red: "#c62828",
  blue: "#1565c0",
  grey: "#616161",
  label: "#454545",
};

/** Approximate Verdana 11px advance widths — enough to size badges without a font engine. */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if ("il.,:;|!'`".includes(ch)) w += 3.3;
    else if ("fjrtI()[] 1".includes(ch)) w += 4.6;
    else if ("mwMW@%".includes(ch)) w += 10;
    else if (/[A-Z]/.test(ch)) w += 7.6;
    else if (/[0-9]/.test(ch)) w += 7;
    else w += 6.4;
  }
  return Math.ceil(w);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function badge(label: string, message: string, color: string): string {
  const lw = textWidth(label) + 12;
  const mw = textWidth(message) + 12;
  const w = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">
<title>${esc(label)}: ${esc(message)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="${COLORS.label}"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(message)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text>
</g></svg>
`;
}

const BEHIND = new Set(["patch-behind", "minor-behind", "major-behind", "prerelease", "deprecated", "yanked"]);

export function projectStatus(project: ProjectRecord, installs: Installation[], items: MaintenanceItem[]): { message: string; color: string } {
  if (project.scanStatus === "inaccessible") return { message: "inaccessible", color: COLORS.grey };
  if (project.scanStatus === "failed") return { message: "scan failed", color: COLORS.red };
  if (project.scanStatus === "inactive") return { message: "inactive", color: COLORS.grey };
  const open = items.filter((i) => i.status.startsWith("update-"));
  const required = open.filter((i) => i.status === "update-required").length;
  if (required) return { message: `${required} update${required > 1 ? "s" : ""} required`, color: COLORS.red };
  if (open.some((i) => i.status === "update-in-progress")) return { message: "update in progress", color: COLORS.orange };
  if (open.length) return { message: `${open.length} update${open.length > 1 ? "s" : ""} available`, color: COLORS.yellow };
  if (installs.some((i) => i.status === "unknown" || i.status === "unavailable")) return { message: "incomplete data", color: COLORS.grey };
  if (items.some((i) => i.status === "updated-unverified")) return { message: "updated, unverified", color: COLORS.blue };
  return { message: "maintained", color: COLORS.green };
}

export function generateBadges(input: {
  packages: PackageRecord[];
  projects: ProjectRecord[];
  installations: Installation[];
  items: MaintenanceItem[];
  ci?: CiFile | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  // CI enforcement per repository: ci-<owner>-<repo>.svg ("version checks")
  for (const repo of input.ci?.repositories ?? []) {
    const checks = (input.ci?.checks ?? []).filter((c) => c.repository === repo.repository && c.workflow !== null);
    const failing = checks.filter((c) => c.result === "failing").length;
    const passing = checks.filter((c) => c.result === "passing").length;
    const name = `ci-${repo.repository.replace("/", "-")}.svg`;
    if (repo.status !== "ok") out[name] = badge("version checks", repo.status, COLORS.grey);
    else if (!checks.length) out[name] = badge("version checks", "none found", COLORS.grey);
    else if (failing) out[name] = badge("version checks", `${failing} failing`, COLORS.red);
    else out[name] = badge("version checks", `${passing}/${checks.length} passing`, passing === checks.length ? COLORS.green : COLORS.grey);
  }
  for (const p of input.projects) {
    const installs = input.installations.filter((i) => i.project === p.id);
    const items = input.items.filter((i) => i.project === p.id);
    const s = projectStatus(p, installs, items);
    out[`${p.id}-status.svg`] = badge("maintenance", s.message, s.color);
    const registryInstalls = installs.filter((i) => i.status !== "local");
    const current = registryInstalls.filter((i) => i.status === "current").length;
    const behind = registryInstalls.filter((i) => BEHIND.has(i.status)).length;
    const known = p.scanStatus === "ok" || installs.length > 0;
    out[`${p.id}-dependencies.svg`] = badge(
      "dependencies",
      known ? `${current}/${registryInstalls.length} current` : "unknown",
      !known ? COLORS.grey : behind === 0 && current === registryInstalls.length ? COLORS.green : behind ? COLORS.yellow : COLORS.grey,
    );
    out[`${p.id}-behind.svg`] = badge("behind", known ? String(behind) : "unknown", !known ? COLORS.grey : behind ? COLORS.orange : COLORS.green);
    const last = p.lastSuccessfulScan;
    const ageDays = last ? (Date.now() - Date.parse(last)) / 86_400_000 : Infinity;
    out[`${p.id}-scan.svg`] = badge("last scan", last ? last.slice(0, 10) : "never", ageDays <= 2 ? COLORS.green : ageDays <= 7 ? COLORS.yellow : COLORS.red);
  }
  for (const pkg of input.packages) {
    const label = pkg.registry === "npm" ? "npm" : "crates.io";
    const version = pkg.latestVersion ? `v${pkg.latestVersion}` : "unavailable";
    const color = pkg.collection !== "ok" ? COLORS.grey : pkg.deprecated ? COLORS.red : COLORS.blue;
    out[`${pkg.id}-version.svg`] = badge(label, pkg.collection === "stale" ? `${version} (stale)` : version, color);
    const rel = pkg.github?.latestRelease;
    out[`${pkg.id}-release.svg`] = badge("release", rel ? rel.tag : pkg.github ? "none" : "unknown", rel ? COLORS.blue : COLORS.grey);
    const consumers = new Set(input.installations.filter((i) => i.package === pkg.id).map((i) => i.project)).size;
    out[`${pkg.id}-consumers.svg`] = badge("used by", `${consumers} project${consumers === 1 ? "" : "s"}`, consumers ? COLORS.blue : COLORS.grey);
  }
  return out;
}
