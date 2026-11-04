/**
 * Deterministic recognition of version-enforcing CI. Two kinds of knowledge:
 *
 *  - Built-in commands whose behaviour is documented (npm ci, cargo --locked, …):
 *    their condition is known exactly → "identified".
 *  - Arbitrary scripts: recognised by signals (registry queries, lockfile reads,
 *    version comparisons, tags…). Their full condition cannot be known from
 *    pattern matching → at best "partially-understood" until annotated.
 */
import type { CiCheckType } from "../contracts.ts";

export interface BuiltinCheck {
  id: string;
  types: CiCheckType[];
  condition: string;
  /** True when the command exists only to check (so its failure is a check failure). */
  dedicated: boolean;
}

interface BuiltinRule extends BuiltinCheck {
  pattern: RegExp;
}

const BUILTINS: BuiltinRule[] = [
  {
    id: "npm-ci",
    pattern: /\bnpm\s+(ci|clean-install|install-clean)\b/,
    types: ["version-consistency"],
    condition: "package-lock.json must satisfy package.json exactly (npm ci fails on any drift)",
    dedicated: false,
  },
  {
    id: "frozen-lockfile",
    pattern: /\b(pnpm|yarn)\s+install\b[^\n]*(--frozen-lockfile|--immutable)/,
    types: ["version-consistency"],
    condition: "the lockfile must already match the manifests (install refuses to modify it)",
    dedicated: false,
  },
  {
    id: "cargo-locked",
    pattern: /\bcargo\s+[^\n]*--(locked|frozen)\b/,
    types: ["version-consistency"],
    condition: "Cargo.lock must be up to date with every Cargo.toml (--locked refuses to update it)",
    dedicated: false,
  },
  {
    id: "npm-ls",
    pattern: /\bnpm\s+(ls|list)\b(?![^\n]*\|\|\s*true)/,
    types: ["dependency-compatibility"],
    condition: "every installed package must satisfy its declared range and peer requirements (npm ls exits non-zero otherwise)",
    dedicated: true,
  },
  {
    id: "npm-outdated",
    pattern: /\bnpm\s+outdated\b(?![^\n]*\|\|\s*true)/,
    types: ["version-freshness"],
    condition: "no dependency may be behind the version npm considers wanted/latest (npm outdated exits 1 otherwise)",
    dedicated: true,
  },
  {
    id: "cargo-outdated",
    pattern: /\bcargo\s+outdated\b[^\n]*--exit-code/,
    types: ["version-freshness"],
    condition: "no crate may be behind its latest compatible release (cargo outdated --exit-code)",
    dedicated: true,
  },
  {
    id: "cargo-semver-checks",
    pattern: /\bcargo[\s-]semver-checks\b/,
    types: ["release-consistency"],
    condition: "public API changes must match the version bump relative to the published crate",
    dedicated: true,
  },
  {
    id: "publish-dry-run",
    pattern: /\b(npm|pnpm|yarn)\s+(publish|pack)\b[^\n]*--dry-run|\bcargo\s+publish\b[^\n]*--dry-run|\bcargo\s+package\b/,
    types: ["publication-validation"],
    condition: "the package must build into a publishable artifact (publish/pack dry run)",
    dedicated: true,
  },
];

export function builtinChecks(command: string): BuiltinCheck[] {
  return BUILTINS.filter((b) => b.pattern.test(command)).map(({ pattern: _p, ...b }) => b);
}

interface SignalRule {
  id: string;
  pattern: RegExp;
  strong: boolean;
}

