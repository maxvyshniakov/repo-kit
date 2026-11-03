import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { syncHooks } from "../src/hooks.mjs";
import { cleanEnvironment, commitsToVerify, readVerified, verifyCommand } from "../src/pre-push.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const sha = digit => digit.repeat(40);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("the pre-push hook verifies each pushed commit once, as a release for main", () => {
  const stdin = [
    `refs/heads/main ${sha("a")} refs/heads/main ${sha("0")}`,
    `refs/heads/feature ${sha("b")} refs/heads/feature ${sha("c")}`,
    `refs/heads/also-main ${sha("a")} refs/heads/other ${sha("c")}`,
    `(delete) ${sha("0")} refs/heads/gone ${sha("d")}`,
    `refs/tags/v1 ${sha("e")} refs/tags/v1 ${sha("0")}`,
    "",
  ].join("\n");
  assert.deepEqual(commitsToVerify(stdin), [
    { sha: sha("a"), release: true },
    { sha: sha("b"), release: false },
  ]);
  assert.deepEqual(commitsToVerify(""), []);
});

test("Git's hook variables do not reach the temporary worktree", () => {
  const env = cleanEnvironment({ GIT_DIR: "/x", GIT_INDEX_FILE: "/i", GIT_QUARANTINE_PATH: "/q", GIT_AUTHOR_NAME: "kept", PATH: "/bin" });
  assert.deepEqual(env, { GIT_AUTHOR_NAME: "kept", PATH: "/bin" });
});

test("commits recorded by the earlier copies of the hook count as verified", () => {
  const repository = tempRepository({
    "sid-kit-verified": `${sha("a")} release\n`,
    "verified-commits": `${sha("b")}\n`,
    "repo-kit-verified": `${sha("c")}\n`,
  });
  try {
    assert.deepEqual([...readVerified(repository.root)].sort(), [`${sha("a")} release`, sha("b"), sha("c")]);
  } finally {
    repository.cleanup();
  }
});

test("a commit verifies with its own verify script, an older scripts/verify.mjs, or not at all", () => {
  const modern = tempRepository({ "package.json": { scripts: { verify: "repo-kit verify" } } });
  const older = tempRepository({ "package.json": { scripts: {} }, "scripts/verify.mjs": "" });
  const none = tempRepository({ "package.json": {} });
  try {
    assert.deepEqual(verifyCommand(modern.root, true), ["bun", ["run", "verify", "--", "--release"]]);
    assert.deepEqual(verifyCommand(modern.root, false), ["bun", ["run", "verify"]]);
    assert.deepEqual(verifyCommand(older.root, true), ["node", ["scripts/verify.mjs", "--release"]]);
    assert.equal(verifyCommand(none.root, false), undefined);
  } finally {
    for (const repository of [modern, older, none]) repository.cleanup();
  }
});

