import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { perfBudget } from "../src/perf-budget.mjs";
import { callsPerfHelper, globRegExp, runTestHygiene, sleepFindings, timingFindings, uiFindings } from "../src/test-hygiene.mjs";
import { isolatedGitEnv, kitRoot } from "./fixtures.mjs";

const lines = list => list.map(({ line }) => line);

test("fixed sleeps in JavaScript tests: waitForTimeout, setTimeout promises and sleep helpers of 50 ms or more", () => {
  const text = [
    "await page.waitForTimeout(500);",
    "await new Promise(resolve => setTimeout(resolve, 100));",
    "await new Promise(r => setTimeout(() => r(), 250));",
    "await new Promise(resolve => setTimeout(resolve, 10));", // a tick, not a wait
    "await sleep(200);",
    "await Bun.sleep(1000);",
    "const label = 'waitForTimeout(500)';", // a string
    "// await page.waitForTimeout(500);", // a comment
    "await page.waitForTimeout(500); // sleep-ok: the animation has no end event",
    "// sleep-ok: the server offers no ready signal",
    "await sleep(300);",
    "await waitFor(() => ready());",
    "await page.waitForTimeout(TIMEOUT);", // a fixed wait whatever its argument
    "await new Promise(resolve => setTimeout(resolve, DELAY));",
    "const timer = setTimeout(onTimeout, 1000);", // a timer under test, not a wait
  ].join("\n");
  assert.deepEqual(lines(sleepFindings("src/a.test.ts", text)), [1, 2, 3, 5, 6, 13, 14]);
});

test("fixed sleeps in Python, Swift and Rust tests", () => {
  assert.deepEqual(lines(sleepFindings("tests/test_x.py", "time.sleep(1.2)\ntime.sleep(0.05)\nawait asyncio.sleep(0.5)\nsleep(2)\ntime.sleep(interval)\npage.wait_for_timeout(500)\n")), [1, 3, 4, 6]);
  assert.deepEqual(lines(sleepFindings("Tests/HudTests.swift", "runMain(for: 0.1)\nThread.sleep(forTimeInterval: 1)\nusleep(1000)\ntry await Task.sleep(nanoseconds: 1)\nlet x = 1\ntry await clock.sleep(for: .seconds(1))\n")), [1, 2, 3, 4]);
  assert.deepEqual(lines(sleepFindings("tests/a_tests.rs", "std::thread::sleep(Duration::from_millis(5));\nlet d = Duration::from_secs(1);\n")), [1]);
});

test("timing assertions: a measured duration bounded from above below 30 s", () => {
  const js = [
    "const started = Date.now();",
    "run();",
    "assert.ok(Date.now() - started < 2000);",
    "const elapsed = performance.now() - t0;",
    "expect(elapsed).toBeLessThan(100);",
    "assert.ok(elapsed < 30_000, 'a deadline for a hang');",
    "// load-tolerant: the wait ends on an event; 5 s only catches a hang",
    "assert.ok(elapsed < 5000);",
    "perfBudget(elapsed < 100, 'render');",
    "assert.equal(samples.length, 3);",
    "assert.match(stdout, /  stop lint \\(/);", // an escaped parenthesis does not open a long window
    "const later = 1;",
    "if (elapsed < 5) later();",
    "expect(elapsed).to.be.below(50);",
  ].join("\n");
  assert.deepEqual(lines(timingFindings("test/a.test.mjs", js)), [3, 5, 14]);

  const py = [
    "start = time.monotonic()",
    "elapsed = time.monotonic() - start",
    "self.assertLess(elapsed, 0.2)",
    "assert elapsed < 60",
    "deadline = time.monotonic() + 5",
    "assert time.monotonic() < deadline",
    "perf_budget(elapsed < 0.1, 'tick')",
  ].join("\n");
  assert.deepEqual(lines(timingFindings("tests/test_x.py", py)), [3, 6]);
  assert.deepEqual(timingFindings("tests/test_y.py", "assert 1 < 2\n"), [], "no clock, nothing measured");
});

test("a file calling the perf helper, not only defining it", () => {
  assert.ok(callsPerfHelper("test/a.test.mjs", "perfBudget(elapsed < 5, 'x');\n"));
  assert.ok(!callsPerfHelper("test/a.test.mjs", "export function perfBudget(holds, message) {}\n"));
  assert.ok(callsPerfHelper("tests/test_a.py", "def perf_budget(holds, message):\n    pass\nperf_budget(x < 1, 'y')\n"));
});