/** Evidence that source text inspects versions. Strong signals alone justify a candidate check. */
const SIGNALS: SignalRule[] = [
  { id: "registry-query", pattern: /\bnpm\s+(view|info|show)\b|["']npm["'],\s*\[\s*["'](view|info|show|outdated)["']|registry\.npmjs\.org|crates\.io\/api|index\.crates\.io|\bcargo\s+(search|info)\b|dist-tags/, strong: true },
  { id: "lockfile", pattern: /package-lock\.json|npm-shrinkwrap|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|\bnpm\s+ls\b|\bcargo\s+tree\b/, strong: true },
  { id: "version-compare", pattern: /\bsemver\b|\bsatisfies\(|\batLeast\b|compareVersions|\bmaxSatisfying\b|\blockstep\b|exact (pin|version)|is not an exact/i, strong: true },
  { id: "tags", pattern: /\bgit\s+(tag|describe)\b|refs\/tags|GITHUB_REF_NAME|github\.ref_name|\bgh\s+release\b|releases\/latest|RELEASE_VERSION/, strong: false },
  { id: "publication", pattern: /dist\.integrity|is not published|already published|\bnpm\s+publish\b|\bcargo\s+publish\b/, strong: true },
  { id: "manifest-version", pattern: /\.version\b|["']version["']|\bversion\s*=|\bdependencies\[|peerDependencies|workspace\.dependencies|\[dependencies\]/, strong: false },
  { id: "latest", pattern: /\blatest\b|\boutdated\b|\bnewest\b/i, strong: false },
  { id: "compatibility", pattern: /peerDependencies|compatib|minimal-versions|cargo\s+hack|\bceiling\b/i, strong: false },
  { id: "integration", pattern: /\be2e\b|integration|upgrade from|packed tarball|external consumer|clean .*consumer/i, strong: false },
];

export function signalsIn(text: string): string[] {
  return SIGNALS.filter((s) => s.pattern.test(text)).map((s) => s.id);
}

export function hasStrongSignal(signals: string[]): boolean {
  return signals.some((id) => SIGNALS.find((s) => s.id === id)?.strong);
}

/** Map signals (plus a little textual context) to check types. Order is significance. */
export function typesFromSignals(signals: string[], text: string): CiCheckType[] {
  const s = new Set(signals);
  const t = new Set<CiCheckType>();
  if (s.has("registry-query") && s.has("latest")) t.add("version-freshness");
  if (/exact (pin|version)|is not an exact|\bpins?\b|\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\//i.test(text)) t.add("version-pinning");
  if (s.has("lockfile") || /\blockstep\b|must match|drift|same version|out of sync/i.test(text)) t.add("version-consistency");
  if (s.has("tags") && (s.has("manifest-version") || s.has("version-compare"))) t.add("release-consistency");
  if (s.has("compatibility") && (s.has("version-compare") || s.has("manifest-version") || s.has("lockfile"))) t.add("dependency-compatibility");
  if (s.has("publication")) t.add("publication-validation");
  if (s.has("integration") && t.size === 0) t.add("integration-validation");
  return [...t];
}

/** Catalog packages named in text. Unscoped names must appear quoted or in a package-ish position to avoid common words. */
export function packagesIn(text: string, catalog: { id: string; name: string }[]): string[] {
  const found = new Set<string>();
  for (const p of catalog) {
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = p.name.startsWith("@")
      ? new RegExp(`${esc}(?![\\w-])`)
      : new RegExp(`["'\`]${esc}["'\`@]|(?:-p|--package)\\s+${esc}\\b|\\b${esc}@\\d|\\b${esc}\\s+\\d+\\.\\d+`);
    if (re.test(text)) found.add(p.id);
  }
  return [...found].sort();
}

const VERSIONISH = /version|latest|pin|range|lock|publish|release|tag|semver|>=|\bv\d|ceiling|floor|outdated|integrity|lockstep|drift/i;
const FAILURE_SITE = /\bcheck\(|\bassert|throw new Error|console\.error|process\.exit\(1\)|\bexit 1\b|::error|(blockers|problems|errors|failures)\.push|\bfail\(|\bbail\(/;

/** Failure messages that mention versions — the check's own statement of what must be true. */
export function assertionsIn(source: string, limit = 8): string[] {
  const out: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]!;
    if (!FAILURE_SITE.test(line)) continue;
    // The message may sit on the same line or the next (wrapped calls). Template literals first: they carry messages.
    const window = `${line} ${lines[i + 1] ?? ""}`;
    const m = window.match(/`([^`]{12,240})`/) ?? window.match(/"([^"]{12,240})"/) ?? window.match(/'([^']{12,240})'/);
    const raw = m?.[1];
    if (!raw || /&&|\|\||=>|\)\s*[,;]|^\s*[,)]/.test(raw)) continue; // code, not a message
    const msg = raw.replace(/\$\{([^}]{1,60})\}/g, "<$1>").replace(/\\n/g, " ").trim();
    if (msg && VERSIONISH.test(msg) && !out.includes(msg)) out.push(msg);
  }
  return out;
}

/** Environment values that typically weaken a check (report-only, warn, skip). */
export function relaxes(value: string): boolean {
  return /^(report|warn|warning|notice|false|0|off|skip|disabled?|dry-?run|advisory)$/i.test(value.trim());
}
