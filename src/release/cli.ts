/**
 * `node src/index.ts release <plan|show|approve|revoke|execute|list>` — the person-facing release path.
 * Nobody writes release scripts: a person asks for a release, reads one approval request, approves the exact
 * plan, and Boundry carries it out and proves it.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ReleaseManager } from "./manager.ts";
import { NpmRegistry, GitCli, GitHubReleases, BoundryCiExecutor } from "./adapters.ts";
import type { ReleaseRecord, PackageConfig, Installation } from "../contracts.ts";

const secret = async (envName: string): Promise<string | null> => {
  const p = process.env[envName];
  return p && existsSync(p) ? (await readFile(p, "utf8")).trim() : null;
};

export async function releaseManager(root: string, dataDir: string, catalog: PackageConfig[], installations: Installation[]): Promise<ReleaseManager> {
  const env = process.env;
  const npmUrl = env.BOUNDRY_NPM_REGISTRY ?? "https://registry.npmjs.org";
  const npmToken = await secret("BOUNDRY_NPM_TOKEN_FILE");
  const gitToken = await secret("BOUNDRY_GIT_TOKEN_FILE");
  const runtimeDir = env.BOUNDRY_RELEASE_RUNTIME ?? join(root, ".release-runtime");
  return new ReleaseManager({
    dataDir, runtimeDir, catalog, installations,
    registry: () => new NpmRegistry(npmUrl, npmToken),
    git: (repo) => new GitCli((env.BOUNDRY_GIT_URL_TEMPLATE ?? "https://github.com/{repo}.git").replace("{repo}", repo), join(runtimeDir, "git", repo.replace("/", "__")),
      { name: env.BOUNDRY_RELEASE_GIT_NAME ?? "Boundry Release", email: env.BOUNDRY_RELEASE_GIT_EMAIL ?? "release@boundry.invalid" },
      gitToken ? `Authorization: Basic ${Buffer.from(`x-access-token:${gitToken}`).toString("base64")}` : undefined),
    releases: new GitHubReleases(env.BOUNDRY_GITHUB_API ?? "https://api.github.com", await secret("BOUNDRY_GITHUB_RELEASE_TOKEN_FILE")),
    executor: new BoundryCiExecutor(env.BOUNDRY_CI_URL ?? "http://127.0.0.1:21030", (await secret("BOUNDRY_CI_OPERATOR_TOKEN_FILE")) ?? ""),
  });
}

/** The one document a person reads before approving. */
export function approvalRequest(r: ReleaseRecord): string {
  const p = r.plan;
  const names = p.packages.map((x) => `${x.name} ${x.registryVersions.highest ?? "(unpublished)"} → **${x.proposedVersion}**`).join(", ");
  const L = [`# Release request: ${names}`, "", `Requested by ${p.requestedBy} at ${p.requestedAt}${p.reason ? ` — “${p.reason}”` : ""}. State: **${r.state}**.`, ""];
  L.push("## What will happen, in order", "");
  L.push(`1. A commit “${p.releaseCommit.message}” is added on top of \`${p.sourceCommit.slice(0, 12)}\` on \`${p.branch}\`${p.releaseCommit.files.length ? `, changing ${p.releaseCommit.files.map((f) => `\`${f}\``).join(", ")}` : " (no file changes)"}. If \`${p.branch}\` has moved, the release stops.`);
  L.push(`2. Boundry CI ${p.validation.includes("test") ? "runs the tests on" : "builds"} that exact commit and packages it. The package's SHA-256 is recorded.`);
  L.push(`3. Only after the build succeeds: ${p.packages.map((x) => `tag \`${x.tag}\``).join(", ")} on that commit. Existing tags are never moved.`);
  L.push(`4. Exactly ${p.packages.length === 1 ? "that tarball is" : "those tarballs are"} published to ${[...new Set(p.packages.map((x) => x.destination))].join(", ")} (dist-tag ${[...new Set(p.packages.map((x) => `\`${x.distTag}\``))].join(", ")}). A version already on the registry is never overwritten.`);
  L.push(`5. The registry is checked: it must serve ${p.packages.map((x) => x.proposedVersion).join(", ")} with the same integrity and the same bytes.`);
  L.push(p.githubRelease ? `6. A GitHub release is created for ${p.packages.map((x) => `\`${x.tag}\``).join(", ")}, citing the commit, artifact digests and registry integrity.` : "6. No GitHub release (policy).", "");
  L.push("## Why these versions", "", ...p.decision.map((d) => `- ${d}`), "");
  L.push("## Who else is affected", "", ...(p.dependents.length ? p.dependents.map((d) => `- **${d.package}** (${d.where}, declares \`${d.declared}\`): ${d.effect}`) : ["- No dependents found."]), "", "Dependents are **not** changed or published by this release. Each needs its own release request.", "");
  L.push("## What approving does not allow", "", "- Any other version, commit, artifact, tag or registry than the ones above.", "- Publishing dependents, re-tagging, or overwriting a published version.", "- Continuing if the registry or the branch changes before publication: that requires a new plan.", "");
  L.push("## Approve", "", `Approvers: ${p.approvers.join(", ")}`, "", "```bash", `node src/index.ts release approve ${r.id} --as <your name> --digest ${r.planDigest}`, "```", "");
  if (r.facts.releaseCommit || r.attempts.length) {
    L.push("## Evidence so far", "");
    if (r.facts.releaseCommit) L.push(`- Release commit: \`${r.facts.releaseCommit}\``);
    if (r.facts.build) L.push(`- Built by ${r.facts.build.system} run \`${r.facts.build.runId}\`: ${r.facts.build.artifacts.map((a) => `\`${a.file}\` sha256 \`${a.sha256}\``).join(", ")}`);
    for (const t of r.facts.tags) L.push(`- Tag \`${t.name}\` → \`${t.target.slice(0, 12)}\``);
    for (const v of r.facts.registryVerification) L.push(`- Registry serves ${v.version}: integrity \`${v.integrity.slice(0, 24)}…\`, bytes sha256 \`${v.tarballSha256.slice(0, 16)}…\`, dist-tag ${v.distTagPointsHere ? "points here" : "does not point here"}`);
    for (const g of r.facts.githubReleases) L.push(`- GitHub release: ${g.url}${g.alreadyPresent ? " (already existed)" : ""}`);
    if (r.failure) L.push(`- **Stopped at ${r.failure.at}:** ${r.failure.reason} (${r.failure.recoverable ? "recoverable: run execute again" : "final"})`);
    L.push("");
  }
  L.push(`Plan digest \`${r.planDigest}\` · record \`data/release-manager/${r.id.slice(0, r.id.lastIndexOf("@"))}/${r.id.slice(r.id.lastIndexOf("@") + 1)}.json\``);
  return L.join("\n");
}