test("UI assertions: class names and CSS text, not roles, data attributes or states", () => {
  const text = [
    "expect(button).toHaveClass('rounded-xl');",
    "expect(node.className).toContain('before:bg-transparent');",
    "expect(css).toContain('background-color: var(--fill-intent);');",
    "expect(button).toHaveAttribute('data-state', 'on');",
    "expect(screen.getByRole('button')).toBeDisabled();",
    "const style = 'color: red;';",
    "assert.deepEqual(warnings, ['badge--default: the page is 390104px tall; the picture covers it']);",
    "expect(message).toContain('warning: deprecated; use x');",
    "expect(screen.getByRole('tab').className).toContain('active');",
  ].join("\n");
  assert.deepEqual(lines(uiFindings("src/__tests__/button.test.tsx", text)), [1, 2, 3, 9]);
  assert.deepEqual(uiFindings("tests/test_a.py", "assert 'color: red;' in css\n"), [], "JavaScript tests only");
});

test("globs: ** spans directories, * one segment, braces alternatives", () => {
  assert.ok(globRegExp("**/*.test.{ts,tsx}").test("a.test.ts"));
  assert.ok(globRegExp("**/*.test.{ts,tsx}").test("packages/x/src/a.test.tsx"));
  assert.ok(!globRegExp("test/*.mjs").test("test/sub/a.mjs"));
  assert.ok(globRegExp("test/**/*.mjs").test("test/a.mjs"));
  assert.ok(!globRegExp("**/*.test.ts").test("a.test.tsx"));
});

test("perfBudget reports outside the perf suite and fails inside it", () => {
  const warnings = [];
  const warn = message => warnings.push(message);
  assert.doesNotThrow(() => perfBudget(false, "render under 16 ms", { env: {}, warn }));
  assert.match(warnings[0], /perf budget missed \(not enforced outside the perf suite\): render under 16 ms/);
  assert.throws(() => perfBudget(false, "render under 16 ms", { env: { REPO_KIT_PERF_BUDGETS: "enforce" }, warn }), /perf budget missed: render under 16 ms/);
  assert.doesNotThrow(() => perfBudget(true, "fine", { env: { REPO_KIT_PERF_BUDGETS: "enforce" }, warn }));
});

function repository(files, config = "export default {};\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-hygiene-"));
  const env = isolatedGitEnv();
  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  if (config !== null) fs.writeFileSync(path.join(root, "repo-kit.config.mjs"), config);
  write(root, files);
  return { root, git, commit: () => { git("add", "-A"); git("commit", "-q", "-m", "change"); } };
}

function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) { fs.rmSync(path.join(root, file)); continue; }
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

