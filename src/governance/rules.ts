/**
 * Boundry governance contract v1 (contracts/governance/v1), enforced for releases.
 *
 * The role → effect table is read from contract.json, not copied; decide() implements SPEC.md and is checked
 * against vectors.json (test/governance-contract.test.ts). The Release Manager makes every authorization
 * decision through decide(): propose, approve, withdraw, trigger, and the executor's own check at the start of
 * execution. Deterministic, no I/O beyond loading the contract, no model.
 *
 * Recommendations are not execution. Proposals are not approvals. Approvals are not execution.
 */
import { readFileSync } from "node:fs";
import type { Principal, Criticality } from "../contracts.ts";

const CONTRACT_URL = new URL("../../contracts/governance/v1/contract.json", import.meta.url);
export const CONTRACT = JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as {
  id: string; version: string;
  roles: Record<string, { principalTypes: string[]; effects: string[] }>;
  authentication: { levels: string[]; productionRequires: string[] };
  defaultPolicy: { protected: boolean; approvalsRequired: number; frozen: boolean };
};
export const CONTRACT_VERSION = `${CONTRACT.id}@${CONTRACT.version}`;

export type Effect = "read" | "observe" | "propose" | "approve" | "approve.protected" | "withdraw" | "administer" | "trigger" | "execute" | "sign";

/** Maintenance's operations and the effect each declares (contract §2). Any binding authorizes through this. */
export const CAPABILITIES = {
  "maintenance.scan": { effect: "observe", description: "Observe registries, repositories and CI; write the generated data/ projection. Never mutates an external system." },
  "releases.list": { effect: "read", description: "Release records and their states." },
  "releases.inspect": { effect: "read", description: "One release: plan, impact, approvals, evidence." },
  "releases.propose": { effect: "propose", description: "Plan a release (versions, commit, tags, destination, impact). Changes nothing outside this record." },
  "releases.approve": { effect: "approve", description: "Approve one exact plan by its digest. Only a person, never the proposer, never twice." },
  "releases.withdraw": { effect: "withdraw", description: "Withdraw (proposer) or reject (an approver) a release before its first irreversible step." },
  "releases.trigger": { effect: "trigger", description: "Ask the release executor to carry out an approved plan. Grants no authority over what runs." },
  "releases.execute": { effect: "execute", description: "The release executor (a component) performs the approved plan." },
} as const satisfies Record<string, { effect: Effect; description: string }>;
export type CapabilityName = keyof typeof CAPABILITIES;

export type Code = "unknown-principal" | "forbidden-effect" | "person-only" | "proposer-cannot-approve" | "already-approved" | "protected-scope" | "frozen" | "not-eligible" | "wrong-state" | "digest-mismatch" | "insufficient-approvals" | "revoked" | "unauthenticated-for-production" | "irreversible";

export class GovernanceError extends Error {
  readonly code: Code; readonly result?: string;
  constructor(code: Code, message: string, result?: string) { super(message); this.code = code; if (result) this.result = result; }
}

export function effectsOf(p: Pick<Principal, "type" | "roles">): Set<string> {
  // A role only counts for the principal types the contract allows it (the catalog also refuses violations).
  return new Set(p.roles.flatMap((r) => (CONTRACT.roles[r]?.principalTypes.includes(p.type) ? CONTRACT.roles[r]!.effects : [])));
}
export const can = (p: Pick<Principal, "type" | "roles">, e: Effect) => effectsOf(p).has(e);

export function principal(catalog: readonly Principal[], id: string): Principal {
  const p = catalog.find((x) => x.id === id);
  if (!p) throw new GovernanceError("unknown-principal", `unknown principal "${id}": principals are declared in config/principals.json`);
  return p;
}

export function authorize(p: Principal, capability: CapabilityName): void {
  const e = CAPABILITIES[capability].effect;
  if (!can(p, e)) throw new GovernanceError("forbidden-effect", `${p.id} (${p.type}; roles ${p.roles.join(", ")}) may not ${capability}: needs the "${e}" effect`);
}

/** Contract §4. */
export function requiredApprovals(policyCount: number, criticality: Criticality | string): number {
  return Math.max(policyCount, criticality === "critical" ? 2 : 1);
}

// ───────── decide(): contract SPEC.md §3–§8, the function the vectors test ─────────

