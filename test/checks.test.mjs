import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { parseChecks } from "../src/checks.mjs";
import { kitRoot } from "./fixtures.mjs";

const cli = path.join(kitRoot, "src/cli.mjs");
const checks = list => spawnSync(process.execPath, [cli, "checks"], { encoding: "utf8", env: { ...process.env, REPO_KIT_CHECKS: JSON.stringify(list) } });

test("repo-kit checks runs every check in order, after a failure too, and fails naming the failed ones", () => {
  const { status, stdout, stderr } = checks([
    { name: "browser", run: "echo browser ran; exit 3" },
    { name: "stories", run: "echo stories ran" },
    { name: "keyboard", run: "exit 1" },
  ]);
  assert.equal(status, 1, stdout + stderr);
  assert.ok(stdout.indexOf("browser ran") < stdout.indexOf("stories ran"), stdout);
  assert.match(stdout, /\nchecks:\n {2}FAIL browser \(exit 3, [\d.]+s\)\n {2}ok {3}stories \([\d.]+s\)\n {2}FAIL keyboard \(exit 1, [\d.]+s\)\n/);
  assert.match(stderr, /checks failed: browser, keyboard/);
});

test("repo-kit checks passes when every check does", () => {
  const { status, stdout } = checks([{ name: "stories", run: "true" }]);
  assert.equal(status, 0);
  assert.match(stdout, /ok {3}stories/);
});

test("the checks list is JSON of {name, run}", () => {
  assert.deepEqual(parseChecks('[{"name": "a", "run": "true"}]'), [{ name: "a", run: "true" }]);
  assert.throws(() => parseChecks(""), /REPO_KIT_CHECKS/);
  assert.throws(() => parseChecks("[]"), /at least one/);
  assert.throws(() => parseChecks('[{"name": "a"}]'), /name and a run/);
  assert.throws(() => parseChecks("{"), /not JSON/);
});
