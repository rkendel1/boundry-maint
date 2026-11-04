/**
 * Maintenance lifecycle per (project, root, package):
 *
 *   update-available → update-required → update-in-progress → updated-unverified → updated-verified
 *
 * An available release is not maintenance; a version bump is not verification.
 * Items carry their own history; the previous data/maintenance.json is the state input.
 */
import type { Installation, MaintenanceEvent, MaintenanceItem, MaintenanceState, PackageRecord, Policies, EvidenceRecord } from "../contracts.ts";
import { installKey } from "./project.ts";

const OPEN_STATUSES = new Set(["patch-behind", "minor-behind", "major-behind", "prerelease", "deprecated", "yanked"]);

export const itemKey = (i: { project: string; root: string; registry: string; name: string }) => `${i.project}|${installKey(i.root, i.registry, i.name)}`;

const SEVERITY: Record<Installation["status"], number> = {
  yanked: 0,
  deprecated: 0,
  "major-behind": 1,
  "minor-behind": 2,
  "patch-behind": 3,
  prerelease: 4,
  unknown: 5,
  unavailable: 5,
  current: 6,
  local: 7,
};

/**
 * Installations that share a lockfile are one maintenance action (e.g. a single
 * `cargo update -p tokio` for a whole workspace), so they collapse into one item
 * represented by the most severe installation.
 */
export function groupInstallations(installations: Installation[]): (Installation & { roots: string[] })[] {
  const groups = new Map<string, Installation[]>();
  for (const i of installations) {
    if (!i.package) continue;
    const k = itemKey({ project: i.project, root: i.lockfile ?? i.root, registry: i.registry, name: i.name });
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  return [...groups.values()].map((g) => {
    const worst = [...g].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])[0]!;
    return {
      ...worst,
      root: worst.lockfile ?? worst.root,
      roots: [...new Set(g.map((i) => i.root))].sort(),
      stale: g.some((i) => i.stale),
      verification: g.every((i) => i.verification.verified) ? worst.verification : { verified: false, commit: null, evidenceAt: null },
    };
  });
}

function priorityOf(diff: MaintenanceItem["difference"]): number {
  switch (diff) {
    case "deprecated":
    case "yanked":
      return 0;
    case "major":
      return 1;
    case "minor":
      return 2;
    case "patch":
      return 3;
    case "prerelease":
      return 4;
    default:
      return 5;
  }
}

function differenceOf(status: Installation["status"]): MaintenanceItem["difference"] {
  switch (status) {
    case "patch-behind":
      return "patch";
    case "minor-behind":
      return "minor";
    case "major-behind":
      return "major";
    case "prerelease":
    case "deprecated":
    case "yanked":
      return status;
    default:
      return null;
  }
}