function run(root, args = [], config = {}) {
  const out = [], err = [];
  const code = runTestHygiene({ root, config, args, print: line => out.push(line), printError: line => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const sleepy = n => Array.from({ length: n }, () => "await page.waitForTimeout(500);").join("\n") + "\n";

test("--init records today's counts; the check then passes and the baseline only shrinks", () => {
  const repo = repository({ "test/a.test.mjs": sleepy(2), "test/b.test.mjs": "assert.ok(true);\n" });
  const first = run(repo.root, ["--init"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /wrote test-hygiene-baseline\.json with 2 findings/);
  const baseline = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8"));
  assert.deepEqual(baseline, { version: 1, rules: { "fixed-sleep": { "test/a.test.mjs": 2 }, "timing-assert": {} } });
  repo.commit();
  assert.equal(run(repo.root).code, 0);
  assert.equal(run(repo.root, ["--init"]).code, 1, "--init never overwrites");

  // A new sleep in a listed file or in a new file fails, naming the lines.
  write(repo.root, { "test/a.test.mjs": sleepy(3), "test/c.test.mjs": sleepy(1) });
  const grown = run(repo.root);
  assert.equal(grown.code, 1);
  assert.match(grown.err, /fixed-sleep in test\/a\.test\.mjs: 3 findings, baseline allows 2/);
  assert.match(grown.err, /test\/c\.test\.mjs:1: await page\.waitForTimeout\(500\);/);
  assert.match(grown.err, /sleep-ok: <reason>/);

  // A removed sleep must be taken out of the baseline too.
  write(repo.root, { "test/a.test.mjs": sleepy(1), "test/c.test.mjs": null });
  const stale = run(repo.root);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /fixed-sleep in test\/a\.test\.mjs went down to 1 \(baseline 2\); run repo-kit test-hygiene --update/);
  const updated = run(repo.root, ["--update"]);
  assert.equal(updated.code, 0, updated.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8")).rules["fixed-sleep"], { "test/a.test.mjs": 1 });
  assert.equal(run(repo.root).code, 0);
});

test("--update never raises an entry, and a baseline raised against HEAD fails", () => {
  const repo = repository({ "test/a.test.mjs": sleepy(1) });
  run(repo.root, ["--init"]);
  repo.commit();
  write(repo.root, { "test/a.test.mjs": sleepy(2) });
  assert.equal(run(repo.root, ["--update"]).code, 1, "growth still fails");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8")).rules["fixed-sleep"]["test/a.test.mjs"], 1);
  write(repo.root, { "test-hygiene-baseline.json": JSON.stringify({ version: 1, rules: { "fixed-sleep": { "test/a.test.mjs": 2 }, "timing-assert": {} } }) });
  const raised = run(repo.root);
  assert.equal(raised.code, 1);
  assert.match(raised.err, /raises fixed-sleep for test\/a\.test\.mjs to 2 \(the base has 1\); the baseline may only shrink/);
});

test("a raw timing assertion counts in the perf suite too; a perf-helper caller outside it fails", () => {
  const raw = "const t = Date.now();\nassert.ok(Date.now() - t < 100);\n";
  const helper = "const t = Date.now();\nperfBudget(Date.now() - t < 100, 'render');\n";
  const repo = repository({ "test/perf/raw.test.mjs": raw, "test/perf/render.test.mjs": helper, "test/a.test.mjs": helper });
  const result = run(repo.root, ["--init"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /test\/a\.test\.mjs states a perf budget .* not in the perf suite/);
  assert.doesNotMatch(result.err, /render\.test\.mjs/);
  const baseline = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8"));
  // Only the helper exempts an assertion: a budget holds through it in the perf suite.
  assert.deepEqual(baseline.rules["timing-assert"], { "test/perf/raw.test.mjs": 1 });
});

test("a raise committed on a branch fails against where it left main; a renamed file keeps its count", () => {
  const repo = repository({ "test/a.test.mjs": sleepy(1) });
  run(repo.root, ["--init"]);
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "-q", "-c", "topic");
  write(repo.root, { "test/a.test.mjs": sleepy(2), "test-hygiene-baseline.json": JSON.stringify({ version: 1, rules: { "fixed-sleep": { "test/a.test.mjs": 2 }, "timing-assert": {} } }) });
  repo.commit();
  const raised = run(repo.root);
  assert.equal(raised.code, 1, "HEAD holds the raise; the base does not");
  assert.match(raised.err, /raises fixed-sleep for test\/a\.test\.mjs to 2 \(the base has 1\)/);

  // Moving test/a to test/b moves its entry; no count rises.
  repo.git("reset", "-q", "--hard", "origin/main");
  repo.git("mv", "test/a.test.mjs", "test/b.test.mjs");
  write(repo.root, { "test-hygiene-baseline.json": JSON.stringify({ version: 1, rules: { "fixed-sleep": { "test/b.test.mjs": 1 }, "timing-assert": {} } }) });
  repo.commit();
  const moved = run(repo.root);
  assert.equal(moved.code, 0, moved.err);
  // On main itself the base is HEAD's parent.
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(run(repo.root).code, 0);
});

test("a broken repo-kit.config.mjs fails the command instead of falling back to the defaults", () => {
  const repo = repository({ "test/a.test.mjs": "ok\n" }, "export default {;\n");
  const result = spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "test-hygiene"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError|Unexpected/);
});

test("UI assertions are opt-in", () => {
  const repo = repository({ "src/__tests__/button.test.tsx": "expect(b).toHaveClass('x');\n" });
  run(repo.root, ["--init"], { testHygiene: { ui: true } });
  const baseline = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8"));
  assert.deepEqual(baseline.rules["ui-assertion"], { "src/__tests__/button.test.tsx": 1 });
  const other = repository({ "src/__tests__/button.test.tsx": "expect(b).toHaveClass('x');\n" });
  run(other.root, ["--init"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other.root, "test-hygiene-baseline.json"), "utf8")).rules["ui-assertion"], undefined);
});

test("repo-kit test-hygiene runs in a repository without repo-kit.config.mjs, as a Python one", () => {
  const repo = repository({ "tests/test_a.py": "import time\ntime.sleep(1)\n" }, null);
  const cli = path.join(kitRoot, "src/cli.mjs");
  const init = spawnSync(process.execPath, [cli, "test-hygiene", "--init"], { cwd: path.join(repo.root, "tests"), encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(repo.root, "test-hygiene-baseline.json")));
  write(repo.root, { "tests/test_b.py": "import time\ntime.sleep(2)\n" });
  const check = spawnSync(process.execPath, [cli, "test-hygiene"], { cwd: repo.root, encoding: "utf8" });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /tests\/test_b\.py:2: time\.sleep\(2\)/);
});
