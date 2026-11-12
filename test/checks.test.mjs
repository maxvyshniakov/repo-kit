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

test("with REPO_KIT_CHECKS_JUNIT, repo-kit checks writes one JUnit testcase per check with its time", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "checks-junit-")), "nested/checks.xml");
  const { status } = spawnSync(process.execPath, [cli, "checks"], {
    encoding: "utf8",
    env: { ...process.env, REPO_KIT_CHECKS_JUNIT: file, REPO_KIT_CHECKS: JSON.stringify([{ name: "stories & <more>\u0007", run: "true" }, { name: "keyboard", run: "exit 2" }]) },
  });
  assert.equal(status, 1);
  const xml = fs.readFileSync(file, "utf8");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites>\n<testsuite name="repo-kit checks" tests="2" failures="1" time="[\d.]+">\n/);
  assert.match(xml, /<testcase classname="repo-kit checks" name="stories &amp; &lt;more&gt;" time="[\d.]+"\/>\n/);
  assert.match(xml, /<testcase classname="repo-kit checks" name="keyboard" time="[\d.]+"><failure message="exit 2"\/><\/testcase>\n/);
});
