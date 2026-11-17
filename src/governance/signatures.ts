/**
 * Authenticated approvals (governance contract §9, level "signature").
 *
 * An approval statement is canonical JSON naming everything the approver authorizes: the release, its plan
 * digest, the source commit, every destination and whether it is production. The approver signs it on their own
 * machine with their own SSH key:
 *
 *   ssh-keygen -Y sign -n boundry-release-approval -f ~/.ssh/id_ed25519 statement.json
 *
 * Boundry never sees the private key. Verification uses only the public keys registered to that person in
 * config/principals.json, with `ssh-keygen -Y verify`. The release executor re-verifies every signature at the
 * start of execution: a recorded "signature" label is not trusted on its own.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ReleaseRecord } from "../contracts.ts";
import { CONTRACT_VERSION } from "./rules.ts";

export const NAMESPACE = "boundry-release-approval";

export function approvalStatement(r: Pick<ReleaseRecord, "id" | "planDigest" | "plan">, approver: string): string {
  return JSON.stringify({
    contract: CONTRACT_VERSION,
    kind: "boundry.release.approval",
    release: r.id,
    planDigest: r.planDigest,
    repository: r.plan.repository,
    sourceCommit: r.plan.sourceCommit,
    packages: r.plan.packages.map((p) => ({ name: p.name, version: p.proposedVersion, destination: p.destination, production: p.production, tag: p.tag })),
    approver,
  }) + "\n";
}

function run(args: string[], input: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile("ssh-keygen", args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: `${stdout}${stderr}` }));
    child.stdin?.end(input);
  });
}

/** True only if `signature` is a valid signature of `statement` by one of the principal's registered keys. */
export async function verifyApproval(p: Principal, statement: string, signature: string): Promise<boolean> {
  if (p.type !== "person" || p.keys.length === 0 || !signature.includes("BEGIN SSH SIGNATURE")) return false;
  const dir = await mkdtemp(join(tmpdir(), "bm-sig-"));
  try {
    const allowed = join(dir, "allowed_signers"), sig = join(dir, "statement.sig");
    await writeFile(allowed, p.keys.map((k) => `${p.id} namespaces="${NAMESPACE}" ${k}`).join("\n") + "\n");
    await writeFile(sig, signature);
    const r = await run(["-Y", "verify", "-f", allowed, "-I", p.id, "-n", NAMESPACE, "-s", sig], statement);
    return r.code === 0;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** For tests and the proof only: sign with a key file, as an approver would on their own machine. */
export async function signWithKeyFile(keyFile: string, statement: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bm-sign-"));
  try {
    const f = join(dir, "statement");
    await writeFile(f, statement);
    const r = await run(["-Y", "sign", "-n", NAMESPACE, "-f", keyFile, f], "");
    if (r.code !== 0) throw new Error(`ssh-keygen sign failed: ${r.out}`);
    const { readFile } = await import("node:fs/promises");
    return await readFile(`${f}.sig`, "utf8");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