export interface Approval { by: string; principalType: string; authentication: string; digest: string }
export interface Subject {
  state: string;
  proposedBy: string;
  digest: string;
  criticality: string;
  policy: { approvalsRequired: number; protected: boolean; frozen: boolean; freezeReason?: string };
  production: boolean;
  approvals: Approval[];
  revoked: boolean;
  irreversible?: boolean;
  eligible?: string[];
  /** The threshold recorded when the subject was proposed (contract §4 ratchet). */
  requiredAtProposal?: number;
}
export type Operation = "propose" | "approve" | "withdraw" | "trigger" | "execute";
export type Decision = { allow: true; result?: "approved" | "awaiting-approval" } | { allow: false; code: Code; message: string; result?: "wait" | "awaiting-approval" };

const no = (code: Code, message: string, result?: "wait" | "awaiting-approval"): Decision => (result ? { allow: false, code, message, result } : { allow: false, code, message });

/** The approvals that count (§3.4), and whether they meet the current threshold. */
export function counted(s: Subject): { valid: Approval[]; required: number } {
  const seen = new Set<string>();
  const valid = s.approvals.filter((a) => a.principalType === "person" && a.by !== s.proposedBy && a.digest === s.digest && !seen.has(a.by) && seen.add(a.by));
  return { valid, required: Math.max(s.requiredAtProposal ?? 1, requiredApprovals(s.policy.approvalsRequired, s.criticality)) };
}

export function decide(op: Operation, p: Principal | null, s?: Subject, digest?: string): Decision {
  if (!p) return no("unknown-principal", "unknown principal");
  const who = `${p.id} (${p.type}; roles ${p.roles.join(", ")})`;
  switch (op) {
    case "propose":
      return can(p, "propose") ? { allow: true } : no("forbidden-effect", `${who} may not propose: needs the "propose" effect`);
    case "approve": {
      if (!s) throw new Error("approve needs a subject");
      if (p.type !== "person") return no("person-only", `only a person may approve; ${p.id} is ${p.type === "agent" ? "an agent" : "a component"}`);
      if (!can(p, "approve")) return no("forbidden-effect", `${who} may not approve: needs the "approve" effect`);
      if (s.state !== "awaiting-approval") return no("wrong-state", `it is ${s.state}, not awaiting approval`);
      if (s.proposedBy === p.id) return no("proposer-cannot-approve", `${p.id} proposed it and may not approve it`);
      if (s.approvals.some((a) => a.by === p.id)) return no("already-approved", `${p.id} already approved it; another person must`);
      if (s.policy.protected && !can(p, "approve.protected")) return no("protected-scope", "it is protected: approving needs approve.protected (the prod_approver role)");
      if (s.policy.frozen) return no("frozen", `frozen${s.policy.freezeReason ? `: ${s.policy.freezeReason}` : ""}`);
      if (s.eligible && !s.eligible.includes(p.id)) return no("not-eligible", `${p.id} is not an approver for it (approvers: ${s.eligible.join(", ")})`);
      if (digest !== s.digest) return no("digest-mismatch", "the approval names a different plan than the one recorded");
      const after = counted({ ...s, approvals: [...s.approvals, { by: p.id, principalType: p.type, authentication: "-", digest: s.digest }] });
      return { allow: true, result: after.valid.length >= after.required ? "approved" : "awaiting-approval" };
    }
    case "withdraw": {
      if (!s) throw new Error("withdraw needs a subject");
      if (s.irreversible) return no("irreversible", "its first irreversible step has happened; it can no longer be withdrawn");
      if (p.id === s.proposedBy) return { allow: true };
      if (p.type === "person" && can(p, "approve")) return { allow: true };
      return no("forbidden-effect", `${p.id} may not withdraw it: only its proposer or an approver`);
    }
    case "trigger":
      return can(p, "trigger") ? { allow: true } : no("forbidden-effect", `${who} may not trigger execution: needs the "trigger" effect`);
    case "execute": {
      if (!s) throw new Error("execute needs a subject");
      if (p.type !== "component" || !can(p, "execute")) return no("forbidden-effect", `${who} may not execute: only a component with the "execute" effect`);
      if (s.revoked) return no("revoked", "it was revoked");
      if (s.policy.frozen) return no("frozen", `frozen${s.policy.freezeReason ? `: ${s.policy.freezeReason}` : ""}; it waits`, "wait");
      const { valid, required } = counted(s);
      if (valid.length < required) return no("insufficient-approvals", `${valid.length} counted approval(s), ${required} required by the current policy`, "awaiting-approval");
      if (s.production) {
        const weak = valid.filter((a) => !CONTRACT.authentication.productionRequires.includes(a.authentication));
        if (weak.length) return no("unauthenticated-for-production", `production destination: approval(s) by ${weak.map((a) => `${a.by} (${a.authentication})`).join(", ")} are not authenticated; ${CONTRACT.authentication.productionRequires.join(" or ")} required`);
      }
      return { allow: true };
    }
  }
}
