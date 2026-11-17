/**
 * One application, both kinds of dependency, one activity timeline — computed on demand, stored nowhere.
 *
 * - Build time (what it is built from): packages from Maintenance's scan of its manifests; releases, approvals,
 *   downstream proposals and consumer observations from Maintenance's release records. Authority: the registries
 *   and git for facts, Maintenance for release governance.
 * - Run time (what it resolves while running): references from Resolver Control (read through its capabilities).
 *   Authority: Resolver for bindings and history, Resolver Control for change governance.
 *
 * The two identities are never merged: a package is `registry:name@version`, a runtime dependency is `ref://…`.
 * The only link is the application, by its Maintenance project id and the name it uses as a Resolver consumer.
 */
import type { Installation, ProjectConfig, ReleaseRecord } from "../contracts.ts";
import type { ResolverControl, RuntimeView } from "./resolver-control.ts";

export interface ActivityEntry {
  at: string;
  domain: "package" | "runtime";
  authority: "Boundry Maintenance" | "Resolver Control";
  subject: string;
  event: string;
  actor: string | null;
}
export interface ApplicationView {
  application: { id: string; name: string; repository: string; resolverApplication: string | null };
  readAt: string;
  buildTime: {
    authority: string;
    packages: {
      package: string; manifest: string; declared: string | null; resolved: string | null;
      releases: { id: string; version: string; state: string; proposedBy: string; approvals: { by: string; authentication: string }[]; releaseCommit: string | null; tag: string | null; integrity: string | null }[];
      downstream: ReleaseRecord["downstream"];
      observations: ReleaseRecord["consumers"];
    }[];
  };
  runtime: RuntimeView | { unavailable: string };
  activity: ActivityEntry[];
  unknowns: string[];
}

export async function applicationView(project: ProjectConfig, d: { installations: Installation[]; releases: ReleaseRecord[]; packageNames: Record<string, string>; resolverControl: ResolverControl | null; now?: () => string }): Promise<ApplicationView> {
  const readAt = (d.now ?? (() => new Date().toISOString()))();
  const unknowns: string[] = [];
  // Managed packages only (catalog ids): those are the ones Maintenance governs releases for.
  const mine = d.installations.filter((i): i is Installation & { package: string } => i.project === project.id && i.package !== null);
  if (!mine.length) unknowns.push("No package installations recorded for this application (run a scan).");
  const activity: ActivityEntry[] = [];
  const packages = mine.map((i) => {
    const name = d.packageNames[i.package] ?? i.name;
    const rel = d.releases.filter((r) => r.plan.packages.some((p) => p.package === i.package));
    for (const r of rel) {
      for (const h of r.history) activity.push({ at: h.at, domain: "package", authority: "Boundry Maintenance", subject: `release ${r.id}`, event: `${h.state}: ${h.note}`, actor: h.state === "proposed" ? r.plan.requestedBy : null });
      for (const a of r.approvals) activity.push({ at: a.at, domain: "package", authority: "Boundry Maintenance", subject: `release ${r.id}`, event: `approved (${a.authentication})`, actor: a.by });
    }
    const where = `${i.repository}:${i.manifest}`;
    return {
      package: name, manifest: where, declared: i.declaredVersion ?? null, resolved: i.resolvedVersion ?? null,
      releases: rel.map((r) => {
        const pp = r.plan.packages.find((p) => p.package === i.package)!;
        return {
          id: r.id, version: pp.proposedVersion, state: r.state, proposedBy: `${r.plan.requestedBy} (${r.plan.requestedByType})`,
          approvals: r.approvals.map((a) => ({ by: a.by, authentication: a.authentication })),
          releaseCommit: r.facts.releaseCommit, tag: r.facts.tags.find((t) => t.name === pp.tag)?.name ?? null,
          integrity: r.facts.registryVerification.find((v) => v.package === i.package)?.integrity ?? null,
        };
      }),
      downstream: rel.flatMap((r) => r.downstream.filter((x) => x.consumer === project.id && x.where === where)),
      observations: rel.flatMap((r) => r.consumers.filter((c) => c.consumer === project.id && c.where === where)),
    };
  });

  let runtime: ApplicationView["runtime"];
  if (!project.resolverApplication) { runtime = { unavailable: "no resolverApplication link in config/projects.json: this application's runtime dependencies are not known to Maintenance" }; unknowns.push("Runtime dependencies: no link to a Resolver consumer name."); }
  else if (!d.resolverControl) { runtime = { unavailable: "Resolver Control is not configured for this Maintenance (BOUNDRY_RESOLVER_CONTROL_URL)" }; unknowns.push("Runtime dependencies: Resolver Control not reachable from this Maintenance."); }
  else {
    try {
      runtime = await d.resolverControl.runtimeOf(project.resolverApplication);
      for (const r of runtime.references) for (const e of r.events) activity.push({ at: new Date(e.at).toISOString(), domain: "runtime", authority: "Resolver Control", subject: e.subjectId.startsWith("ref://") ? e.subjectId : `${r.ref} change ${e.subjectId}`, event: e.type, actor: e.actor });
      unknowns.push("Runtime: consumers that neither declared themselves nor resolved through a registered Resolver client are not visible.");
    } catch (e) { runtime = { unavailable: `Resolver Control did not answer: ${(e as Error).message}` }; unknowns.push("Runtime dependencies: Resolver Control did not answer; nothing is assumed."); }
  }
  activity.sort((a, b) => a.at.localeCompare(b.at));
  return {
    application: { id: project.id, name: project.name, repository: project.repository, resolverApplication: project.resolverApplication ?? null },
    readAt,
    buildTime: { authority: "registries and git (facts); Boundry Maintenance (release governance and evidence)", packages },
    runtime, activity, unknowns,
  };
}

