import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { KIT_VERSION, kitIssues, kitReferences, packageManagerIssues, workflowIssues } from "../src/check.mjs";
import { leasedCommand } from "../src/heavy.mjs";
import { hookIssues, hookStatus, installHooks, managedHooks, REFERENCE_TRANSACTION_SHA256, sha256, syncHooks } from "../src/hooks.mjs";
import { bunTooOld, BUN_VERSION, resolveToken } from "../src/token.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const quietly = fn => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn });
  }
};

test("repo-kit's own repository passes repo-kit check", () => {
  assert.deepEqual(kitIssues(kitRoot), []);
});

test("the reference-transaction copy is Straylight's, pinned by hash", () => {
  assert.equal(sha256(fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"))), REFERENCE_TRANSACTION_SHA256);
  assert.match(managedHooks()["reference-transaction"], /^#!\/usr\/bin\/env bash\n# One writer for main and dev/);
});

test("hooks sync writes executable managed hooks that hooks check accepts, and leaves the repository's own", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" }, ".githooks/pre-commit": "#!/bin/sh\nexit 0\n" });
  try {
    assert.match(hookIssues(repository.root).join("\n"), /\.githooks\/pre-push is missing; run repo-kit hooks sync/);
    quietly(() => syncHooks(repository.root));
    assert.deepEqual(hookIssues(repository.root), []);
    for (const name of ["pre-push", "reference-transaction"]) assert.ok(fs.statSync(path.join(repository.root, ".githooks", name)).mode & 0o111, name);
    assert.equal(fs.readFileSync(path.join(repository.root, ".githooks/pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
    fs.appendFileSync(path.join(repository.root, ".githooks/reference-transaction"), "# local edit\n");
    assert.match(hookIssues(repository.root).join("\n"), /\.githooks\/reference-transaction differs from repo-kit's/);
  } finally {
    repository.cleanup();
  }
});

test("the pre-push shim runs the installed repo-kit, or the sources in repo-kit itself", () => {
  assert.match(managedHooks()["pre-push"], /node_modules\/@maxvyshniakov\/repo-kit\/src\/cli\.mjs/);
  assert.match(managedHooks({ self: true })["pre-push"], /cli="\$root\/src\/cli\.mjs"/);
  assert.equal(fs.readFileSync(path.join(kitRoot, ".githooks/pre-push"), "utf8"), managedHooks({ self: true })["pre-push"]);
});

test("hooks install points core.hooksPath at .githooks once, keeps a deliberate one, and skips CI", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" } }, { git: true });
  try {
    installHooks(repository.root, { CI: "true" });
    assert.throws(() => repository.git("config", "--get", "core.hooksPath"));
    quietly(() => installHooks(repository.root, {}));
    assert.equal(repository.git("config", "--get", "core.hooksPath"), ".githooks");
    repository.git("config", "core.hooksPath", "custom");
    quietly(() => installHooks(repository.root, {}));
    assert.equal(repository.git("config", "--get", "core.hooksPath"), "custom");
  } finally {
    repository.cleanup();
  }
});

test("hooks status reports a tracked hook Git would not run", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" } }, { git: true });
  try {
    quietly(() => syncHooks(repository.root));
    assert.match(hookStatus(repository.root).join("\n"), /pre-push: .* is not the tracked \.githooks\/pre-push/);
    repository.git("config", "core.hooksPath", ".githooks");
    assert.deepEqual(hookStatus(repository.root), []);
  } finally {
    repository.cleanup();
  }
});

test("repo-kit references in workflows must name the installed version", () => {
  const text = `jobs:
  check:
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.1.0
    steps:
      - uses: maxvyshniakov/repo-kit/actions/setup-bun@abc123
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
`;
  assert.deepEqual(kitReferences(text), [
    { target: ".github/workflows/verify.yml", ref: "v0.1.0", line: 3 },
    { target: "actions/setup-bun", ref: "abc123", line: 5 },
  ]);
  const repository = tempRepository({ "package.json": {}, ".github/workflows/check.yml": text });
  try {
    assert.deepEqual(workflowIssues(repository.root, "0.1.0"), [".github/workflows/check.yml:5: actions/setup-bun@abc123; the installed repo-kit is v0.1.0"]);
    assert.equal(workflowIssues(repository.root, "0.2.0").length, 2);
  } finally {
    repository.cleanup();
  }
});

test("packageManager must name the Bun the workflows run", () => {
  const repository = tempRepository({ "package.json": { packageManager: "bun@1.3.14" } });
  try {
    assert.deepEqual(packageManagerIssues(repository.root), [`package.json packageManager is bun@1.3.14; the workflows run bun@${BUN_VERSION}`]);
    fs.writeFileSync(path.join(repository.root, "package.json"), JSON.stringify({ packageManager: `bun@${BUN_VERSION}` }));
    assert.deepEqual(packageManagerIssues(repository.root), []);
    fs.writeFileSync(path.join(repository.root, "package.json"), "{}");
    assert.deepEqual(packageManagerIssues(repository.root), []);
  } finally {
    repository.cleanup();
  }
});

test("the kit version is package.json's", () => {
  assert.equal(KIT_VERSION, JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8")).version);
});

test("a heavy command leases once, and runs directly without slotfather", () => {
  assert.deepEqual(leasedCommand(2, ["bun", "run", "x"], { env: {}, cwd: "/repo/sid-kit", slotfather: true }), ["slotfather", "run", "-n", "2", "--label", "sid-kit", "--", "bun", "run", "x"]);
  assert.deepEqual(leasedCommand(2, ["bun"], { env: { SLOTFATHER_LEASE: "outer" }, cwd: "/repo", slotfather: true }), ["bun"]);
  assert.deepEqual(leasedCommand("all", ["bun"], { env: {}, cwd: "/repo", slotfather: false }), ["bun"]);
});

test("GITHUB_TOKEN wins over gh auth token, which fills in when it is unset", () => {
  assert.deepEqual(resolveToken({ GITHUB_TOKEN: "env" }, () => "gh"), { token: "env", source: "GITHUB_TOKEN" });
  assert.deepEqual(resolveToken({}, () => "gh"), { token: "gh", source: "gh auth token" });
  assert.deepEqual(resolveToken({}, () => undefined), { token: undefined });
});

test("Bun older than 1.4.4 is refused", () => {
  assert.match(bunTooOld("1.3.14"), /predates 1.4.4/);
  assert.equal(bunTooOld("1.4.4"), undefined);
  assert.equal(bunTooOld("1.10.0"), undefined);
  assert.equal(bunTooOld("1.4.5-canary.1"), undefined);
  assert.match(bunTooOld(undefined), /not on PATH/);
});
