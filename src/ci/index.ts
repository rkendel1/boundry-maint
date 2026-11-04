/** CI enforcement monitoring: discovery + run collection per repository, with last-known data carried on failure. */
import type { CiAnnotation, CiCheck, CiFile, CiRepository, CiWorkflow, Policies, SourceError } from "../contracts.ts";
import type { GitHub } from "../collectors/github.ts";
import { errorMessage, HttpError, mapLimit } from "../lib/http.ts";
import type { RepoFiles } from "../scanners/common.ts";
import { discoverChecks } from "./discover.ts";
import { collectRuns } from "./runs.ts";

/** Where repository files come from (GitHub in production; local checkouts in development). */
export type CiFileSource = (repository: string) => Promise<{ files: RepoFiles; commit: string; defaultBranch: string; private: boolean | null }>;

export function githubCiSource(gh: GitHub): CiFileSource {
  return async (repository) => {
    const repo = await gh.repo(repository);
    const commit = await gh.branchHead(repository, repo.default_branch);
    const { paths } = await gh.tree(repository, commit);
    return { files: { paths, read: (p) => gh.raw(repository, p, commit) }, commit, defaultBranch: repo.default_branch, private: repo.private };
  };
}

export async function collectCi(opts: {
  repositories: string[];
  source: CiFileSource;
  github: GitHub | null;
  catalog: { id: string; name: string }[];
  annotations: CiAnnotation[];
  policies: Policies;
  previous: CiFile | null;
  now: string;
}): Promise<{ ci: CiFile; errors: SourceError[] }> {
  const errors: SourceError[] = [];
  const results = await mapLimit(opts.repositories, 3, async (repository) => {
    let repoRecord: CiRepository;
    let checks: CiCheck[] = [];
    let workflows: CiWorkflow[] = [];
    try {
      const src = await opts.source(repository);
      const found = await discoverChecks({ repository, commit: src.commit, files: src.files, catalog: opts.catalog, annotations: opts.annotations });
      for (const w of found.warnings) errors.push({ source: "ci", target: repository, message: w, at: opts.now });
      checks = found.checks;
      if (opts.github) {
        const runs = await collectRuns({
          gh: opts.github,
          repository,
          defaultBranch: src.defaultBranch,
          private: src.private,
          workflows: found.workflows,
          checks,
          catalog: opts.catalog,
          runsPerWorkflow: opts.policies.ci.runsPerWorkflow,
          collectLogs: opts.policies.ci.collectLogExcerpts,
        });
        checks = runs.checks;
        workflows = runs.workflows;
        for (const m of runs.errors) errors.push({ source: "ci", target: repository, message: m, at: opts.now });
      } else {
        workflows = found.workflows.map((w) => ({ repository, path: w.path, name: w.name, triggers: w.triggers, result: "unknown", latestRun: null, lastSuccess: null, lastFailure: null, failedJobs: [], branchFilter: null }));
        for (const c of checks) if (c.workflow) c.resultNote = "run results not collected (no GitHub access)";
      }
      repoRecord = {
        repository,
        commit: src.commit,
        defaultBranch: src.defaultBranch,
        private: src.private,
        status: "ok",
        error: null,
        workflowCount: found.workflows.length,
        scriptsInspected: found.scriptsInspected,
        lastScanned: opts.now,
      };
    } catch (e) {
      const message = errorMessage(e);
      const inaccessible = e instanceof HttpError && [401, 403, 404].includes(e.status);
      errors.push({ source: "ci", target: repository, message, at: opts.now });
      // Keep the last known inventory for this repository, marked stale; results are not refreshed.
      checks = (opts.previous?.checks ?? []).filter((c) => c.repository === repository).map((c) => ({ ...c, stale: true }));
      workflows = (opts.previous?.workflows ?? []).filter((w) => w.repository === repository);
      const prev = opts.previous?.repositories.find((r) => r.repository === repository);
      repoRecord = {
        repository,
        commit: prev?.commit ?? null,
        defaultBranch: prev?.defaultBranch ?? null,
        private: prev?.private ?? null,
        status: inaccessible ? "inaccessible" : "failed",
        error: inaccessible ? `${message} — the scan token cannot read this repository` : message,
        workflowCount: workflows.length,
        scriptsInspected: prev?.scriptsInspected ?? 0,
        lastScanned: opts.now,
      };
    }
    return { repoRecord, checks, workflows };
  });
  return {
    ci: {
      generatedAt: opts.now,
      repositories: results.map((r) => r.repoRecord),
      workflows: results.flatMap((r) => r.workflows),
      checks: results.flatMap((r) => r.checks),
    },
    errors,
  };
}
