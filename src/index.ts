#!/usr/bin/env node
/**
 * Boundry Maintenance CLI.
 *
 *   scan          collect registries + GitHub, scan projects, write data/
 *   report        build the Pages site (_site/) with badges from data/
 *   validate      validate config/ and any existing data/ artifacts
 *   schemas       regenerate schemas/*.json from src/contracts.ts
 *   record-event  append a repository_dispatch maintenance signal to data/events.json
 *   release       plan | show | approve | revoke | execute | list   (Release Manager; never runs during a scan)
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CiConfig,
  CiFile,
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
  ReleaseRecord,
  PrincipalCatalog,
} from "./contracts.ts";
import { releaseManager, approvalRequest } from "./release/cli.ts";
import { listFiles, readJsonIfValid, readJson, stableJson, writeAllAtomic } from "./lib/files.ts";
import { ResolverControl } from "./integrations/resolver-control.ts";
import { applicationView, renderApplicationView } from "./integrations/application-view.ts";
import { createMaintenanceApplication } from "./appport/application.ts";
import { serveMaintenance, parseTokens } from "./appport/serve.ts";
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
    package: { type: "string", multiple: true, default: [] },
    bump: { type: "string" },
    as: { type: "string" },
    digest: { type: "string" },
    signature: { type: "string" },
    reason: { type: "string" },
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
    ["ci.json", CiFile],
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
  await readJson(join(ROOT, "config/principals.json"), PrincipalCatalog);
  console.log("config/principals.json: ok");
  let releases = 0;
  for (const dir of await listFiles(d("release-manager"))) for (const f of await listFiles(dir)) { await readJson(f, ReleaseRecord); releases++; }
  console.log(`release records: ${releases} ok`);
  for (const f of (await listFiles(d("history"))).filter((f) => f.endsWith(".json"))) await readJson(f, Snapshot);
  console.log("evidence + history: ok");
}

async function schemas() {
  const out: [string, z.ZodType, "input" | "output"][] = [
    ["package.schema.json", PackageCatalog, "input"],
    ["project.schema.json", ProjectCatalog, "input"],
    ["policies.schema.json", Policies, "input"],
    ["ci.schema.json", CiConfig, "input"],
    ["principals.schema.json", PrincipalCatalog, "input"],
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

/** Release Manager. Explicit commands only: a scan never plans, approves or executes a release. */
async function release() {
  const [, sub, id] = positionals;
  const { packages } = await loadConfig(ROOT);
  const installations = (await readJsonIfValid(join(values.data!, "installations.json"), InstallationsFile))?.installations ?? [];
  const principals = (await readJson(join(ROOT, "config/principals.json"), PrincipalCatalog)).principals;
  const m = await releaseManager(ROOT, values.data!, packages.packages, installations, principals);
  const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`release ${sub} needs ${what}`); return v; };
  switch (sub) {
    case "plan": {
      const r = await m.plan({ packages: values.package!.length ? values.package! : [need(id, "--package <id>")], bump: need(values.bump, "--bump <patch|minor|major|prerelease|repository>") as never, requestedBy: need(values.as, "--as <your name>"), reason: values.reason });
      console.log(approvalRequest(r));
      return;
    }
    case "show": console.log(approvalRequest(await m.load(need(id, "<release id>")))); return;
    case "consumers": {
      const file = (await readJsonIfValid(join(values.data!, "installations.json"), InstallationsFile));
      const r = await m.observeConsumers(need(id, "<release id>"), file?.installations ?? [], `Maintenance scan at ${file?.generatedAt ?? "(no scan data)"}`);
      console.log(approvalRequest(r));
      return;
    }
    case "statement": process.stdout.write(await m.statement(need(id, "<release id>"), need(values.as, "--as <your principal id>"))); return;
    case "approve": { const r = await m.approve(need(id, "<release id>"), need(values.as, "--as <name>"), need(values.digest, "--digest <plan digest>"), values.signature ? await readFile(values.signature, "utf8") : undefined); console.log(`${r.id}: ${r.state} (${r.approvals.length} of ${r.plan.requiredApprovals} approvals: ${r.approvals.map((a) => a.by).join(", ")})`); return; }
    case "revoke": { const r = await m.revoke(need(id, "<release id>"), need(values.as, "--as <name>"), values.reason ?? "revoked"); console.log(`${r.id}: ${r.state}`); return; }
    case "execute": { const r = await m.execute(need(id, "<release id>"), need(values.as, "--as <principal id>")); console.log(approvalRequest(r)); if (r.state !== "released") process.exitCode = 1; return; }
    case "list": for (const r of await m.list()) console.log(`${r.id.padEnd(40)} ${r.state.padEnd(18)} ${r.failure ? `(${r.failure.recoverable ? "blocked" : "stopped"}: ${r.failure.reason})` : ""}`); return;
    default: throw new Error("usage: release plan --package <id> --bump <kind> --as <name> [--reason …] | show|list <id> | execute <id> --as <name> | statement <id> --as <name> | consumers <id> | approve <id> --as <name> --digest <d> [--signature <file.sig>] | revoke <id> --as <name> [--reason …]");
  }
}