// A repository with repo-kit linked into node_modules and its synced hooks; the
// tracked hook runs against fake bun, gh and slotfather that log what they see.
function pushFixture({ slotfather = true, lease = "", exit = "0", release = false, token, ghToken, bunVersion = "1.4.4", historical = false } = {}) {
  const repository = tempRepository({
    "package.json": historical
      ? { name: "@maxvyshniakov/example", version: "0.1.0", scripts: {} }
      : { name: "@maxvyshniakov/example", version: "0.1.0", scripts: { verify: "repo-kit verify" } },
    ...(historical ? { "scripts/verify.mjs": "" } : {}),
    "repo-kit.config.mjs": "export default { prePush: { slots: 3 } };\n",
  });
  const { root } = repository;
  const log = path.join(root, ".probe.log");
  const bin = path.join(root, ".bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "node_modules/@maxvyshniakov"), { recursive: true });
  fs.symlinkSync(kitRoot, path.join(root, "node_modules/@maxvyshniakov/repo-kit"));
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n.bin\n.probe.log\n");
  const { log: print } = console;
  console.log = () => {};
  try {
    syncHooks(root);
  } finally {
    console.log = print;
  }
  const executable = (name, text) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  executable("node", `case "$1" in */scripts/verify.mjs|scripts/verify.mjs) shift; printf "verify:node:%s:%s\\n" "$*" "$SLOTFATHER_LEASE" >> ${quote(log)}; exit $VERIFY_EXIT_CODE;; esac
exec ${quote(process.execPath)} "$@"`);
  executable("bun", `case "$1" in
  --version) echo ${bunVersion} ;;
  install) printf "install:%s:%s\\n" "$SLOTFATHER_LEASE" "$GITHUB_TOKEN" >> ${quote(log)} ;;
  run) shift; printf "verify:bun:%s:%s\\n" "$*" "$SLOTFATHER_LEASE" >> ${quote(log)}; exit $VERIFY_EXIT_CODE ;;
esac`);
  if (ghToken) executable("gh", `echo ${ghToken}`);
  if (slotfather) executable("slotfather", `printf "slot:%s\\n" "$*" >> ${quote(log)}
while [ "$1" != "--" ]; do shift; done
shift
export SLOTFATHER_LEASE=fixture-lease SLOTFATHER_COUNT=3
exec "$@"`);
  repository.git("init", "--quiet", "-b", "dev");
  repository.git("add", "-A");
  repository.git("commit", "--quiet", "-m", "fixture");
  const head = repository.git("rev-parse", "HEAD");
  const env = { ...repository.env, PATH: `${bin}:/usr/bin:/bin`, SLOTFATHER_LEASE: lease, VERIFY_EXIT_CODE: exit, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };
  delete env.GITHUB_TOKEN;
  if (token) env.GITHUB_TOKEN = token;
  const run = (input = `refs/heads/lane ${head} refs/heads/${release ? "main" : "dev"} ${sha("0")}\n`) => {
    const result = spawnSync("sh", [path.join(root, ".githooks/pre-push"), "origin", "unused"], { cwd: root, env, encoding: "utf8", input });
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    fs.rmSync(log, { force: true });
    return { result, lines };
  };
  return { ...repository, head, run };
}

for (const release of [false, true]) {
  test(`the tracked pre-push hook leases once for install and verify (release=${release})`, () => {
    const fixture = pushFixture({ release, token: "env-token" });
    try {
      const { result, lines } = fixture.run();
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(lines.filter(line => line.startsWith("slot:")).length, 1);
      assert.match(lines[0], /^slot:run -n 3 --label /);
      assert.ok(lines.includes("install:fixture-lease:env-token"), lines.join("\n"));
      assert.ok(lines.includes(`verify:bun:verify${release ? " -- --release" : ""}:fixture-lease`), lines.join("\n"));
      // The second push of the same commit has nothing left to verify.
      const again = fixture.run();
      assert.equal(again.result.status, 0);
      assert.match(again.result.stdout, /already passed bun run verify/);
      assert.ok(!again.lines.some(line => line.startsWith("install:")));
    } finally {
      fixture.cleanup();
    }
  });
}

test("an inherited lease reaches install and verify without another lease", () => {
  const fixture = pushFixture({ lease: "outer-lease", token: "t" });
  try {
    const { result, lines } = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines.some(line => line.startsWith("slot:")), false);
    assert.ok(lines.includes("install:outer-lease:t"));
  } finally {
    fixture.cleanup();
  }
});

test("without GITHUB_TOKEN the hook installs with gh auth token", () => {
  const fixture = pushFixture({ ghToken: "gh-token" });
  try {
    const { result, lines } = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GITHUB_TOKEN unset; installing with gh auth token/);
    assert.ok(lines.includes("install:fixture-lease:gh-token"), lines.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("CI without slotfather runs directly, and a failed verify names the token when none was found", () => {
  const fixture = pushFixture({ slotfather: false, exit: "7" });
  try {
    const { result, lines } = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GITHUB_TOKEN is unset and gh has no token/);
    assert.match(result.stderr, /failed on [0-9a-f]{10}; nothing was pushed/);
    assert.match(result.stderr, /export GITHUB_TOKEN=\$\(gh auth token\)/);
    assert.equal(lines.some(line => line.startsWith("slot:")), false);
    assert.ok(lines.includes("install::"));
  } finally {
    fixture.cleanup();
  }
});

test("a commit from before the kit runs its own scripts/verify.mjs", () => {
  const fixture = pushFixture({ historical: true, release: true, token: "t" });
  try {
    const { result, lines } = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lines.includes("verify:node:--release:fixture-lease"), lines.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("a Bun older than 1.4.4 refuses the push before any install", () => {
  const fixture = pushFixture({ bunVersion: "1.3.14", token: "t" });
  try {
    const { result, lines } = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bun 1.3.14 predates 1.4.4/);
    assert.ok(!lines.some(line => line.startsWith("install:")));
  } finally {
    fixture.cleanup();
  }
});

test("a checkout without repo-kit installed refuses the push", () => {
  const fixture = pushFixture({ token: "t" });
  try {
    fs.rmSync(path.join(fixture.root, "node_modules"), { recursive: true });
    const { result } = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /repo-kit is not installed; run bun install/);
  } finally {
    fixture.cleanup();
  }
});

test("a linked worktree without node_modules uses the main checkout's repo-kit", () => {
  const fixture = pushFixture({ token: "t" });
  const worktree = `${fixture.root}-worktree`;
  try {
    fixture.git("worktree", "add", "--quiet", "--detach", worktree);
    const result = spawnSync("sh", [path.join(worktree, ".githooks/pre-push"), "origin", "unused"], {
      cwd: worktree, encoding: "utf8", input: "",
      env: { ...fixture.env, PATH: `${path.join(fixture.root, ".bin")}:/usr/bin:/bin`, SLOTFATHER_LEASE: "x" },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fixture.git("worktree", "remove", "--force", worktree);
    fixture.cleanup();
  }
});
