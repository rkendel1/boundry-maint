// The crates.io adapter against a real HTTP registry (the disposable stand-in that speaks the sparse-index and
// publish protocols), and real Cargo resolving what was published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { CratesRegistry, Refused, Unavailable } from "../src/release/adapters.ts";
import { startCratesStandIn } from "../tools/release-proof/crates-standin.ts";
import { makeCargoRepo } from "./release-fakes.ts";

function packCore(version: string): string {
  const repo = makeCargoRepo({ coreVersion: version, appReq: version.split(".").slice(0, 2).join(".") });
  execFileSync("cargo", ["package", "--offline", "--locked", "-p", "demo-core", "-q"], { cwd: repo.work, stdio: "pipe" });
  return join(repo.work, "target", "package", `demo-core-${version}.crate`);
}

test("crates adapter: index, publish of exact bytes, duplicate refused, ambiguous answer, yank", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crates-"));
  const s = await startCratesStandIn(dir, "secret-token");
  try {
    const reg = new CratesRegistry(s.url, `${s.url}/index`, "secret-token");
    assert.equal(await reg.state("demo-core"), null);
    const crate = packCore("0.1.0");
    await reg.publish(crate);
    const v = await reg.version("demo-core", "0.1.0");
    const bytes = readFileSync(crate);
    assert.equal(v!.integrity, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(reg.integrityOf(bytes), v!.integrity);
    assert.ok((await reg.download(v!.tarball!)).equals(bytes), "serves the exact bytes");
    await assert.rejects(reg.publish(crate), Refused, "a published version is never overwritten");
    await assert.rejects(new CratesRegistry(s.url, `${s.url}/index`, "wrong").publish(packCore("0.1.1")), /invalid token/);
    s.loseNextPublishResponse();
    await assert.rejects(reg.publish(packCore("0.1.2")), Unavailable, "an unanswered publish is ambiguous, not a failure");
    assert.equal((await reg.version("demo-core", "0.1.2"))?.version, "0.1.2", "…and the registry, asked, has it");
    s.yank("demo-core", "0.1.0");
    const st = await reg.state("demo-core");
    assert.deepEqual(st!.yanked, ["0.1.0"]);
    assert.deepEqual(st!.versions.sort(), ["0.1.0", "0.1.2"]);
    assert.equal((await reg.version("demo-core", "0.1.0"))!.yanked, true);
    assert.equal(CratesRegistry.indexPath("ab"), "2/ab");
    assert.equal(CratesRegistry.indexPath("abc"), "3/a/abc");
    assert.equal(CratesRegistry.indexPath("Demo-Core"), "de/mo/demo-core");
  } finally { s.server.close(); }
});

test("real Cargo resolves a published crate from the registry, and never resolves a yanked one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crates-"));
  const s = await startCratesStandIn(dir, "t");
  try {
    const reg = new CratesRegistry(s.url, `${s.url}/index`, "t");
    await reg.publish(packCore("0.2.0"));
    await reg.publish(packCore("0.2.1"));
    s.yank("demo-core", "0.2.1");
    const app = mkdtempSync(join(tmpdir(), "consumer-"));
    mkdirSync(join(app, ".cargo")); mkdirSync(join(app, "src"));
    writeFileSync(join(app, ".cargo", "config.toml"), `[registries.standin]\nindex = "sparse+${s.url}/index/"\n# The stand-in is plain http (no HTTP/2); it answers h2c upgrade requests in HTTP/1.1.\n`);
    writeFileSync(join(app, "Cargo.toml"), `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\ndemo-core = { version = "0.2", registry = "standin" }\n`);
    writeFileSync(join(app, "src", "main.rs"), "fn main() { println!(\"{}\", demo_core::answer()); }\n");
    const env = { ...process.env, CARGO_HOME: join(app, ".cargo-home"), NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
    // Asynchronously: the registry runs in this process, so a synchronous child would block its answers.
    await run("cargo", ["generate-lockfile"], { cwd: app, env });
    const lock = readFileSync(join(app, "Cargo.lock"), "utf8");
    assert.match(lock, /name = "demo-core"\nversion = "0\.2\.0"/, "0.2.1 is yanked, so Cargo resolves 0.2.0");
    await run("cargo", ["build", "-q"], { cwd: app, env });
    assert.ok(readdirSync(join(app, "target", "debug")).includes("consumer"));
  } finally { s.server.close(); }
});
