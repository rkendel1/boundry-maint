/** GitHub Actions workflow files: just enough structure to locate checks and match them to run results. */
import YAML from "yaml";

export interface WorkflowStep {
  index: number;
  /** Name GitHub shows for the step in run results. */
  displayName: string;
  name: string | null;
  run: string | null;
  uses: string | null;
  env: Record<string, string>;
  continueOnError: string | boolean | null;
  workingDirectory: string | null;
  condition: string | null;
}

export interface WorkflowJob {
  id: string;
  name: string | null;
  /** Matches the job name(s) GitHub reports for runs, including matrix expansions. */
  namePattern: RegExp;
  displayName: string;
  env: Record<string, string>;
  continueOnError: string | boolean | null;
  uses: string | null;
  steps: WorkflowStep[];
}

export interface Workflow {
  path: string;
  name: string;
  triggers: string[];
  /** True when the workflow runs on pushes to branches or on a schedule, so default-branch runs are meaningful. */
  runsOnBranches: boolean;
  env: Record<string, string>;
  jobs: WorkflowJob[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null);
const envOf = (v: unknown): Record<string, string> =>
  typeof v === "object" && v && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x) ?? ""])) : {};

/** `${{ ... }}` expressions become wildcards; everything else is literal. */
export function templateToRegExp(template: string): RegExp {
  const parts = template.split(/\$\{\{[^}]*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`);
}

export function stepDisplayName(step: { name?: unknown; run?: unknown; uses?: unknown }, index: number): string {
  const name = str(step.name);
  if (name) return name;
  const run = str(step.run);
  if (run) return `Run ${run.trim().split("\n")[0]!.trim()}`;
  const uses = str(step.uses);
  if (uses) return `Run ${uses}`;
  return `Step ${index + 1}`;
}

/** Human-readable gates from the `on:` block. */
export function triggersOf(on: unknown): { triggers: string[]; runsOnBranches: boolean } {
  const triggers: string[] = [];
  let runsOnBranches = false;
  const add = (event: string, cfg: unknown) => {
    const c = (typeof cfg === "object" && cfg) || {};
    const branches = (c as Record<string, unknown>).branches;
    const tags = (c as Record<string, unknown>).tags;
    switch (event) {
      case "pull_request":
      case "pull_request_target":
        triggers.push(`pull requests${Array.isArray(branches) ? ` to ${branches.join(", ")}` : ""}`);
        break;
      case "push":
        if (Array.isArray(tags) && !Array.isArray(branches)) triggers.push(`tags ${tags.join(", ")}`);
        else {
          runsOnBranches = true;
          triggers.push(`pushes${Array.isArray(branches) ? ` to ${branches.join(", ")}` : ""}`);
          if (Array.isArray(tags)) triggers.push(`tags ${tags.join(", ")}`);
        }
        break;
      case "schedule":
        runsOnBranches = true;
        triggers.push("schedule");
        break;
      case "release":
        triggers.push("releases");
        break;
      case "workflow_dispatch":
        triggers.push("manual");
        break;
      case "workflow_call":
        triggers.push("called by other workflows");
        break;
      case "merge_group":
        triggers.push("merge queue");
        break;
      default:
        triggers.push(event);
    }
  };
  if (typeof on === "string") add(on, null);
  else if (Array.isArray(on)) on.forEach((e) => add(String(e), null));
  else if (on && typeof on === "object") for (const [e, cfg] of Object.entries(on)) add(e, cfg);
  return { triggers, runsOnBranches };
}

export function parseWorkflow(path: string, text: string): Workflow {
  const doc = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  const { triggers, runsOnBranches } = triggersOf(doc.on ?? doc.true);
  const jobsRaw = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
  const jobs: WorkflowJob[] = Object.entries(jobsRaw).map(([id, j]) => {
    const name = str(j?.name);
    const hasMatrix = Boolean((j?.strategy as Record<string, unknown> | undefined)?.matrix);
    const namePattern = name ? templateToRegExp(name) : hasMatrix ? new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(.*\\))?$`) : templateToRegExp(id);
    const stepsRaw = Array.isArray(j?.steps) ? (j.steps as Record<string, unknown>[]) : [];
    return {
      id,
      name,
      namePattern,
      displayName: name ?? id,
      env: envOf(j?.env),
      continueOnError: (j?.["continue-on-error"] as string | boolean | undefined) ?? null,
      uses: str(j?.uses),
      steps: stepsRaw.map((st, index) => ({
        index,
        displayName: stepDisplayName(st, index),
        name: str(st.name),
        run: str(st.run),
        uses: str(st.uses),
        env: envOf(st.env),
        continueOnError: (st["continue-on-error"] as string | boolean | undefined) ?? null,
        workingDirectory: str(st["working-directory"]) ?? str(((j?.defaults as Record<string, Record<string, unknown>> | undefined)?.run ?? {})["working-directory"]),
        condition: str(st.if),
      })),
    };
  });
  return { path, name: str(doc.name) ?? path.split("/").pop()!, triggers, runsOnBranches, env: envOf(doc.env), jobs };
}
