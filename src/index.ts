#!/usr/bin/env node
/**
 * Boundry Maintenance CLI.
 *
 *   scan          collect registries + GitHub, scan projects, write data/
 *   report        build the Pages site (_site/) with badges from data/
 *   validate      validate config/ and any existing data/ artifacts
 *   schemas       regenerate schemas/*.json from src/contracts.ts
 *   record-event  append a repository_dispatch maintenance signal to data/events.json
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  EventsFile,
  EvidenceFile,
  InstallationsFile,
  MaintenanceEvent,
  MaintenanceFile,
  PackageCatalog,
  PackagesFile,
  Policies,
  ProjectCatalog,
  ProjectsFile,
  ReleasesFile,
  Snapshot,
} from "./contracts.ts";
import { listFiles, readJsonIfValid, readJson, stableJson, writeAllAtomic } from "./lib/files.ts";
import { buildSite } from "./reports/generate.ts";
import { loadConfig, runScan } from "./scan.ts";

const ROOT = resolve(import.meta.dirname, "..");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: join(ROOT, "data") },
    out: { type: "string", default: join(ROOT, "_site") },
    local: { type: "string", multiple: true, default: [] },
    file: { type: "string" },
  },
});

async function scan() {
  const localRepos = new Map(
    (values.local ?? []).map((spec) => {
      const [repo, dir] = spec.split("=");
      if (!repo || !dir) throw new Error(`--local expects owner/repo=/path, got ${spec}`);
      return [repo, resolve(dir)] as const;
    }),
  );
  const env = process.env;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const token = env.MAINTENANCE_READ_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || null;
  if (!token) console.warn("warning: no GitHub token; unauthenticated API limits apply and private repositories cannot be read");
  const { summary, written } = await runScan({
    root: ROOT,
    dataDir: values.data!,
    githubToken: token,
    localRepos,
    run: { id: env.GITHUB_RUN_ID ?? null, url: runUrl, trigger: env.GITHUB_EVENT_NAME ?? "manual", configCommit: env.GITHUB_SHA ?? null },
  });
  const c = summary.counts;
  const lines = [
    `### Boundry Maintenance scan: ${summary.status}`,
    "",
    `- Packages: ${c.packages} (${c.packagesFailed} failed)`,
    `- Projects: ${c.projects} (${c.projectsFailed} failed or inaccessible)`,
    `- Managed installations: ${c.installations}`,
    `- Open maintenance items: ${c.maintenanceOpen}`,
    `- Data written: ${written ? "yes" : "no — previous successful data preserved"}`,
    ...(summary.errors.length ? ["", "#### Errors", ...summary.errors.map((e) => `- **${e.source}** \`${e.target}\`: ${e.message.replace(/\n/g, " ")}`)] : []),
  ];
  console.log(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (summary.status === "failed") process.exitCode = 1;
}

async function report() {
  const { policies } = await loadConfig(ROOT);
  const { files } = await buildSite({ root: ROOT, dataDir: values.data!, outDir: values.out!, policies });
  console.log(`site built in ${values.out} (${files} generated files)`);
}

async function validate() {
  await loadConfig(ROOT);
  console.log("config: ok");
  const d = (f: string) => join(values.data!, f);
  const checks: [string, z.ZodType][] = [
    ["packages.json", PackagesFile],
    ["releases.json", ReleasesFile],
    ["projects.json", ProjectsFile],
    ["installations.json", InstallationsFile],
    ["maintenance.json", MaintenanceFile],
    ["snapshot.json", Snapshot],
    ["events.json", EventsFile],
  ];
  for (const [f, schema] of checks) {
    try {
      await readJson(d(f), schema);
      console.log(`data/${f}: ok`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") console.log(`data/${f}: absent`);
      else throw e;
    }
  }
  for (const f of await listFiles(d("evidence"))) await readJson(f, EvidenceFile);
  for (const f of (await listFiles(d("history"))).filter((f) => f.endsWith(".json"))) await readJson(f, Snapshot);
  console.log("evidence + history: ok");
}

async function schemas() {
  const out: [string, z.ZodType, "input" | "output"][] = [
    ["package.schema.json", PackageCatalog, "input"],
    ["project.schema.json", ProjectCatalog, "input"],
    ["policies.schema.json", Policies, "input"],
    ["snapshot.schema.json", Snapshot, "output"],
  ];
  for (const [file, schema, io] of out) {
    const json = z.toJSONSchema(schema, { io, unrepresentable: "any" });
    await writeFile(join(ROOT, "schemas", file), stableJson(json));
    console.log(`schemas/${file}`);
  }
}

/** Ingest a repository_dispatch payload: { project, package, targetVersion?, ref? }. */
async function recordEvent() {
  if (!values.file) throw new Error("record-event requires --file <github event json>");
  const event = JSON.parse(await readFile(values.file, "utf8")) as { action?: string; client_payload?: Record<string, unknown>; sender?: { login?: string } };
  if (event.action !== "maintenance-started") {
    console.log(`event ${event.action ?? "(none)"} carries no maintenance signal; nothing recorded`);
    return;
  }
  const { packages, projects } = await loadConfig(ROOT);
  const p = event.client_payload ?? {};
  const record = MaintenanceEvent.parse({
    type: "maintenance-started",
    project: p.project,
    package: p.package,
    targetVersion: p.targetVersion ?? null,
    ref: p.ref ?? null,
    at: new Date().toISOString(),
    sender: event.sender?.login ?? null,
  });
  if (!projects.projects.some((x) => x.id === record.project)) throw new Error(`unknown project ${record.project}`);
  if (!packages.packages.some((x) => x.id === record.package)) throw new Error(`unknown package ${record.package}`);
  const path = join(values.data!, "events.json");
  const existing = (await readJsonIfValid(path, EventsFile))?.events ?? [];
  await writeAllAtomic({ [path]: { events: [...existing, record] } });
  console.log(`recorded maintenance-started for ${record.project} / ${record.package}`);
}

const commands: Record<string, () => Promise<void>> = { scan, report, validate, schemas, "record-event": recordEvent };
const cmd = commands[positionals[0] ?? ""];
if (!cmd) {
  console.error(`usage: node src/index.ts <${Object.keys(commands).join("|")}> [--data dir] [--out dir] [--local owner/repo=path]`);
  process.exit(2);
}
cmd().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
