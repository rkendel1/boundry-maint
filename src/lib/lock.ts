/**
 * Cross-process exclusive locks on the local filesystem.
 *
 * A lock is a directory containing the holder's pid. It is created complete (pid written first, in a private
 * temporary directory) and then renamed into place, so another process never observes a lock without its
 * owner. rename(2) of a directory onto an existing non-empty directory fails, which is the mutual exclusion.
 * A lock whose holder is no longer alive is stale and may be replaced.
 */
import { mkdir, readFile, rename, rm, writeFile, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-process holders (pid alone cannot tell two callers in one process apart). */
const local = new Set<string>();

async function tryAcquire(path: string): Promise<boolean> {
  if (local.has(path)) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = await mkdtemp(`${path}.tmp-`);
  await writeFile(join(tmp, "pid"), String(process.pid));
  for (let i = 0; i < 3; i++) {
    try { await rename(tmp, path); local.add(path); return true; }
    catch {
      const pid = Number(await readFile(join(path, "pid"), "utf8").catch(() => "0"));
      if (!pid) continue; // released between our rename and this read: just try again
      if (pid === process.pid || alive(pid)) break; // held (by another caller in this process, or a live process)
      // Stale: its holder died. Two processes clearing the same stale lock at once could remove each other's
      // fresh lock; this needs a crash plus a simultaneous retry, and is accepted (documented, not hidden).
      await discard(path);
    }
  }
  await rm(tmp, { recursive: true, force: true });
  return false;
}

/** Move a lock directory out of the way in one rename, then remove it at leisure. */
async function discard(path: string): Promise<void> {
  const tomb = `${path}.gone-${process.pid}-${randomUUID()}`;
  try { await rename(path, tomb); } catch { return; } // already gone
  await rm(tomb, { recursive: true, force: true });
}

export class LockHeld extends Error { readonly lock: string; constructor(lock: string) { super(`lock held: ${lock}`); this.lock = lock; } }

/** Take every lock (sorted, so two callers never deadlock) and run `f`. wait=0: refuse immediately if held. */
export async function withLocks<T>(paths: string[], f: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const held: string[] = [];
  try {
    for (const p of [...new Set(paths)].sort()) {
      const deadline = Date.now() + (opts.waitMs ?? 0);
      while (!(await tryAcquire(p))) {
        if (Date.now() >= deadline) throw new LockHeld(p);
        await sleep(25 + Math.random() * 50);
      }
      held.push(p);
    }
    return await f();
  } finally {
    // Release atomically: rename the lock away, then delete it. Deleting in place would empty the directory
    // first (pid file, then the directory), and another caller's rename onto the momentarily empty directory
    // would succeed, only to have its fresh lock deleted by this rm.
    for (const p of held.reverse()) { await discard(p); local.delete(p); }
  }
}
