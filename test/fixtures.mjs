// Temporary repositories for the tests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const kitRoot = fileURLToPath(new URL("..", import.meta.url));

export const changelog = `# @maxvyshniakov/example Changelog

Versions and release rules: [docs/VERSIONING.md](docs/VERSIONING.md).

## Unreleased

### Fixed

- Fixed a thing.

## 0.2.0 - 2026-09-20

### Breaking

- Breaking: removed a prop.

## 0.1.0 - 2026-09-01

- First release.
`;

export const isolatedGitEnv = () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const name of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(name)) delete env[name];
  return env;
};

/** A temporary directory with `files` ({ relative: contents }); removed by `cleanup()`. */
export function tempRepository(files = {}, { git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-test-")));
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  }
  const env = isolatedGitEnv();
  const run = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git) {
    run("init", "--quiet", "-b", "dev");
    run("add", "-A");
    run("commit", "--quiet", "--allow-empty", "-m", "fixture");
  }
  return { root, git: run, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A root-package repository (as Inline Measure) at version 0.2.0. */
export function rootPackageFiles(extra = {}) {
  return {
    "package.json": { name: "@maxvyshniakov/example", version: "0.2.0", type: "module" },
    "CHANGELOG.md": changelog,
    "repo-kit.config.mjs": "export default {};\n",
    ...extra,
  };
}

/** A workspace repository (as Sid-Kit) with packages/example at 0.2.0. */
export function workspaceFiles(extra = {}) {
  return {
    "package.json": { name: "example-workspace", private: true, workspaces: ["packages/*"] },
    "packages/example/package.json": { name: "@maxvyshniakov/example", version: "0.2.0", type: "module" },
    "packages/example/CHANGELOG.md": changelog,
    "bun.lock": `{
  "workspaces": {
    "": {
      "name": "example-workspace",
    },
    "packages/example": {
      "name": "@maxvyshniakov/example",
      "version": "0.2.0",
      "dependencies": {},
    },
  },
}
`,
    "docs/GETTING_STARTED.md": "bun add ./maxvyshniakov-example-0.2.0.tgz\n",
    "repo-kit.config.mjs": "export default {};\n",
    ...extra,
  };
}
