/**
 * Host for Maintenance's AppPort application: AppPort's HTTP binding at /appport and MCP (Streamable HTTP) at /mcp,
 * on one Node server. The host authenticates; AppPort and MCP only carry the resulting identity.
 *
 * Tokens: a file of lines "<sha256 of token> <principal id>" (the principal must be declared in
 * config/principals.json). A caller with no or an unknown token is anonymous, and every Maintenance capability
 * requires a permission, so anonymous calls are refused.
 */
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createAppPortServer, createHttpBinding, type Identity } from "@appport/server";
import { createNodeRequestListener } from "@appport/server/node";
import { createMcpHandler } from "@appport/mcp";
import type { AppPortApplication } from "@appport/core";
import type { Principal } from "../contracts.ts";
import { permissionsOf } from "./application.ts";

export function parseTokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) { const [hash, id] = line.trim().split(/\s+/); if (hash && id && /^[0-9a-f]{64}$/.test(hash)) out[hash] = id; }
  return out;
}

export function identityFor(authorization: string | undefined, tokens: Record<string, string>, principals: Principal[], applicationId: string): Identity | undefined {
  const t = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!t) return undefined;
  const h = createHash("sha256").update(t).digest("hex");
  const id = Object.entries(tokens).find(([hash]) => timingSafeEqual(Buffer.from(hash), Buffer.from(h)))?.[1];
  const p = id ? principals.find((x) => x.id === id) : undefined;
  if (!p) return undefined;
  // AppPort's principal kinds; Maintenance itself decides by the principal's id and its declared type, never this.
  const principal = { id: p.id, type: p.type === "person" ? ("user" as const) : p.type === "agent" ? ("application" as const) : ("service" as const) };
  return { principal, session: { id: `s-${h.slice(0, 16)}`, applicationId, createdAt: new Date().toISOString(), principal, permissions: permissionsOf(p) } };
}

export async function serveMaintenance(application: AppPortApplication, o: { tokens: Record<string, string>; principals: Principal[]; port?: number; host?: string }): Promise<{ server: Server; url: string }> {
  const identify = (auth: string | undefined) => identityFor(auth, o.tokens, o.principals, application.descriptor.id);
  const appport = createAppPortServer({ application, authenticate: ({ headers }) => identify(headers?.authorization) ?? {} });
  const binding = createHttpBinding({ server: appport });
  const appportListener = createNodeRequestListener(binding);
  const mcp = createMcpHandler(application, { async context({ headers }) { const i = identify(headers["authorization"]?.toString()); return i ? { session: i.session!, principal: i.principal! } : undefined; } });

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/mcp") {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const response = await mcp(new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) }));
      const out: Record<string, string> = {}; response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (binding.handles(path)) return appportListener(req, res);
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", r));
  return { server, url: `http://${o.host ?? "127.0.0.1"}:${(server.address() as any).port}` };
}
