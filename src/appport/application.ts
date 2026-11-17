/**
 * Boundry Maintenance as an AppPort application: the same governed operations as the CLI, to people, agents (MCP)
 * and other applications through one boundary. No database or hosted backend: handlers call the Release Manager,
 * whose records stay in the repository.
 *
 * Authorization happens twice, by design (governance contract §2):
 * 1. AppPort's permission authorizer, before the handler runs: each capability requires `maintenance.<effect>`,
 *    and a session carries exactly the effects its principal's roles grant under the contract.
 * 2. The handler calls the Release Manager, which decides with the contract's rules (person-only approval, not
 *    the proposer, the ratchet, the executor's own check, signed approvals for production).
 *
 * Identity: AppPort represents identity; the host authenticates. A bearer token identifies a client process, not a
 * person, so approvals made here are recorded `asserted` unless they carry a valid SSH signature.
 */
import { createApplication, defineCapability, type AppPortApplication } from "@appport/core";
import { s } from "@appport/schema";
import { permissionAuthorizer } from "@appport/authorization";
import { errors } from "@appport/protocol";
import type { ReleaseManager } from "../release/manager.ts";
import { ReleaseError } from "../release/manager.ts";
import { approvalRequest } from "../release/cli.ts";
import { CAPABILITIES, effectsOf, CONTRACT_VERSION } from "../governance/rules.ts";
import type { Installation, Principal, ProjectConfig } from "../contracts.ts";
import { applicationView, renderApplicationView } from "../integrations/application-view.ts";
import type { ResolverControl } from "../integrations/resolver-control.ts";

export const permission = (effect: string) => `maintenance.${effect}`;
/** The session permissions a principal holds: its contract effects, nothing else. */
export const permissionsOf = (p: Principal) => [...effectsOf(p)].map(permission).sort();

export interface MaintenanceDeps {
  manager: ReleaseManager;
  principals: Principal[];
  projects: ProjectConfig[];
  installations: () => Promise<Installation[]> | Installation[];
  packageNames: Record<string, string>;
  resolverControl: ResolverControl | null;
}

const need = (ctx: { principal?: { id: string } }) => { if (!ctx.principal) throw errors.unauthorized("Authentication is required"); return ctx.principal.id; };
/** Domain refusals become AppPort errors the caller can act on; the contract code is kept in the message. */
async function governed<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    if (e instanceof ReleaseError) {
      if (e.code === "not-allowed") throw errors.forbidden(e.message);
      if (e.code === "busy") throw errors.conflict(e.message);
      throw errors.invalidRequest(e.message);
    }
    throw e;
  }
}
const summary = (r: Awaited<ReturnType<ReleaseManager["load"]>>) => ({
  id: r.id, state: r.state, packages: r.plan.packages.map((p) => `${p.name}@${p.proposedVersion}`), proposedBy: r.plan.requestedBy,
  approvals: r.approvals.map((a) => ({ by: a.by, authentication: a.authentication })), requiredApprovals: r.plan.requiredApprovals, planDigest: r.planDigest,
  failure: r.failure?.reason ?? null,
});
const Summary = s.object({ id: s.string(), state: s.string(), packages: s.array(s.string()), proposedBy: s.string(), approvals: s.array(s.object({ by: s.string(), authentication: s.string() })), requiredApprovals: s.integer(), planDigest: s.string(), failure: s.nullable(s.string()) });

export function createMaintenanceApplication(d: MaintenanceDeps): AppPortApplication {
  const m = d.manager;
  const auth = (name: keyof typeof CAPABILITIES) => [permission(CAPABILITIES[name].effect)];
  const capabilities = [
    defineCapability({
      name: "releases.list", version: 1, description: CAPABILITIES["releases.list"].description, authorization: auth("releases.list"),
      input: s.object({}), output: s.array(Summary),
      async handler() { return (await m.list()).map(summary); },
    }),
    defineCapability({
      name: "releases.inspect", version: 1, description: CAPABILITIES["releases.inspect"].description, authorization: auth("releases.inspect"),
      input: s.object({ id: s.string() }), output: s.object({ release: Summary, approvalRequest: s.string(), record: s.unknown() }),
      async handler({ id }) { return governed(async () => { const r = await m.load(id); return { release: summary(r), approvalRequest: approvalRequest(r), record: r as never }; }); },
    }),
    defineCapability({
      name: "releases.statement", version: 1, description: "The exact approval statement the caller would sign for this release (SSH signature, namespace boundry-release-approval).", authorization: auth("releases.inspect"),
      input: s.object({ id: s.string() }), output: s.object({ statement: s.string() }),
      async handler({ id }, ctx) { return governed(async () => ({ statement: await m.statement(id, need(ctx)) })); },
    }),
    defineCapability({
      name: "releases.propose", version: 1, description: CAPABILITIES["releases.propose"].description, authorization: auth("releases.propose"),
      input: s.object({ packages: s.array(s.string()), bump: s.enum(["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease", "repository"]), reason: s.optional(s.string()) }),
      output: s.object({ release: Summary, approvalRequest: s.string() }),
      async handler({ packages, bump, reason }, ctx) {
        return governed(async () => { const r = await m.plan({ packages, bump, requestedBy: need(ctx), ...(reason ? { reason } : {}) }); return { release: summary(r), approvalRequest: approvalRequest(r) }; });
      },
    }),
    defineCapability({
      name: "releases.approve", version: 1, description: CAPABILITIES["releases.approve"].description, authorization: auth("releases.approve"),
      input: s.object({ id: s.string(), planDigest: s.string(), signature: s.optional(s.string()) }), output: Summary,
      async handler({ id, planDigest, signature }, ctx) { return governed(async () => summary(await m.approve(id, need(ctx), planDigest, signature))); },
    }),
    defineCapability({
      name: "releases.withdraw", version: 1, description: CAPABILITIES["releases.withdraw"].description, authorization: auth("releases.withdraw"),
      input: s.object({ id: s.string(), reason: s.string() }), output: Summary,
      async handler({ id, reason }, ctx) { return governed(async () => summary(await m.revoke(id, need(ctx), reason))); },
    }),
    defineCapability({
      name: "releases.trigger", version: 1, description: CAPABILITIES["releases.trigger"].description, authorization: auth("releases.trigger"),
      input: s.object({ id: s.string() }), output: Summary,
      async handler({ id }, ctx) { return governed(async () => summary(await m.execute(id, need(ctx)))); },
    }),
    defineCapability({
      name: "applications.inspect", version: 1,
      description: "One application: the packages it is built from (Maintenance) and the Resolver references it resolves (read from Resolver Control), with each side's proposals, approvals and evidence, and one activity timeline. A projection computed on demand; nothing is stored.",
      authorization: [permission("read")],
      input: s.object({ id: s.string() }), output: s.object({ view: s.unknown(), markdown: s.string() }),
      async handler({ id }) {
        const project = d.projects.find((p) => p.id === id);
        if (!project) throw errors.notFound(`unknown application ${id}`);
        const view = await applicationView(project, { installations: await d.installations(), releases: await m.list(), packageNames: d.packageNames, resolverControl: d.resolverControl });
        return { view: view as never, markdown: renderApplicationView(view) };
      },
    }),
  ];
  return createApplication({
    application: { id: "dev.boundry.maintenance", name: "boundry-maintenance", version: `0.1.0+${CONTRACT_VERSION}` },
    capabilities,
    authorizer: permissionAuthorizer(),
  });
}
