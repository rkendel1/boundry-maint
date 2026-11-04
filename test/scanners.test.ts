import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepoFiles } from "../src/scanners/common.ts";
import { scanJavaScript } from "../src/scanners/javascript.ts";
import { isWorkspaceMember, parseCargoLock, scanRust } from "../src/scanners/rust.ts";

function repo(files: Record<string, string | object>): RepoFiles {
  return {
    paths: Object.keys(files),
    read: async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`missing ${p}`);
      return typeof v === "string" ? v : JSON.stringify(v);
    },
  };
}

const dep = (roots: Awaited<ReturnType<typeof scanJavaScript>>, root: string, name: string) =>
  roots.find((r) => r.path === root)?.deps.find((d) => d.name === name);

test("npm workspaces: package-lock v3 with hoisted, nested and linked packages", async () => {
  const roots = await scanJavaScript(
    repo({
      "package.json": { name: "mono", workspaces: ["packages/*", "apps/*"], devDependencies: { typescript: "^5.0.0" } },
      "packages/sdk/package.json": { name: "@x/sdk", version: "0.3.0", dependencies: { "@appport/sdk": "^1.4.0" }, peerDependencies: { "@feltdb/core": ">=0.20.0" } },
      "apps/web/package.json": { name: "web", dependencies: { "@x/sdk": "0.3.0", "@appport/sdk": "^1.3.0" }, devDependencies: { "@appport/sdk": "^1.3.0" } },
      "node_modules/ignored/package.json": { name: "ignored" },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { name: "mono" },
          "packages/sdk": { name: "@x/sdk", version: "0.3.0" },
          "apps/web": { name: "web" },
          "node_modules/typescript": { version: "5.9.3", resolved: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz" },
          "node_modules/@appport/sdk": { version: "1.4.1" },
          "apps/web/node_modules/@appport/sdk": { version: "1.3.2" },
          "node_modules/@feltdb/core": { version: "0.21.0" },
          "node_modules/@x/sdk": { resolved: "packages/sdk", link: true },
        },
      },
    }),
    {},
  );
  assert.deepEqual(roots.map((r) => r.path).sort(), [".", "apps/web", "packages/sdk"], "node_modules is never a project root");
  assert.equal(dep(roots, "packages/sdk", "@appport/sdk")?.resolved, "1.4.1", "hoisted resolution");
  assert.equal(dep(roots, "apps/web", "@appport/sdk")?.resolved, "1.3.2", "nested node_modules wins");
  assert.equal(dep(roots, "packages/sdk", "@feltdb/core")?.kind, "peerDependencies");
  assert.equal(dep(roots, "packages/sdk", "@feltdb/core")?.declared, ">=0.20.0");
  const link = dep(roots, "apps/web", "@x/sdk");
  assert.equal(link?.source, "workspace");
  assert.equal(link?.resolved, "0.3.0");
  assert.equal(roots.find((r) => r.path === "apps/web")?.lockfile, "package-lock.json");
});

test("a manifest the lockfile does not cover is left unresolved, not guessed", async () => {
  const roots = await scanJavaScript(
    repo({
      "package.json": { name: "root", dependencies: { a: "^1.0.0" } },
      "tools/x/package.json": { name: "x", dependencies: { a: "^1.0.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.2.0" } } },
    }),
    {},
  );
  assert.equal(dep(roots, ".", "a")?.resolved, "1.2.0");
  assert.equal(dep(roots, "tools/x", "a")?.resolved, null);
  assert.match(roots.find((r) => r.path === "tools/x")!.warnings[0]!, /does not include this manifest/);
});

test("pnpm-lock.yaml v9 importers, peer suffixes and links", async () => {
  const roots = await scanJavaScript(
    repo({
      "package.json": { name: "root" },
      "apps/web/package.json": { name: "web", dependencies: { "@appport/sdk": "^1.4.0", "@x/ui": "workspace:*", react: "^18" } },
      "pnpm-lock.yaml": `lockfileVersion: '9.0'
importers:
  .: {}
  apps/web:
    dependencies:
      '@appport/sdk':
        specifier: ^1.4.0
        version: 1.4.1(react@18.3.1)
      '@x/ui':
        specifier: workspace:*
        version: link:../../packages/ui
      react:
        specifier: ^18
        version: 18.3.1
`,
    }),
    {},
  );
  assert.equal(dep(roots, "apps/web", "@appport/sdk")?.resolved, "1.4.1");
  assert.equal(dep(roots, "apps/web", "@x/ui")?.source, "workspace");
  assert.equal(dep(roots, "apps/web", "react")?.resolved, "18.3.1");
});

