import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { withLocks, LockHeld } from "../src/lib/lock.ts";

test("one holder at a time within a process; refused immediately without waiting", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "lock-")), "a.lock");
  let inside = 0, max = 0;
  await Promise.all(Array.from({ length: 10 }, () => withLocks([p], async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 10)); inside--; }, { waitMs: 20_000 })));
  assert.equal(max, 1);
  await withLocks([p], async () => { await assert.rejects(withLocks([p], async () => {}), LockHeld); });
});

test("one holder at a time across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const log = join(dir, "log"), script = join(dir, "w.ts");
  writeFileSync(script, `import { withLocks } from ${JSON.stringify(new URL("../src/lib/lock.ts", import.meta.url).pathname)};\nimport { appendFileSync } from "node:fs";\nfor (let i = 0; i < 4; i++) await withLocks([${JSON.stringify(join(dir, "x.lock"))}], async () => { appendFileSync(${JSON.stringify(log)}, "+\\n"); await new Promise((r) => setTimeout(r, 10)); appendFileSync(${JSON.stringify(log)}, "-\\n"); }, { waitMs: 60000 });\n`);
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((res, rej) => spawn(process.execPath, [script], { stdio: "inherit" }).on("exit", (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`)))))));
  let depth = 0, max = 0;
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  for (const l of lines) { depth += l === "+" ? 1 : -1; max = Math.max(max, depth); }
  assert.equal(lines.length, 32);
  assert.equal(max, 1);
});

test("a lock left by a dead process is stale and replaced", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "lock-")), "s.lock");
  mkdirSync(p); writeFileSync(join(p, "pid"), "999999"); // no such process
  let ran = false;
  await withLocks([p], async () => { ran = true; });
  assert.ok(ran);
  void appendFileSync;
});
