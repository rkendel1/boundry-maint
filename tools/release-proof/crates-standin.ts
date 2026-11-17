/**
 * A disposable Cargo registry for release proofs: the sparse index protocol Cargo reads, the crates.io publish
 * API (PUT /api/v1/crates/new), downloads, yank, and one failure mode: store a publish, then drop the connection
 * without answering (an ambiguous publish). Stored on disk under `dir`. Never a production registry.
 */
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface StandIn { url: string; server: Server; loseNextPublishResponse(): void; yank(name: string, version: string): void; publishes(): number }

const indexPath = (n: string) => { const l = n.toLowerCase(); return l.length <= 2 ? `${l.length}/${l}` : l.length === 3 ? `3/${l[0]}/${l}` : `${l.slice(0, 2)}/${l.slice(2, 4)}/${l}`; };

export async function startCratesStandIn(dir: string, token: string, port = 0): Promise<StandIn> {
  mkdirSync(join(dir, "index"), { recursive: true });
  mkdirSync(join(dir, "crates"), { recursive: true });
  let lose = false, count = 0, base = "";
  const entries = (name: string): any[] => { const f = join(dir, "index", indexPath(name)); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const save = (name: string, e: any[]) => { const f = join(dir, "index", indexPath(name)); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, e.map((x) => JSON.stringify(x)).join("\n") + "\n"); };
  type Out = { status: number; type?: string; body?: Buffer | string } | "drop";
  const handle = async (req: IncomingMessage, body: Buffer): Promise<Out> => {
    const u = new URL(req.url ?? "/", "http://x");
    const json = (status: number, v: unknown): Out => ({ status, type: "application/json", body: JSON.stringify(v) });
    if (req.method === "GET" && u.pathname === "/index/config.json") return json(200, { dl: `${base}/api/v1/crates`, api: base, "auth-required": false });
    if (req.method === "GET" && u.pathname.startsWith("/index/")) {
      const name = u.pathname.split("/").pop()!;
      const e = entries(name);
      if (!e.length) return { status: 404 };
      return { status: 200, type: "text/plain", body: e.map((x) => JSON.stringify(x)).join("\n") + "\n" };
    }
    let m = /^\/api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/.exec(u.pathname);
    if (req.method === "GET" && m) {
      const f = join(dir, "crates", `${m[1]}-${m[2]}.crate`);
      if (!existsSync(f)) return { status: 404 };
      return { status: 200, type: "application/octet-stream", body: readFileSync(f) };
    }
    if (req.method === "PUT" && u.pathname === "/api/v1/crates/new") {
      if (req.headers.authorization !== token) return json(403, { errors: [{ detail: "invalid token" }] });
      const ml = body.readUInt32LE(0);
      const meta = JSON.parse(body.subarray(4, 4 + ml).toString("utf8"));
      const cl = body.readUInt32LE(4 + ml);
      const crate = body.subarray(8 + ml, 8 + ml + cl);
      const e = entries(meta.name);
      if (e.some((x) => x.vers === meta.vers)) return json(400, { errors: [{ detail: `crate version \`${meta.vers}\` is already uploaded` }] });
      writeFileSync(join(dir, "crates", `${meta.name}-${meta.vers}.crate`), crate);
      e.push({ name: meta.name, vers: meta.vers, deps: meta.deps.map((d: any) => ({ name: d.explicit_name_in_toml ?? d.name, req: d.version_req, features: d.features, optional: d.optional, default_features: d.default_features, target: d.target, kind: d.kind, registry: d.registry ?? null, ...(d.explicit_name_in_toml ? { package: d.name } : {}) })), cksum: createHash("sha256").update(crate).digest("hex"), features: meta.features, yanked: false, links: meta.links ?? null, v: 2 });
      save(meta.name, e);
      count++;
      if (lose) { lose = false; return "drop"; } // stored, but the client never hears back
      return json(200, { warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
    }
    m = /^\/api\/v1\/crates\/([^/]+)\/([^/]+)\/yank$/.exec(u.pathname);
    if (req.method === "DELETE" && m) { const e = entries(m[1]!); const x = e.find((y) => y.vers === m![2]); if (x) x.yanked = true; save(m[1]!, e); return json(200, { ok: true }); }
    return { status: 404 };
  };
  const read = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); };
  const server = createServer(async (req, res) => {
    const out = await handle(req, await read(req));
    if (out === "drop") return void req.socket.destroy();
    res.writeHead(out.status, out.type ? { "content-type": out.type } : {});
    res.end(out.body ?? "");
  });
  // Cargo's curl asks to upgrade plain http to h2c. A server without HTTP/2 answers in HTTP/1.1, as here.
  server.on("upgrade", async (req: IncomingMessage, socket: Duplex) => {
    const out = await handle(req, Buffer.alloc(0));
    if (out === "drop") return void socket.destroy();
    const body = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body ?? "");
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${out.status} X\r\n${out.type ? `content-type: ${out.type}\r\n` : ""}content-length: ${body.length}\r\nconnection: close\r\n\r\n`), body]));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    url: base, server, publishes: () => count,
    loseNextPublishResponse: () => { lose = true; },
    yank: (name, version) => { const e = entries(name); const x = e.find((y) => y.vers === version); if (x) x.yanked = true; save(name, e); },
  };
}
