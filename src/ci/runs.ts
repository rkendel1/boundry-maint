/**
 * CI status collection from GitHub's own execution data (workflow runs → jobs →
 * steps). Nothing is re-run or simulated: a check's result is the conclusion
 * GitHub recorded for its step.
 */
import type { CiCheck, CiResult, CiRunRef, CiWorkflow } from "../contracts.ts";
import type { GitHub, WorkflowJob as ApiJob, WorkflowRun } from "../collectors/github.ts";
import { errorMessage } from "../lib/http.ts";
import { packagesIn } from "./signals.ts";
import { templateToRegExp, type Workflow } from "./workflow.ts";

export function runResult(status: string, conclusion: string | null): CiResult {
  if (status !== "completed") return "in-progress";
  switch (conclusion) {
    case "success":
      return "passing";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failing";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

const isFailure = (c: string | null) => c === "failure" || c === "timed_out" || c === "startup_failure";

function ref(run: WorkflowRun): CiRunRef {
  return { runId: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion, branch: run.head_branch, sha: run.head_sha, event: run.event, at: run.updated_at ?? run.created_at };
}

interface StepOutcome {
  result: CiResult;
  job: ApiJob;
  note: string | null;
}

/** The outcome of one check in one run, aggregated across matrix jobs. */
export function stepOutcome(check: CiCheck, wf: Workflow, jobs: ApiJob[]): { result: CiResult; note: string | null; jobs: StepOutcome[] } {
  const job = wf.jobs.find((j) => j.id === check.job);
  if (!job) return { result: "unknown", note: "job not found in the workflow file", jobs: [] };
  const matched = jobs.filter((j) => job.namePattern.test(j.name));
  if (!matched.length) return { result: "unknown", note: `job "${job.displayName}" did not appear in the run (renamed, or never scheduled)`, jobs: [] };
  const stepPattern = check.step ? templateToRegExp(check.step) : null;
  const outcomes: StepOutcome[] = matched.map((j) => {
    if (j.status !== "completed") return { result: "in-progress", job: j, note: null };
    if (j.conclusion === "skipped") return { result: "skipped", job: j, note: "job skipped" };
    const st = j.steps?.find((s) => s.name === check.step || (stepPattern?.test(s.name) ?? false));
    if (!st) return { result: "unknown", job: j, note: "step not found in the job's results" };
    const r = runResult(st.status, st.conclusion);
    const note = r === "skipped" && isFailure(j.conclusion) ? "skipped because an earlier step in the job failed" : null;
    return { result: r, job: j, note };
  });
  const has = (r: CiResult) => outcomes.some((o) => o.result === r);
  const result: CiResult = has("failing") ? "failing" : has("in-progress") ? "in-progress" : has("passing") ? "passing" : has("cancelled") ? "cancelled" : has("skipped") ? "skipped" : "unknown";
  const note = outcomes.find((o) => o.result === result)?.note ?? null;
  return { result, note: matched.length > 1 && result !== "unknown" ? [note, `${matched.length} matrix jobs`].filter(Boolean).join("; ") : note, jobs: outcomes };
}

/** Lines from a job log that name catalog packages next to version words. */
export function logExcerpt(log: string, catalog: { id: string; name: string }[], limit = 12): { lines: string[]; packages: string[] } {
  const lines: string[] = [];
  const pkgs = new Set<string>();
  for (const raw of log.split("\n")) {
    const line = raw.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!line || line.startsWith("##[group]") || line.startsWith("##[endgroup]")) continue;
    if (!/version|latest|outdated|expected|requires?|must|mismatch|out of sync|not published|integrity|ERESOLVE|peer|lock/i.test(line)) continue;
    // Quote "name@1.2.3" so unscoped names are recognised; scoped names match on their own (whole-name only).
    const here = packagesIn(line.replace(/(@?[\w./-]+)@(\d)/g, "'$1'@$2"), catalog);
    if (!here.length) continue;
    here.forEach((p) => pkgs.add(p));
    if (lines.length < limit) lines.push(line.slice(0, 300));
  }
  return { lines, packages: [...pkgs].sort() };
}

export interface RunCollection {
  workflows: CiWorkflow[];
  checks: CiCheck[];
  errors: string[];
}

export async function collectRuns(opts: {
  gh: GitHub;
  repository: string;
  defaultBranch: string;
  /** null = unknown, treated as private. */
  private: boolean | null;
  workflows: Workflow[];
  checks: CiCheck[];
  catalog: { id: string; name: string }[];
  runsPerWorkflow: number;
  collectLogs: "none" | "public" | "all";
}): Promise<RunCollection> {
  const { gh, repository } = opts;
  const errors: string[] = [];
  const outWorkflows: CiWorkflow[] = [];
  const checks = opts.checks.map((c) => ({ ...c }));
  const logs = new Map<number, Promise<string | null>>();
  const readLog = (jobId: number) => {
    let l = logs.get(jobId);
    if (!l) {
      l = gh.jobLog(repository, jobId).catch((e) => {
        errors.push(`log for job ${jobId}: ${errorMessage(e)}`);
        return null;
      });
      logs.set(jobId, l);
    }
    return l;
  };
  const logsAllowed = opts.collectLogs === "all" || (opts.collectLogs === "public" && opts.private === false);

  for (const wf of opts.workflows) {
    const branchFilter = wf.runsOnBranches ? opts.defaultBranch : null;
    let runs: WorkflowRun[];
    try {
      runs = (await gh.workflowRuns(repository, wf.path, branchFilter, opts.runsPerWorkflow)).filter(
        (r) => branchFilter !== null || (r.event !== "pull_request" && r.event !== "pull_request_target"),
      );
    } catch (e) {
      errors.push(`${wf.path}: ${errorMessage(e)}`);
      outWorkflows.push({ repository, path: wf.path, name: wf.name, triggers: wf.triggers, result: "unknown", latestRun: null, lastSuccess: null, lastFailure: null, failedJobs: [], branchFilter });
      continue;
    }
    const latest = runs[0] ?? null;
    const lastSuccess = runs.find((r) => r.conclusion === "success") ?? null;
    const lastFailure = runs.find((r) => isFailure(r.conclusion)) ?? null;
    let latestJobs: ApiJob[] = [];
    let failureJobs: ApiJob[] = [];
    try {
      if (latest) latestJobs = await gh.runJobs(repository, latest.id);
      if (lastFailure && lastFailure.id !== latest?.id) failureJobs = await gh.runJobs(repository, lastFailure.id);
      else if (lastFailure) failureJobs = latestJobs;
    } catch (e) {
      errors.push(`${wf.path} jobs: ${errorMessage(e)}`);
    }
    outWorkflows.push({
      repository,
      path: wf.path,
      name: wf.name,
      triggers: wf.triggers,
      result: latest ? runResult(latest.status, latest.conclusion) : "unknown",
      latestRun: latest ? ref(latest) : null,
      lastSuccess: lastSuccess ? ref(lastSuccess) : null,
      lastFailure: lastFailure ? ref(lastFailure) : null,
      failedJobs: latestJobs
        .filter((j) => isFailure(j.conclusion))
        .map((j) => ({ name: j.name, url: j.html_url, failedSteps: (j.steps ?? []).filter((s) => isFailure(s.conclusion)).map((s) => s.name) })),
      branchFilter,
    });

    for (const check of checks.filter((c) => c.workflow === wf.path)) {
      if (!latest) {
        check.result = "unknown";
        check.resultNote = branchFilter ? `no runs on ${branchFilter}` : "no runs";
        continue;
      }
      const now = stepOutcome(check, wf, latestJobs);
      check.result = now.result;
      check.resultNote = now.note;
      check.lastRun = ref(latest);
      const failedJob = now.jobs.find((o) => o.result === "failing")?.job;
      check.jobUrl = (failedJob ?? now.jobs[0]?.job)?.html_url ?? null;
      check.lastSuccess = now.result === "passing" ? ref(latest) : lastSuccess ? ref(lastSuccess) : null;
      if (now.result === "failing") check.lastFailure = ref(latest);
      else if (lastFailure && failureJobs.length && stepOutcome(check, wf, failureJobs).result === "failing") check.lastFailure = ref(lastFailure);

      if (now.result === "failing" && failedJob) {
        // Attribution: only a dedicated check step, or a log that names the package, ties the failure to a package.
        let excerpt: { lines: string[]; packages: string[] } = { lines: [], packages: [] };
        if (logsAllowed) {
          const log = await readLog(failedJob.id);
          if (log) excerpt = logExcerpt(log, opts.catalog);
        }
        const fromLog = check.packages.length ? excerpt.packages.filter((p) => check.packages.includes(p)) : excerpt.packages;
        const confirmed = check.dedicated || fromLog.length > 0;
        check.failure = {
          attribution: confirmed ? "confirmed" : "possible",
          packages: fromLog.length ? fromLog : check.dedicated ? check.packages : [],
          excerpt: excerpt.lines,
        };
      }
    }
  }
  return { workflows: outWorkflows, checks, errors };
}