export function renderApplicationView(v: ApplicationView): string {
  const L = [`# ${v.application.name}: what it is built from and what it resolves`, "", `Read at ${v.readAt}. Maintenance project \`${v.application.id}\` (${v.application.repository}); Resolver consumer name: ${v.application.resolverApplication ? `\`${v.application.resolverApplication}\`` : "not linked"}.`, ""];
  L.push("## Build time: packages", "", `Authority: ${v.buildTime.authority}.`, "");
  if (!v.buildTime.packages.length) L.push("- None recorded.");
  for (const p of v.buildTime.packages) {
    L.push(`- **${p.package}** in \`${p.manifest}\`: declares \`${p.declared ?? "?"}\`, lockfile resolves \`${p.resolved ?? "?"}\``);
    for (const r of p.releases) L.push(`  - release \`${r.id}\` → ${r.version}: **${r.state}**; proposed by ${r.proposedBy}; approved by ${r.approvals.map((a) => `${a.by} (${a.authentication})`).join(", ") || "nobody yet"}${r.releaseCommit ? `; commit \`${r.releaseCommit.slice(0, 12)}\`` : ""}${r.tag ? `, tag \`${r.tag}\`` : ""}${r.integrity ? `, registry integrity \`${r.integrity.slice(0, 22)}…\`` : ""}`);
    for (const x of p.downstream) L.push(`  - proposed for this application (needs its own plan): ${x.kind} \`${x.from}\` → \`${x.to}\``);
    for (const o of p.observations) L.push(`  - observed ${o.at}: installed \`${o.installation.declared}\` → \`${o.installation.resolved}\`; adoption **${o.adoption}**; verification **${o.verification}**${o.verificationEvidence ? ` (${o.verificationEvidence})` : ""}`);
  }
  L.push("", "## Run time: Resolver references", "");
  if ("unavailable" in v.runtime) L.push(`Unavailable: ${v.runtime.unavailable}.`);
  else {
    L.push(`Authority: ${v.runtime.authority}. Read from ${v.runtime.source} as \`${v.runtime.principal}\` at ${v.runtime.readAt} (a projection; never a basis for a write).`, "");
    for (const r of v.runtime.references) {
      L.push(`- **\`${r.ref}\`** (${r.kind ?? "?"}) at revision ${r.revision ?? "?"}: ${r.summary ?? ""} — owner ${r.owner ?? "?"}, criticality ${r.criticality ?? "?"}, change class ${r.changeClass ?? "?"}; known by: ${r.basis.join(" + ")}${r.usage ? ` (${r.usage})` : ""}`);
      for (const c of r.changes) L.push(`  - CHG-${c.number} ${c.operation}: **${c.status}**; proposed by ${c.proposedBy} (${c.proposedByType}); approvals ${c.approvals.map((a) => a.by).join(", ") || "none"} of ${c.requiredApprovals ?? "?"} required${c.verification ? `; verified ${c.verification.passed ? "✔" : "✘"} at revision ${c.verification.revision}` : ""}`);
    }
  }
  L.push("", "## Activity (both authorities, one timeline)", "", "| When | Domain | Authority | Subject | Event | Actor |", "|---|---|---|---|---|---|");
  for (const a of v.activity) L.push(`| ${a.at} | ${a.domain} | ${a.authority} | ${a.subject} | ${a.event.replace(/\|/g, "\\|").slice(0, 160)} | ${a.actor ?? ""} |`);
  if (v.unknowns.length) L.push("", "## Not known", "", ...v.unknowns.map((u) => `- ${u}`));
  return L.join("\n") + "\n";
}