/** Resolver Control, read through its AppPort capabilities as Maintenance's own principal there (optional). */
async function resolverControl(): Promise<ResolverControl | null> {
  const url = process.env.BOUNDRY_RESOLVER_CONTROL_URL, tokenFile = process.env.BOUNDRY_RESOLVER_CONTROL_TOKEN_FILE;
  if (!url || !tokenFile) return null;
  return new ResolverControl(url, (await readFile(tokenFile, "utf8")).trim(), process.env.BOUNDRY_RESOLVER_CONTROL_PRINCIPAL ?? "boundry-maintenance");
}
async function maintenanceDeps() {
  const { packages, projects } = await loadConfig(ROOT);
  const installations = (await readJsonIfValid(join(values.data!, "installations.json"), InstallationsFile))?.installations ?? [];
  const principals = (await readJson(join(ROOT, "config/principals.json"), PrincipalCatalog)).principals;
  const manager = await releaseManager(ROOT, values.data!, packages.packages, installations, principals);
  return { manager, principals, projects: projects.projects, installations: () => installations, packageNames: Object.fromEntries(packages.packages.map((p) => [p.id, p.name])), resolverControl: await resolverControl() };
}

/** One application: packages (Maintenance) and Resolver references (Resolver Control), one timeline. */
async function application() {
  const id = positionals[1];
  if (!id) throw new Error("usage: application <project id>");
  const d = await maintenanceDeps();
  const project = d.projects.find((p) => p.id === id);
  if (!project) throw new Error(`unknown project ${id}`);
  console.log(renderApplicationView(await applicationView(project, { installations: d.installations(), releases: await d.manager.list(), packageNames: d.packageNames, resolverControl: d.resolverControl })));
}

/** Serve Maintenance's AppPort application (HTTP /appport) and MCP (/mcp). Tokens: BOUNDRY_APPPORT_TOKENS_FILE. */
async function serve() {
  const d = await maintenanceDeps();
  const file = process.env.BOUNDRY_APPPORT_TOKENS_FILE;
  if (!file) throw new Error("serve needs BOUNDRY_APPPORT_TOKENS_FILE (lines: <sha256 of token> <principal id>)");
  const { url } = await serveMaintenance(createMaintenanceApplication(d), { tokens: parseTokens(await readFile(file, "utf8")), principals: d.principals, port: Number(process.env.BOUNDRY_APPPORT_PORT ?? 21300), host: process.env.BOUNDRY_APPPORT_HOST ?? "127.0.0.1" });
  console.log(`Boundry Maintenance: AppPort ${url}/appport, MCP ${url}/mcp`);
}

const commands: Record<string, () => Promise<void>> = { scan, report, validate, schemas, "record-event": recordEvent, release, application, serve };
const cmd = commands[positionals[0] ?? ""];
if (!cmd) {
  console.error(`usage: node src/index.ts <${Object.keys(commands).join("|")}> [--data dir] [--out dir] [--local owner/repo=path]`);
  process.exit(2);
}
cmd().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
