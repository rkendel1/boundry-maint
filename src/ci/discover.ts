/**
 * CI discovery: find the checks in a repository that enforce versions.
 *
 * Each workflow step is followed through `npm run` scripts (including
 * workspaces) and script files it executes, then classified from documented
 * built-in behaviour and from signals in the source. Scripts that look like
 * version checks but are never run by a workflow are recorded as local-only
 * gates. Annotations from config/ci.json clarify, override or add checks.
 */
import { posix } from "node:path";
import type { CiAnnotation, CiCheck, CiCheckType, CiRequirement } from "../contracts.ts";
import type { RepoFiles } from "../scanners/common.ts";
import { assertionsIn, builtinChecks, hasStrongSignal, packagesIn, relaxes, signalsIn, typesFromSignals, type BuiltinCheck } from "./signals.ts";
import { parseWorkflow, type Workflow, type WorkflowJob, type WorkflowStep } from "./workflow.ts";

const SCRIPT_EXT = /\.(mjs|cjs|js|ts|mts|sh|bash|py)$/;
const SCRIPT_DIRS = /^(scripts|tools|bin|ci|\.github\/scripts|\.github\/actions|xtask)\//;
const CANDIDATE_NAME = /version|release|check|gate|verify|compat|publish|lock|dep|pin|drift|consisten|sync|outdated|bump|doctor/i;
const TRIVIAL = /^(echo|cd|mkdir|set|export|tee|cat|ls|true|exit|status=|printf|test|\[|if|then|fi|else|for|do|done|rm|cp|mv|sleep|:)\b/;
const MAX_SCRIPTS = 40;
const MAX_DEPTH = 4;

export interface DiscoveryInput {
  repository: string;
  commit: string;
  files: RepoFiles;
  catalog: { id: string; name: string }[];
  annotations: CiAnnotation[];
}

export interface DiscoveryResult {
  workflows: Workflow[];
  checks: CiCheck[];
  scriptsInspected: number;
  warnings: string[];
}

interface Resolved {
  /** Source files reached (workflow excluded). */
  files: Map<string, string>;
  /** Text of npm script values reached, for signals. */
  scriptValues: string[];
  builtins: BuiltinCheck[];
  /** Whether every non-trivial command reached is a check. */
  checkish: boolean;
  /** npm script names reached (for "how is this run" notes). */
  npmScripts: string[];
}

const empty = (): Resolved => ({ files: new Map(), scriptValues: [], builtins: [], checkish: true, npmScripts: [] });

function merge(into: Resolved, from: Resolved): void {
  for (const [k, v] of from.files) into.files.set(k, v);
  into.scriptValues.push(...from.scriptValues);
  into.builtins.push(...from.builtins);
  into.npmScripts.push(...from.npmScripts);
  into.checkish &&= from.checkish;
}

/** Split shell text into simple commands. */
export function commandsOf(run: string): string[] {
  return run
    .replace(/\\\n/g, " ")
    .split(/\n|&&|\|\||;|\|/)
    .map((c) => c.trim().replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, ""))
    .filter((c) => c && !c.startsWith("#"));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step";

export async function discoverChecks(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { repository, commit, files } = input;
  const paths = new Set(files.paths);
  const warnings: string[] = [];
  const readCache = new Map<string, Promise<string | null>>();
  const read = (p: string) => {
    let r = readCache.get(p);
    if (!r) {
      r = files.read(p).catch(() => null);
      readCache.set(p, r);
    }
    return r;
  };
  const blobUrl = (path: string, line?: number) => `https://github.com/${repository}/blob/${commit}/${path}${line ? `#L${line}` : ""}`;

  // package.json files by directory and by package name (for -w / --workspace).
  const pkgJsonPaths = files.paths.filter((p) => (p === "package.json" || p.endsWith("/package.json")) && !p.includes("node_modules/")).slice(0, 300);
  const pkgByDir = new Map<string, { name?: string; scripts?: Record<string, string> }>();
  for (const p of pkgJsonPaths) {
    const t = await read(p);
    if (!t) continue;
    try {
      pkgByDir.set(posix.dirname(p), JSON.parse(t));
    } catch {
      /* unparsable manifests are reported by the project scanner */
    }
  }
  const dirOfPkgName = (name: string) => [...pkgByDir.entries()].find(([, v]) => v.name === name)?.[0] ?? null;

  const toRepoPath = (cwd: string, p: string) => posix.normalize(posix.join(cwd, p.replace(/^["']|["']$/g, ""))).replace(/^\.\//, "");

  async function resolveFile(path: string, depth: number, seen: Set<string>): Promise<Resolved> {
    const r = empty();
    if (seen.has(path) || depth > MAX_DEPTH) return r;
    seen.add(path);
    const text = await read(path);
    if (text === null) return r;
    r.files.set(path, text);
    r.checkish = hasStrongSignal(signalsIn(text));
    // Follow other repository scripts this one executes (helpers, nested gates).
    for (const m of text.matchAll(/(?:^|[\s"'`(\[,])((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|ts|sh|py))(?=["'`\s),\]])/g)) {
      const rel = m[1]!;
      for (const candidate of [toRepoPath(posix.dirname(path), rel), toRepoPath(".", rel)]) {
        if (candidate !== path && paths.has(candidate) && SCRIPT_EXT.test(candidate)) {
          const nested = await resolveFile(candidate, depth + 1, seen);
          nested.checkish = r.checkish; // helpers do not change whether this file is a check
          merge(r, nested);
          break;
        }
      }
    }
    // npm scripts invoked from code: execFileSync("npm", ["run", "test:release"])
    for (const m of text.matchAll(/["']run["'],\s*["']([\w:.-]+)["']/g)) {
      const nested = await resolveNpmScript(".", m[1]!, depth + 1, seen);
      nested.checkish = r.checkish;
      merge(r, nested);
    }
    return r;
  }

  async function resolveNpmScript(dir: string, script: string, depth: number, seen: Set<string>): Promise<Resolved> {
    const r = empty();
    const key = `npm:${dir}:${script}`;
    if (seen.has(key) || depth > MAX_DEPTH) return r;
    seen.add(key);
    const value = pkgByDir.get(dir)?.scripts?.[script];
    if (!value) {
      r.checkish = false;
      return r;
    }
    r.npmScripts.push(dir === "." ? script : `${dir}:${script}`);
    r.scriptValues.push(value);
    merge(r, await resolveRun(value, dir, depth + 1, seen));
    return r;
  }

  async function resolveCommand(cmd: string, cwd: string, depth: number, seen: Set<string>): Promise<Resolved> {
    const r = empty();
    const builtins = builtinChecks(cmd);
    if (builtins.length) {
      r.builtins.push(...builtins);
      r.checkish = builtins.every((b) => b.dedicated);
      return r;
    }
    if (TRIVIAL.test(cmd)) return r; // neutral
    const tokens = cmd.split(/\s+/);
    const tool = tokens[0]!;
    // npm / pnpm / yarn scripts, optionally in a workspace.
    if (/^(npm|pnpm|yarn)$/.test(tool)) {
      let dir = cwd;
      const ws = cmd.match(/(?:-w|--workspace|--filter|--prefix)[=\s]+(\S+)/);
      if (ws) dir = dirOfPkgName(ws[1]!) ?? (paths.has(toRepoPath(cwd, `${ws[1]}/package.json`)) ? toRepoPath(cwd, ws[1]!) : dir);
      const yarnWs = cmd.match(/^yarn\s+workspace\s+(\S+)\s+(?:run\s+)?([\w:.-]+)/);
      if (yarnWs) return resolveNpmScript(dirOfPkgName(yarnWs[1]!) ?? dir, yarnWs[2]!, depth, seen);
      const m = cmd.match(/^(?:npm|pnpm|yarn)\s+(?:(?:-\S+|--\S+)\s+)*(?:run(?:-script)?\s+(?:(?:-\S+)\s+\S+\s+)*([\w:.-]+)|(test|t|start)\b|([\w:.-]+))/);
      const script = m?.[1] ?? (m?.[2] === "t" ? "test" : m?.[2]) ?? (tool !== "npm" ? m?.[3] : undefined);
      if (script) return resolveNpmScript(dir, script, depth, seen);
      r.checkish = false;
      return r;
    }
    // Interpreters and direct execution of repository files.
    const fileToken = tokens.find((t, i) => (i > 0 || t.startsWith("./")) && SCRIPT_EXT.test(t.replace(/["']/g, "")) && paths.has(toRepoPath(cwd, t)));
    if (fileToken) return resolveFile(toRepoPath(cwd, fileToken), depth, seen);
    r.checkish = false; // build, test, anything else
    return r;
  }

  async function resolveRun(run: string, cwd: string, depth: number, seen: Set<string>): Promise<Resolved> {
    const r = empty();
    let any = false;
    for (const cmd of commandsOf(run)) {
      const c = await resolveCommand(cmd, cwd, depth, seen);
      if (TRIVIAL.test(cmd) && !c.builtins.length && !c.files.size) continue;
      any = true;
      merge(r, c);
    }
    if (!any) r.checkish = false;
    return r;
  }

  // ---------------------------------------------------------------------
  // Workflows
  // ---------------------------------------------------------------------
  const workflowPaths = files.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort();
  const workflows: Workflow[] = [];
  const checks: CiCheck[] = [];
  const referenced = new Set<string>();

  for (const path of workflowPaths) {
    const text = await read(path);
    if (text === null) continue;
    let wf: Workflow;
    try {
      wf = parseWorkflow(path, text);
    } catch (e) {
      warnings.push(`${path}: could not be parsed (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    workflows.push(wf);
    const lines = text.split("\n");
    const lineOf = (needle: string | null) => {
      if (!needle) return undefined;
      const i = lines.findIndex((l) => l.includes(needle));
      return i >= 0 ? i + 1 : undefined;
    };
    const usedIds = new Set<string>();
    for (const job of wf.jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const cwd = step.workingDirectory ? posix.normalize(step.workingDirectory).replace(/^\.\//, "") || "." : ".";
        const resolved = await resolveRun(step.run, cwd, 0, new Set());
        for (const f of resolved.files.keys()) referenced.add(f);
        const sourceText = [...resolved.files.values()].join("\n");
        const scriptSignals = signalsIn(`${sourceText}\n${resolved.scriptValues.join("\n")}`);
        const strong = hasStrongSignal(scriptSignals) && resolved.files.size > 0;
        if (!resolved.builtins.length && !strong) continue;

        let id = `${repository}:${path}#${job.id}/${slug(step.displayName)}`;
        if (usedIds.has(id)) id += `-${step.index}`;
        usedIds.add(id);
        checks.push(
          buildCheck({
            id,
            repository,
            name: step.name ?? stepLabel(step, resolved),
            wf,
            job,
            step,
            resolved,
            scriptSignals: strong ? scriptSignals : [],
            catalog: input.catalog,
            sources: [
              { path, url: blobUrl(path, lineOf(step.name ? `name: ${step.name}` : step.run.split("\n")[0]!.trim())) },
              ...[...resolved.files.keys()].map((f) => ({ path: f, url: blobUrl(f) })),
            ],
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Version-checking scripts that no workflow runs (local release gates)
  // ---------------------------------------------------------------------
  const candidates = files.paths
    .filter((p) => SCRIPT_EXT.test(p) && (SCRIPT_DIRS.test(p) || !p.includes("/")) && CANDIDATE_NAME.test(posix.basename(p)) && !/\.(test|spec)\.\w+$/.test(p))
    .filter((p) => !referenced.has(p))
    .sort()
    .slice(0, MAX_SCRIPTS);
  let scriptsInspected = referenced.size;
  for (const path of candidates) {
    const text = await read(path);
    scriptsInspected++;
    if (!text) continue;
    const signals = signalsIn(text);
    if (!hasStrongSignal(signals)) continue;
    const runners = [...pkgByDir.entries()].flatMap(([dir, pkg]) =>
      Object.entries(pkg.scripts ?? {})
        .filter(([, v]) => v.includes(posix.relative(dir, path)) || v.includes(path))
        .map(([k]) => (dir === "." ? `npm run ${k}` : `npm run ${k} (${dir})`)),
    );
    const resolved = await resolveFile(path, 0, new Set());
    checks.push(
      buildCheck({
        id: `${repository}:${path}`,
        repository,
        name: posix.basename(path),
        wf: null,
        job: null,
        step: null,
        resolved,
        scriptSignals: signalsIn([...resolved.files.values()].join("\n")),
        catalog: input.catalog,
        sources: [...resolved.files.keys()].map((f) => ({ path: f, url: blobUrl(f) })),
        note: `Not run by any workflow${runners.length ? `; run locally via ${runners.join(", ")}` : ""}. Its results are not observable here.`,
      }),
    );
  }

  return { workflows, checks: applyAnnotations(repository, checks, input.annotations, workflows, blobUrl), scriptsInspected, warnings };
}

function stepLabel(step: WorkflowStep, r: Resolved): string {
  if (r.npmScripts.length) return `npm run ${r.npmScripts[0]}`;
  const f = [...r.files.keys()][0];
  return f ? posix.basename(f) : step.displayName.replace(/^Run /, "");
}

function buildCheck(a: {
  id: string;
  repository: string;
  name: string;
  wf: Workflow | null;
  job: WorkflowJob | null;
  step: WorkflowStep | null;
  resolved: Resolved;
  scriptSignals: string[];
  catalog: { id: string; name: string }[];
  sources: { path: string; url: string }[];
  note?: string;
}): CiCheck {
  const { resolved, step, job, wf } = a;
  const sourceText = [...resolved.files.values()].join("\n");
  const allText = `${step?.run ?? ""}\n${resolved.scriptValues.join("\n")}\n${sourceText}`;
  const builtinTypes = resolved.builtins.flatMap((b) => b.types);
  const scriptTypes = a.scriptSignals.length ? typesFromSignals(a.scriptSignals, sourceText) : [];
  const types = [...new Set<CiCheckType>([...builtinTypes, ...scriptTypes])];
  const packages = packagesIn(allText, a.catalog);
  const assertions = assertionsIn(sourceText);
  const builtinConditions = [...new Set(resolved.builtins.map((b) => b.condition))];
  const confidence: CiCheck["confidence"] =
    a.scriptSignals.length === 0 && resolved.builtins.length > 0
      ? "identified"
      : scriptTypes.length > 0 && (packages.length > 0 || assertions.length > 0)
        ? "partially-understood"
        : "unclassified";

  // Blocking: does a failure of this step fail the workflow?
  let blocking = true;
  let blockingNote: string | null = null;
  const coe = step?.continueOnError ?? job?.continueOnError ?? null;
  if (coe === true || coe === "true") {
    blocking = false;
    blockingNote = "continue-on-error: failures do not fail the workflow";
  } else if (typeof coe === "string") {
    blockingNote = `continue-on-error is conditional (${coe})`;
  } else if (step?.run && /\|\|\s*(true|echo|:)/.test(step.run)) {
    blocking = false;
    blockingNote = "the command's failure is swallowed (|| true / || echo)";
  }
  if (!wf) {
    blocking = false;
    blockingNote = "runs outside CI";
  }

  // Environment settings the check reads; values like "report" may relax enforcement.
  const env = { ...(wf?.env ?? {}), ...(job?.env ?? {}), ...(step?.env ?? {}) };
  const modifiers = Object.entries(env)
    .filter(([k, v]) => sourceText.includes(k) && !/TOKEN|SECRET|PASSWORD|_KEY$/i.test(k) && !v.includes("secrets."))
    .map(([name, value]) => ({ name, value, relaxes: relaxes(value) }));
  if (modifiers.some((m) => m.relaxes)) {
    blockingNote = [blockingNote, `relaxed by ${modifiers.filter((m) => m.relaxes).map((m) => `${m.name}=${m.value}`).join(", ")}: part of the condition may only be reported`].filter(Boolean).join("; ");
  }

  // Dedicated: the step only runs checks, and the scripts it runs are named as checks. A scenario or test
  // suite that happens to query a registry is not a version check, so its failures are never pinned on a package.
  const dedicated =
    Boolean(step) &&
    resolved.checkish &&
    (resolved.builtins.some((b) => b.dedicated) ||
      (resolved.files.size > 0 && [...resolved.files.keys()].every((f) => CANDIDATE_NAME.test(posix.basename(f)) && !/scenario|e2e|test/i.test(posix.basename(f)))));
  return {
    id: a.id,
    repository: a.repository,
    name: a.name,
    workflow: wf?.path ?? null,
    workflowName: wf?.name ?? null,
    job: job?.id ?? null,
    jobName: job?.displayName ?? null,
    step: step?.displayName ?? null,
    types,
    packages,
    requirements: [],
    expectations: [],
    condition: builtinConditions.length && !a.scriptSignals.length ? builtinConditions.join("; ") : null,
    assertions: [...builtinConditions.filter(() => a.scriptSignals.length > 0), ...assertions].slice(0, 10),
    blocking,
    blockingNote,
    gates: wf?.triggers ?? [],
    modifiers,
    dedicated,
    confidence,
    signals: [...new Set([...resolved.builtins.map((b) => `builtin:${b.id}`), ...a.scriptSignals])],
    sources: a.sources,
    annotated: false,
    note: a.note ?? null,
    result: "unknown",
    resultNote: wf ? null : "Runs outside CI; no results to observe",
    lastRun: null,
    lastSuccess: null,
    lastFailure: null,
    jobUrl: null,
    failure: null,
    stale: false,
  };
}

function matches(check: CiCheck, m: CiAnnotation["match"]): boolean {
  if (m.repository !== check.repository) return false;
  if (m.script) return check.workflow === null && check.sources.some((s) => s.path === m.script);
  if (m.workflow && m.workflow !== check.workflow) return false;
  if (m.job && m.job !== check.job) return false;
  if (m.step && m.step !== check.step && m.step !== check.name) return false;
  return Boolean(m.workflow || m.job || m.step);
}

export function applyAnnotations(
  repository: string,
  checks: CiCheck[],
  annotations: CiAnnotation[],
  workflows: Workflow[],
  blobUrl: (path: string) => string,
): CiCheck[] {
  const out = [...checks];
  for (const a of annotations.filter((x) => x.match.repository === repository)) {
    const hits = out.filter((c) => matches(c, a.match));
    if (a.ignore) {
      for (const h of hits) out.splice(out.indexOf(h), 1);
      continue;
    }
    const apply = (c: CiCheck): CiCheck => ({
      ...c,
      name: a.name ?? c.name,
      types: a.types ?? c.types,
      packages: [...new Set([...(a.packages ?? c.packages), ...(a.requirements ?? []).map((r) => r.package)])].sort(),
      requirements: (a.requirements ?? []) as CiRequirement[],
      condition: a.condition ?? c.condition,
      confidence: "identified",
      annotated: true,
      note: [c.note, a.note].filter(Boolean).join(" ") || null,
    });
    if (hits.length) {
      for (const h of hits) out[out.indexOf(h)] = apply(h);
      continue;
    }
    // Declared by a human but not found by discovery: still catalogue it, clearly marked.
    const wf = workflows.find((w) => w.path === a.match.workflow);
    const job = wf?.jobs.find((j) => j.id === a.match.job);
    const step = job?.steps.find((s) => s.displayName === a.match.step);
    out.push(
      apply({
        id: a.match.script ? `${repository}:${a.match.script}` : `${repository}:${a.match.workflow ?? "?"}#${a.match.job ?? "?"}/${slug(a.match.step ?? "check")}`,
        repository,
        name: a.name ?? a.match.step ?? a.match.script ?? "annotated check",
        workflow: a.match.script ? null : (a.match.workflow ?? null),
        workflowName: wf?.name ?? null,
        job: a.match.job ?? null,
        jobName: job?.displayName ?? null,
        step: step?.displayName ?? a.match.step ?? null,
        types: [],
        packages: [],
        requirements: [],
        expectations: [],
        condition: null,
        assertions: [],
        blocking: !a.match.script,
        blockingNote: a.match.script ? "runs outside CI" : null,
        gates: wf?.triggers ?? [],
        modifiers: [],
        dedicated: false,
        confidence: "identified",
        signals: [],
        sources: [a.match.script ?? a.match.workflow].filter((p): p is string => Boolean(p)).map((p) => ({ path: p, url: blobUrl(p) })),
        annotated: true,
        note: `Declared in config/ci.json; discovery did not find it${wf ? "" : " (workflow not found at the scanned commit)"}.`,
        result: "unknown",
        resultNote: null,
        lastRun: null,
        lastSuccess: null,
        lastFailure: null,
        jobUrl: null,
        failure: null,
        stale: false,
      }),
    );
  }
  return out;
}
