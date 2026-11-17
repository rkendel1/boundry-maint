/**
 * Resolver Control, read and proposed to through its published AppPort capabilities, as Maintenance's own
 * principal in Resolver Control (a session it issued; typically role `agent`). Never through Resolver.
 *
 * Authority stays where it is:
 * - Resolver owns what a reference resolves to and its history; Resolver Control governs changes to it.
 * - Maintenance holds no Resolver key and cannot approve or execute a runtime change: Resolver Control refuses
 *   those to this principal (and to every non-person / non-executor).
 * Everything returned here is a projection, stamped with when it was read and from where. It is never written to
 * Maintenance's records as truth, and never the basis of a Resolver write.
 */
import { createClient, type AppPortClient } from "@appport/client";
import { createHttpTransport } from "@appport/transport-http";

export interface RuntimeChange {
  id: string; number: number; ref: string; status: string; operation: string;
  proposedBy: string; proposedByType: string; proposedAt: number | null;
  approvals: { by: string; at: number }[]; requiredApprovals: number | null;
  verification: { passed: boolean; at: number; revision: number } | null;
}
export interface RuntimeReference {
  ref: string; kind: string | null; revision: number | null; summary: string | null;
  owner: string | null; criticality: string | null; changeClass: string | null;
  /** How this application is known to use the reference: declared (by an operator or itself) and/or observed by Resolver. */
  basis: ("declared" | "observed")[];
  usage: string | null;
  changes: RuntimeChange[];
  events: { at: number; type: string; actor: string; subjectId: string }[];
}
export interface RuntimeView { authority: string; source: string; readAt: string; principal: string; application: string; references: RuntimeReference[] }

export class ResolverControl {
  readonly url: string;
  readonly #client: AppPortClient;
  readonly #principal: string;
  /** url: Resolver Control's origin (it serves AppPort at /appport); token: Maintenance's session in Resolver Control. */
  constructor(url: string, token: string, principal = "boundry-maintenance") {
    this.url = url.replace(/\/$/, "");
    this.#principal = principal;
    this.#client = createClient({ transport: createHttpTransport({ url: `${this.url}/appport`, headers: { authorization: `Bearer ${token}` } }) });
  }
  call<T = any>(capability: string, input: unknown): Promise<T> { return this.#client.call<T>(capability, input); }

  /** Every reference this application is known to use, with its governance metadata and changes. */
  async runtimeOf(application: string): Promise<RuntimeView> {
    const readAt = new Date().toISOString();
    const rows: any[] = await this.call("dependencies.list", {});
    const references: RuntimeReference[] = [];
    for (const row of rows) {
      const d: any = await this.call("dependencies.inspect", { ref: row.ref });
      const declared = (d.consumers ?? []).find((c: any) => c.application === application);
      const observed = (d.observation?.observedConsumers ?? []).some((c: any) => c.application === application);
      if (!declared && !observed) continue;
      references.push({
        ref: d.ref, kind: d.observation?.kind ?? null, revision: d.observation?.revision ?? null, summary: d.summary ?? null,
        owner: d.dependency?.owner ?? null, criticality: d.dependency?.criticality ?? null, changeClass: d.dependency?.changeClass ?? null,
        basis: [...(declared ? ["declared" as const] : []), ...(observed ? ["observed" as const] : [])], usage: declared?.usage ?? null,
        changes: await Promise.all((d.changes ?? []).map(async (c: any) => {
          const full: any = await this.call("changes.inspect", { id: c.id });
          const ch = full.change;
          return {
            id: ch.id, number: ch.number, ref: ch.ref, status: ch.status, operation: ch.operation, proposedBy: ch.proposedBy, proposedByType: ch.proposedByType,
            proposedAt: ch.proposedAt ?? null, approvals: (ch.approvals ?? []).map((a: any) => ({ by: a.by, at: a.at })), requiredApprovals: full.requiredApprovals ?? null,
            verification: ch.verification ? { passed: !!ch.verification.passed, at: ch.verification.at, revision: ch.verification.revision } : null,
          };
        })),
        events: (d.events ?? []).map((e: any) => ({ at: e.at, type: e.type, actor: e.actor, subjectId: e.subjectId })),
      });
    }
    return { authority: "Resolver (bindings and history), governed by Resolver Control", source: `${this.url}/appport`, readAt, principal: this.#principal, application, references };
  }
}