test("yarn.lock classic and Berry", async () => {
  const classic = await scanJavaScript(
    repo({
      "package.json": { name: "a", dependencies: { "@appport/sdk": "^1.4.0", lodash: "^4.17.0" } },
      "yarn.lock": `# yarn lockfile v1

"@appport/sdk@^1.3.0", "@appport/sdk@^1.4.0":
  version "1.4.1"
  resolved "https://registry.yarnpkg.com/@appport/sdk/-/sdk-1.4.1.tgz"

lodash@^4.17.0:
  version "4.17.21"
`,
    }),
    {},
  );
  assert.equal(dep(classic, ".", "@appport/sdk")?.resolved, "1.4.1");
  assert.equal(dep(classic, ".", "lodash")?.resolved, "4.17.21");

  const berry = await scanJavaScript(
    repo({
      "package.json": { name: "a", dependencies: { "@appport/sdk": "^1.4.0" } },
      "yarn.lock": `__metadata:
  version: 8

"@appport/sdk@npm:^1.4.0":
  version: 1.4.1
  resolution: "@appport/sdk@npm:1.4.1"
`,
    }),
    {},
  );
  assert.equal(dep(berry, ".", "@appport/sdk")?.resolved, "1.4.1");
});

test("project paths and ignorePaths slice a repository into several projects", async () => {
  const files = repo({
    "apps/a/package.json": { name: "a" },
    "apps/b/package.json": { name: "b" },
    "vendor/x/package.json": { name: "x" },
    "experiments/y/package.json": { name: "y" },
  });
  assert.deepEqual((await scanJavaScript(files, { paths: ["apps/a"] })).map((r) => r.path), ["apps/a"]);
  assert.deepEqual((await scanJavaScript(files, { ignorePaths: ["experiments"] })).map((r) => r.path).sort(), ["apps/a", "apps/b"]);
});

const CARGO_LOCK = `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "core",
 "serde",
 "tokio 1.53.1",
]

[[package]]
name = "core"
version = "0.3.0"
dependencies = ["tokio 1.40.0"]

[[package]]
name = "serde"
version = "1.0.229"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tokio"
version = "1.40.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tokio"
version = "1.53.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

test("Cargo.lock resolves through the consumer's own dependency list (multiple versions)", () => {
  const lock = parseCargoLock(CARGO_LOCK);
  assert.equal(lock.resolve("app", "0.1.0", "tokio")?.version, "1.53.1");
  assert.equal(lock.resolve("core", "0.3.0", "tokio")?.version, "1.40.0");
  assert.equal(lock.resolve("app", "0.1.0", "serde")?.version, "1.0.229");
  assert.equal(lock.resolve("unknown-crate", null, "serde"), null, "a lockfile that does not cover the consumer resolves nothing");
});

test("Cargo workspace inheritance, renames, optional, dev and target-specific deps", async () => {
  const roots = await scanRust(
    repo({
      "Cargo.toml": `[workspace]
members = ["crates/*"]
exclude = ["crates/skip"]

[workspace.package]
version = "0.1.0"

[workspace.dependencies]
tokio = { version = "1", features = ["rt"] }
serde = "1"
core = { path = "crates/core", version = "0.3.0" }
`,
      "crates/app/Cargo.toml": `[package]
name = "app"
version.workspace = true

[dependencies]
tokio = { workspace = true, features = ["macros"] }
serde.workspace = true
core = { workspace = true }
renamed = { package = "serde_json", version = "1.0", optional = true }
gitdep = { git = "https://github.com/x/y", rev = "abc123" }

[dev-dependencies]
pretty = "0.2"

[target.'cfg(unix)'.dependencies]
libc = "0.2"
`,
      "crates/core/Cargo.toml": `[package]
name = "core"
version = "0.3.0"
`,
      "crates/skip/Cargo.toml": `[package]
name = "skip"
version = "0.0.1"

[dependencies]
serde = "1"
`,
      "Cargo.lock": CARGO_LOCK,
    }),
    {},
  );
  const app = roots.find((r) => r.name === "app")!;
  const d = (n: string) => app.deps.find((x) => x.name === n)!;
  assert.equal(app.lockfile, "Cargo.lock");
  assert.equal(d("tokio").declared, "1", "inherited from [workspace.dependencies]");
  assert.equal(d("tokio").resolved, "1.53.1");
  assert.equal(d("serde").resolved, "1.0.229");
  assert.equal(d("core").source, "path");
  assert.equal(d("serde_json").optional, true, "renamed via package =");
  assert.equal(d("gitdep").source, "git");
  assert.equal(d("gitdep").revision, "https://github.com/x/y#abc123");
  assert.equal(d("pretty").kind, "devDependencies");
  assert.ok(d("libc"), "target-specific dependencies are included");

  const skip = roots.find((r) => r.name === "skip")!;
  assert.equal(skip.lockfile, null, "excluded crate does not use the workspace lockfile");
  assert.equal(skip.deps[0]!.resolved, null);
  assert.equal(roots.some((r) => r.path === "."), false, "virtual workspace manifest is not an installation");
});

test("workspace membership globs", () => {
  assert.equal(isWorkspaceMember("crates/a", ".", { members: ["crates/*"] }), true);
  assert.equal(isWorkspaceMember("examples/x", ".", { members: ["crates/*"] }), false);
  assert.equal(isWorkspaceMember("crates/a", ".", { members: ["./crates/a"] }), true);
  assert.equal(isWorkspaceMember("crates/a", ".", { members: ["crates/*"], exclude: ["crates/a"] }), false);
});
