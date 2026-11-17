// READ-ONLY: plan a release of a real package against the real npm registry and the real GitHub repository.
// It never approves or executes. The release policy is a temporary override (config/packages.json is not changed).
// Usage: node tools/release-proof/live-plan.ts <package-id[,package-id…]> <bump> <out.md>
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageCatalog, InstallationsFile } from "../../src/contracts.ts";
import { ReleaseManager } from "../../src/release/manager.ts";
import { NpmRegistry, GitCli, GitHubReleases, BoundryCiExecutor } from "../../src/release/adapters.ts";
import { approvalRequest } from "../../src/release/cli.ts";

const [idList, bump, out] = process.argv.slice(2);
const ids = idList!.split(",");
const root = new URL("../..", import.meta.url).pathname;
const catalog = PackageCatalog.parse(JSON.parse(await readFile(join(root, "config/packages.json"), "utf8"))).packages
  .map((p) => (ids.includes(p.id) ? { ...p, release: { approvers: ["randy"], allowedBumps: ["patch", "minor", "prerelease", "repository"], prereleaseId: "rc", tagFormat: "{name}@{version}", branch: "main", validation: ["test"], githubRelease: true, distTag: "latest" } as const } : p));
const installations = InstallationsFile.parse(JSON.parse(await readFile(join(root, "data/installations.json"), "utf8"))).installations;
const dataDir = await mkdtemp(join(tmpdir(), "live-plan-data-"));
const runtimeDir = await mkdtemp(join(tmpdir(), "live-plan-run-"));
const refuse = () => { throw new Error("read-only plan: no side effects allowed"); };
const m = new ReleaseManager({
  dataDir, runtimeDir, catalog: catalog as any, installations,
  registry: () => Object.assign(new NpmRegistry("https://registry.npmjs.org", null), { publish: refuse }),
  git: (repo) => new GitCli(`https://github.com/${repo}.git`, join(runtimeDir, "git"), { name: "x", email: "x@x" }),
  releases: Object.assign(new GitHubReleases("https://api.github.com", null), { create: refuse }),
  executor: Object.assign(new BoundryCiExecutor("http://127.0.0.1:1", ""), { submit: refuse }),
});
let r;
try { r = await m.plan({ packages: ids, bump: bump as any, requestedBy: "randy", reason: "Proof of the release plan against the live registry and repository (not approved, not executed)" }); }
catch (e) {
  const text = `<!-- Generated read-only by tools/release-proof/live-plan.ts at ${new Date().toISOString()} against registry.npmjs.org and github.com. -->\n\n# Release request refused: ${ids.join(", ")} (${bump})\n\n${(e as Error).message.replace(/\n  - /g, "\n- ")}\n`;
  await writeFile(out!, text); console.log(text); process.exit(0);
}
await writeFile(out!, `<!-- Generated read-only by tools/release-proof/live-plan.ts at ${new Date().toISOString()} against registry.npmjs.org and github.com. Not approved; not executed. -->\n\n` + approvalRequest(r) + "\n");
console.log(approvalRequest(r));
