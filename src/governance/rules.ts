/**
 * Governance rules shared by every Boundry Maintenance operation. Deterministic, no I/O, no model.
 *
 * The vocabulary and rules are Resolver Control's (rkendel1/resolver-control feltkit/app.ts roles,
 * feltkit/_rules.ts requiredApprovals, feltkit/changes.ts approve), applied to a different subject. They are
 * not a second governance model: when Maintenance runs as a FeltKit application, these become its
 * capability `access` declarations and handler checks (docs/architecture/control-plane.md).
 *
 * Recommendations are not execution. Proposals are not approvals. Approvals are not execution.
 */
import type { Principal, Role, Criticality } from "../contracts.ts";

/** Permissions per role. Same role names as Resolver Control; Maintenance's own permission names. */
const READ = ["catalog.read", "releases.read"] as const;
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  viewer: READ,
  engineer: [...READ, "releases.propose", "releases.withdraw"],
  approver: [...READ, "releases.approve"],
  prod_approver: [...READ, "releases.approve", "releases.approve.protected"],
  admin: [...READ, "catalog.write", "releases.trigger"],
  // Agents inspect and propose. Never approve, never execute (and the approval rule refuses non-people anyway).
  agent: [...READ, "releases.propose"],
  // The release executor: performs approved plans. It cannot propose or approve.
  executor: ["catalog.read", "releases.read", "releases.execute"],
};

/**
 * Every meaningful operation, as one table. A binding (the CLI today, AppPort/MCP later) looks the operation up
 * here and authorizes before the handler runs. `effect` is what the operation may do to the world.
 */
export const CAPABILITIES = {
  "maintenance.scan": { permission: null, effect: "observe", description: "Observe registries, repositories and CI; write the generated data/ projection. Never mutates an external system." },
  "releases.list": { permission: "releases.read", effect: "read", description: "Release records and their states." },
  "releases.inspect": { permission: "releases.read", effect: "read", description: "One release: plan, impact, approvals, evidence." },
  "releases.propose": { permission: "releases.propose", effect: "propose", description: "Plan a release (versions, commit, tags, destination, impact). Changes nothing outside this record." },
  "releases.approve": { permission: "releases.approve", effect: "approve", description: "Approve one exact plan by its digest. Only a person, never the proposer, never twice." },
  "releases.withdraw": { permission: null, effect: "cancel", description: "Withdraw (proposer) or reject (an approver) a release before publication." },
  "releases.execute": { permission: "releases.trigger", effect: "execute", description: "Ask the release executor to carry out an approved plan. Nothing unapproved runs." },
} as const satisfies Record<string, { permission: string | null; effect: string; description: string }>;
export type CapabilityName = keyof typeof CAPABILITIES;

export class GovernanceError extends Error {
  readonly code: "forbidden" | "failed-precondition";
  constructor(code: GovernanceError["code"], message: string) { super(message); this.code = code; }
}

export function permissionsOf(p: Principal): Set<string> {
  return new Set(p.roles.flatMap((r) => ROLE_PERMISSIONS[r]));
}
export const has = (p: Principal, permission: string) => permissionsOf(p).has(permission);

export function principal(catalog: readonly Principal[], id: string): Principal {
  const p = catalog.find((x) => x.id === id);
  if (!p) throw new GovernanceError("forbidden", `unknown principal "${id}": principals are declared in config/principals.json`);
  return p;
}

/** Authorize before the handler runs. Handler-level rules (person-only, not the proposer) are checked after. */
export function authorize(p: Principal, capability: CapabilityName): void {
  const need = CAPABILITIES[capability].permission;
  if (need && !has(p, need)) throw new GovernanceError("forbidden", `${p.id} (${p.type}; roles ${p.roles.join(", ")}) may not ${capability}: needs ${need}`);
}

/** Resolver Control's rule: at least the policy's count, and two distinct people for anything critical. */
export function requiredApprovals(policyCount: number, criticality: Criticality): number {
  return Math.max(policyCount, criticality === "critical" ? 2 : 1);
}

export interface ApprovalSubject {
  id: string;
  proposedBy: string;
  approvals: readonly { by: string }[];
  protected: boolean;
  frozen: string | null; // reason, if frozen
  eligible?: readonly string[]; // optional allowlist of approvers
}

/** Resolver Control's approval preconditions (feltkit/changes.ts approve), in the same order. */
export function checkApproval(p: Principal, s: ApprovalSubject): void {
  if (p.type !== "person") throw new GovernanceError("forbidden", `only a person may approve; ${p.id} is ${p.type === "agent" ? "an agent" : "a component"}`);
  authorize(p, "releases.approve");
  if (s.proposedBy === p.id) throw new GovernanceError("forbidden", `${p.id} proposed ${s.id} and may not approve it`);
  if (s.approvals.some((a) => a.by === p.id)) throw new GovernanceError("failed-precondition", `${p.id} already approved ${s.id}; another person must`);
  if (s.protected && !has(p, "releases.approve.protected")) throw new GovernanceError("forbidden", `${s.id} is protected: approving needs the prod_approver role`);
  if (s.frozen !== null) throw new GovernanceError("failed-precondition", `${s.id} is frozen: ${s.frozen}`);
  if (s.eligible && !s.eligible.includes(p.id)) throw new GovernanceError("forbidden", `${p.id} is not an approver for ${s.id} (approvers: ${s.eligible.join(", ")})`);
}