export function computeMaintenance(opts: {
  installations: Installation[];
  previous: MaintenanceItem[];
  packages: Map<string, PackageRecord>;
  evidence: Map<string, EvidenceRecord[]>;
  events: MaintenanceEvent[];
  policies: Policies;
  now: string;
  scanRun: string | null;
}): MaintenanceItem[] {
  const { now, policies } = opts;
  const prevByKey = new Map(opts.previous.map((i) => [i.key, i]));
  const out = new Map<string, MaintenanceItem>();

  const transition = (item: MaintenanceItem, status: MaintenanceState, version: string | null): MaintenanceItem => {
    if (item.status === status && item.history.at(-1)?.version === version) return item;
    return { ...item, status, updatedAt: now, history: [...item.history, { at: now, status, version, scanRun: opts.scanRun }] };
  };

  for (const inst of groupInstallations(opts.installations)) {
    if (!inst.package) continue;
    const key = itemKey(inst);
    const prev = prevByKey.get(key);
    if (inst.stale) {
      // Repository unreadable this run: keep the item exactly as last known.
      if (prev) out.set(key, prev);
      continue;
    }
    const pkg = opts.packages.get(inst.package);
    const ownership = pkg?.ownership ?? "managed";

    if (OPEN_STATUSES.has(inst.status)) {
      const difference = differenceOf(inst.status);
      const target = pkg?.latestVersion && inst.status !== "prerelease" ? pkg.latestVersion : (pkg?.latestPrerelease ?? inst.latestVersion);
      const required =
        difference === "deprecated" || difference === "yanked" || (difference !== null && difference !== "prerelease" && (policies.requireUpdate[ownership] ?? []).includes(difference));
      // A previously closed/updated item reopens when a newer release lands.
      const reopen = !prev || prev.status === "updated-verified" || prev.status === "updated-unverified";
      // An explicit "maintenance-started" signal for this target, sent after the current cycle began.
      const cycleStart = !prev ? "" : reopen ? prev.updatedAt : prev.openedAt;
      const started = opts.events.some(
        (e) => e.project === inst.project && e.package === inst.package && e.at >= cycleStart && (e.targetVersion === null || e.targetVersion === target),
      );
      const status: MaintenanceState = started ? "update-in-progress" : required ? "update-required" : "update-available";
      const baseItem: MaintenanceItem = reopen
        ? {
            key,
            project: inst.project,
            root: inst.root,
            roots: inst.roots,
            package: inst.package,
            name: inst.name,
            registry: inst.registry,
            ownership,
            currentVersion: inst.resolvedVersion,
            targetVersion: target,
            declaredVersion: inst.declaredVersion,
            difference,
            latestSatisfiesDeclared: inst.latestSatisfiesDeclared,
            status,
            priority: priorityOf(difference),
            targetPublishedAt: null,
            openedAt: now,
            updatedAt: now,
            closedAt: null,
            lastVerifiedCommit: prev?.lastVerifiedCommit ?? null,
            evidence: prev?.evidence ?? [],
            history: [...(prev?.history ?? []), { at: now, status, version: inst.resolvedVersion, scanRun: opts.scanRun }],
          }
        : prev!;
      const targetPublishedAt = pkg && target ? (pkg.latestVersion === target ? pkg.publishedAt : null) : null;
      out.set(
        key,
        transition(
          {
            ...baseItem,
            roots: inst.roots,
            ownership,
            currentVersion: inst.resolvedVersion,
            targetVersion: target,
            declaredVersion: inst.declaredVersion,
            difference,
            latestSatisfiesDeclared: inst.latestSatisfiesDeclared,
            priority: priorityOf(difference),
            targetPublishedAt,
            closedAt: null,
          },
          status,
          inst.resolvedVersion,
        ),
      );
      continue;
    }

    if (inst.status === "current" && prev) {
      // The update landed. Verified only with passing evidence that recorded this exact resolved version
      // for every affected manifest (computed per installation in status/project.ts).
      const verified = inst.verification.verified;
      if (prev.status === "updated-verified" && prev.currentVersion === inst.resolvedVersion) {
        // Closed; drop once past retention.
        const closedAt = prev.closedAt ?? now;
        const ageDays = (Date.parse(now) - Date.parse(closedAt)) / 86_400_000;
        if (ageDays <= policies.history.closedItemRetentionDays) out.set(key, prev);
        continue;
      }
      const latestRecord = verified ? (opts.evidence.get(inst.project) ?? []).find((r) => r.commit === inst.verification.commit) : undefined;
      const evidence = latestRecord
        ? [
            ...prev.evidence.filter((e) => e.commit !== latestRecord.commit),
            { commit: latestRecord.commit, at: latestRecord.collectedAt, runs: latestRecord.runs.map((r) => ({ workflow: r.workflow, url: r.url, conclusion: r.conclusion })) },
          ]
        : prev.evidence;
      const status: MaintenanceState = verified ? "updated-verified" : "updated-unverified";
      out.set(
        key,
        transition(
          {
            ...prev,
            roots: inst.roots,
            currentVersion: inst.resolvedVersion,
            declaredVersion: inst.declaredVersion,
            priority: 9,
            closedAt: verified ? now : null,
            lastVerifiedCommit: latestRecord?.commit ?? prev.lastVerifiedCommit,
            evidence,
          },
          status,
          inst.resolvedVersion,
        ),
      );
      continue;
    }
    // unknown / unavailable / local: cannot decide. Keep a prior item untouched rather than guessing.
    if (prev && (inst.status === "unknown" || inst.status === "unavailable")) out.set(key, prev);
  }

  return [...out.values()].sort(
    (a, b) =>
      a.priority - b.priority ||
      Number(b.status === "update-required") - Number(a.status === "update-required") ||
      a.project.localeCompare(b.project) ||
      a.name.localeCompare(b.name) ||
      a.root.localeCompare(b.root),
  );
}
