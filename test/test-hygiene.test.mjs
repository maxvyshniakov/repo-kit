import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserFixedSleepFindings,
  callsPerfHelper,
  classNameSplitFindings,
  computedStyleSpyFindings,
  cssFileReadFindings,
  globRegExp,
  inlineBrowserMockFindings,
  maskJs,
  parseHygieneArgs,
  resolveBaseCommit,
  runTestHygiene,
  sleepFindings,
  timingFindings,
  uiFindings,
  unfilteredConsoleSpyFindings,
} from "../src/test-hygiene.mjs";
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

test("UI assertions catch getAttribute('class') and .matches('.<class>') without flagging ARIA/data selectors", () => {
  const text = [
    'expect(node.getAttribute("class")).toContain("rounded");',
    "expect(node.getAttribute('class')).toMatch(/active/);",
    "expect(node.getAttribute(`class`)).toBe('primary');",
    'assert.ok(node?.getAttribute("class")?.includes("open"));',
    'expect(node.getAttribute?.("class")).toContain("rounded");',
    'expect(node.matches(".foo")).toBe(true);',
    "expect(node.matches('.btn-primary')).toBe(true);",
    'expect(node.matches?.(".foo")).toBe(true);',
    'assert.ok(node.matches("button.is-active"));',
    "assert.equal(node.matches('[role=\"button\"].is-open'), true);",
    'expect(node.matches(`.${cls}`)).toBe(true);',
    'expect(node.matches("." + cls)).toBe(true);',
    'expect(node.matches(\'[class~="rounded"]\')).toBe(true);',
    'expect(node.matches(\'[class*="active"]\')).toBe(true);',
    'expect(node.matches(".\\\\!hidden")).toBe(true);',
    'expect(node.getAttribute("aria-label")).toBe("Close");',
    "expect(node.getAttribute('data-state')).toBe('open');",
    'expect(node.getAttribute("data-class")).toBe("x");',
    'expect(node.matches("[role=\'button\']")).toBe(true);',
    'expect(node.matches("[data-state=\'open\']")).toBe(true);',
    'expect(node.matches("[data-url=\'example.com\']")).toBe(true);',
    'expect(node.matches("[data-class=\'x\']")).toBe(true);',
    'expect(node.matches(\'[data-path="items[0].name"]\')).toBe(true);',
    'expect(node.matches("#user\\\\.name")).toBe(true);',
    'expect(node.matches(`#${panel.id}`)).toBe(true);',
    'expect(node.matches(`[data-id="${items[0].id}"]`)).toBe(true);',
    'expect(node.matches(`[data-k="${`a.${b}`}"]`)).toBe(true);',
    'expect(node.matches(":focus-visible")).toBe(true);',
    '// expect(node.getAttribute("class")).toContain("foo");',
    'expect(node.matches("[role=\'button\']")).toBe(true); /* .matches(".btn") */',
    'expect(node.matches("[role=\'button\']")).toBe(true); // not .matches(".foo")',
    'expect(node.matches("[role=\'button\']")).toBe(true, \'replaces .matches(".btn")\');',
    'expect(msg).toContain(\'node.getAttribute("class")\');',
    'expect(msg).toContain(\'node.matches(".foo")\');',
    'const cls = node.getAttribute("class");',
    'const isCard = node.matches(".card");',
  ].join("\n");
  assert.deepEqual(
    lines(uiFindings("src/__tests__/evasion.test.tsx", text)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );

  // Linear-time scanning: adversarial backslash run completes immediately without catastrophic backtracking.
  const redosLine = `expect(node.matches("${"\\\\".repeat(28)}" + x)).toBe(true);`;
  const started = performance.now();
  assert.deepEqual(uiFindings("src/__tests__/redos.test.tsx", redosLine), []);
  // load-tolerant: guards against exponential ReDoS (multi-second hang vs <1 ms linear scan)
  assert.ok(performance.now() - started < 500, "linear scanner must not backtrack exponentially");
});

test("globs: ** spans directories, * one segment, braces alternatives", () => {
  assert.ok(globRegExp("**/*.test.{ts,tsx}").test("a.test.ts"));
  assert.ok(globRegExp("**/*.test.{ts,tsx}").test("packages/x/src/a.test.tsx"));
  assert.ok(!globRegExp("test/*.mjs").test("test/sub/a.mjs"));
  assert.ok(globRegExp("test/**/*.mjs").test("test/a.mjs"));
  assert.ok(!globRegExp("**/*.test.ts").test("a.test.tsx"));
});

function repository(files, config = "export default {};\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-hygiene-"));
  const env = isolatedGitEnv();
  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  if (config !== null) fs.writeFileSync(path.join(root, "package-kit.config.mjs"), config);
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
  assert.match(stale.err, /fixed-sleep in test\/a\.test\.mjs went down to 1 \(baseline 2\); run package-kit test-hygiene --update/);
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

test("a broken package-kit.config.mjs fails the command instead of falling back to the defaults", () => {
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

test("package-kit test-hygiene runs in a repository without package-kit.config.mjs, as a Python one", () => {
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

test("maskJs preserves exact length/newlines across JSX apostrophes, templates, comments and division vs regex", () => {
  const src = [
    "const jsx = <p>Don't break / the rest</p>;",
    "const half = width! / 2 + count++ / 2 + obj.return / 2;",
    "const fn = () => /foo\\/bar/gi;",
    "const tpl = `hello ${el.className.split(' ')} world`;",
    "// el.className.split(' ')",
    "/* multi\nline */ el.className.split(' ');",
  ].join("\n");
  const { noComments, codeOnly } = maskJs(src);
  assert.equal(noComments.length, src.length);
  assert.equal(codeOnly.length, src.length);
  assert.equal(noComments.split("\n").length, src.split("\n").length);
  assert.equal(codeOnly.split("\n").length, src.split("\n").length);
  assert.doesNotMatch(noComments, /multi/);
  assert.match(codeOnly, /el\.className\.split/);
  assert.equal(lines(classNameSplitFindings(src, { noComments, codeOnly })).length, 2);
});

test("classname-split catches direct, optional, trimmed and fallback splits while ignoring comments and strings", () => {
  const text = [
    'const parts = el.className.split(" ");',
    'const trimmed = el?.className?.trim().split(/\\s+/);',
    'const fb = (el.className ?? "").split(" ");',
    "const fb2 = (el.className || '').trim().split(' ');",
    'const ok = label.split(" ");',
    '// el.className.split(" ");',
    'const s = "el.className.split(\' \')";',
  ].join("\n");
  assert.deepEqual(lines(classNameSplitFindings(text)), [1, 2, 3, 4]);
});

test("css-file-read catches direct reads, tracked variables, loops, helpers and readDataGridCss()", () => {
  const text = [
    'const a = readFileSync("src/tokens.css", "utf8");',
    'const cssPath = path.join(dir, "theme.css");',
    'const b = readFileSync(cssPath, "utf8");',
    'const json = readFileSync("package.json", "utf8");',
    'const cssFiles = readdirSync(dir).filter(f => f.endsWith(".css"));',
    'for (const f of cssFiles) { readFileSync(f, "utf8"); }',
    'cssFiles.map(f => readFileSync(f, "utf8"));',
    'const loadFile = p => readFileSync(p, "utf8");',
    'const c = loadFile("styles/base.css");',
    'const d = loadFile("README.md");',
    'const e = readDataGridCss();',
    'function readDataGridCss() { return ""; }',
  ].join("\n");
  assert.deepEqual(lines(cssFileReadFindings(text)), [1, 3, 6, 7, 9, 11]);
});

test("unasserted-computed-style-spy flags unasserted or zero-call spies and allows positive assertions", () => {
  const text = [
    'describe("a", () => {',
    '  it("unasserted", () => {',
    '    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({} as CSSStyleDeclaration);',
    '    expect(true).toBe(true);',
    '  });',
    '  it("negated only", () => {',
    '    const spy = vi.spyOn(globalThis, "getComputedStyle");',
    '    expect(spy).not.toHaveBeenCalled();',
    '  });',
    '  it("zero times", () => {',
    '    const spy = vi.spyOn(window, "getComputedStyle");',
    '    expect(spy).toHaveBeenCalledTimes(0);',
    '  });',
    '  it("positive toHaveBeenCalled", () => {',
    '    const spy = vi.spyOn(window, "getComputedStyle");',
    '    expect(spy).toHaveBeenCalled();',
    '  });',
    '  it("positive filter helper", () => {',
    '    const spy = vi.spyOn(window, "getComputedStyle");',
    '    const hits = () => spy.mock.calls.filter(Boolean).length;',
    '    expect(hits()).toBeGreaterThan(0);',
    '  });',
    '  it("positive calls toEqual", () => {',
    '    const spy = vi.spyOn(window, "getComputedStyle");',
    '    expect(spy.mock.calls).toEqual([[el]]);',
    '  });',
    '});',
  ].join("\n");
  assert.deepEqual(lines(computedStyleSpyFindings(text)), [3, 7, 11]);
});

test("browser-fixed-sleep catches direct, wrapper (pause/sleep/wait) and string-eval sleeps while respecting exemptions", () => {
  const text = [
    'import { wait } from "./helpers.mjs";',
    'const pause = ms => new Promise(resolve => setTimeout(resolve, ms));',
    'function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }',
    'const PROBE = `const x = 1;\nreturn new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, arguments[1])));`;',
    'await page.waitForTimeout(500);',
    'await new Promise(resolve => setTimeout(resolve, 400));',
    'await new Promise(resolve => setTimeout(resolve, 0));', // macrotask yield: allowed
    'await pause(250);',
    'await pause(0);', // zero yield: allowed
    'await sleep(100);',
    'await wait(200);',
    'browser("eval", "new Promise(resolve => setTimeout(resolve, 400))");',
    'await client.page("scrollTo(0, 3000); return new Promise(resolve => setTimeout(resolve, 1500));");',
    'await client.page(PROBE, ["rgb(0,0,0)", 400]);',
    'browser("eval", "new Promise(resolve => requestAnimationFrame(resolve))");', // rAF only: allowed
    'setTimeout(() => { failed = true; }, 3000);', // unpaired timeout: flagged
    'function withWatchdog() {',
    '  const id = setTimeout(() => { throw new Error("timeout"); }, 3000);',
    '  clearTimeout(id);',
    '}',
    '// sleep-ok: Linux headless_shell long-press hold requires 520ms',
    'await new Promise(resolve => setTimeout(resolve, 520));',
    'await pause(140); // sleep-ok: negative proof window for hover tooltip',
    'await page.evaluate("await page.waitForTimeout(100)");',
  ].join("\n");
  assert.deepEqual(lines(browserFixedSleepFindings(text)), [6, 7, 9, 11, 12, 13, 14, 15, 17, 25]);
});

test("unfiltered-console-spy allows not.toHaveBeenCalled() and exhaustive assertions, flags unfiltered/subset/beforeEach spies", () => {
  const text = [
    'describe("allowed", () => {',
    '  it("not.toHaveBeenCalled", () => {',
    '    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);',
    '    expect(warn).not.toHaveBeenCalled();',
    '  });',
    '  it("toHaveBeenCalledTimes(0)", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).toHaveBeenCalledTimes(0);',
    '  });',
    '  it("exact count + positive args", () => {',
    '    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});',
    '    expect(warn).toHaveBeenCalledTimes(1);',
    '    expect(warn).toHaveBeenCalledWith("expected");',
    '  });',
    '  it("calledOnce + nthCalledWith", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).toHaveBeenCalledOnce();',
    '    expect(err).toHaveBeenNthCalledWith(1, "boom");',
    '  });',
    '  it("exhaustive mock.calls equality", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err.mock.calls).toEqual([["only this"]]);',
    '  });',
    '  it("non-suppressing spy", () => {',
    '    const err = vi.spyOn(console, "error");',
    '    expect(err).toHaveBeenCalledWith("x");',
    '  });',
    '});',
    'describe("beforeEach verified in afterEach", () => {',
    '  let consoleError;',
    '  beforeEach(() => {',
    '    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});',
    '  });',
    '  afterEach(() => {',
    '    expect(consoleError).not.toHaveBeenCalled();',
    '    consoleError.mockRestore();',
    '  });',
    '});',
    'describe("flagged", () => {',
    '  let consoleError;',
    '  beforeEach(() => {',
    '    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});',
    '  });',
    '  afterEach(() => {',
    '    consoleError.mockRestore();',
    '  });',
    '  it("subset filter only", () => {',
    '    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);',
    '    expect(iconOnlyWarnings(warn)).toHaveLength(1);',
    '  });',
    '  it("negated substring only", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err.mock.calls.flat().join(" ")).not.toContain("pendingAnnouncement");',
    '  });',
    '  it("negated toHaveBeenCalledWith", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).not.toHaveBeenCalledWith("bad");',
    '  });',
    '  it("count without args", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).toHaveBeenCalledTimes(1);',
    '  });',
    '  it("anonymous suppressing spy", () => {',
    '    vi.spyOn(console, "error").mockImplementation(() => {});',
    '  });',
    '});',
  ].join("\n");
  assert.deepEqual(lines(unfilteredConsoleSpyFindings(text)), [42, 48, 52, 56, 60, 64]);
});

test("inline-browser-mock flags ResizeObserver/matchMedia stubs, defineProperty, spyOn, assignments and classes, allows restores", () => {
  const text = [
    'const originalResizeObserver = globalThis.ResizeObserver;',
    'vi.stubGlobal("matchMedia", vi.fn());',
    'vi.stubGlobal("ResizeObserver", class {});',
    'Object.defineProperty(window,\n  "matchMedia", { value: vi.fn() });',
    'vi.spyOn(window, "matchMedia").mockImplementation(() => ({}));',
    'window.matchMedia = () => ({});',
    'class MockResizeObserver { observe() {} }',
    'globalThis.ResizeObserver = MockResizeObserver;',
    'globalThis.ResizeObserver = originalResizeObserver;', // restoration: allowed
    'vi.stubGlobal("fetch", vi.fn());', // unrelated global: allowed
  ].join("\n");
  assert.deepEqual(lines(inlineBrowserMockFindings(text)), [2, 3, 4, 6, 7, 8, 9]);
});

test("--base, --warn-lowered, extraBaseline, browserChecks/browserExclude and mockAdapters work end-to-end", async () => {
  const repo = repository({
    "test/a.test.tsx": [
      'expect(el.className.split(" ")).toContain("a");',
      'vi.stubGlobal("matchMedia", vi.fn());',
    ].join("\n") + "\n",
    "test/adapters/media.test.ts": 'vi.stubGlobal("matchMedia", vi.fn());\n',
    "scripts/check-demo.mjs": 'await new Promise(resolve => setTimeout(resolve, 200));\n',
    "scripts/safari-real-bounce/manual.mjs": 'await new Promise(resolve => setTimeout(resolve, 500));\n',
  });
  const config = {
    testHygiene: {
      rules: [
        "fixed-sleep",
        "timing-assert",
        "classname-split",
        "browser-fixed-sleep",
        "unfiltered-console-spy",
        "inline-browser-mock",
      ],
      extraBaseline: "test-hygiene-extra-baseline.json",
      browserChecks: ["scripts/check-*.mjs", "scripts/safari-real-bounce/**"],
      browserExclude: ["scripts/safari-real-bounce/**"],
      mockAdapters: ["test/adapters/**"],
    },
  };

  const init = run(repo.root, ["--init"], config);
  assert.equal(init.code, 0, init.err);
  const coreBase = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8"));
  const extraBase = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-extra-baseline.json"), "utf8"));
  assert.deepEqual(coreBase.rules, { "fixed-sleep": {}, "timing-assert": {} });
  assert.deepEqual(extraBase.rules, {
    "classname-split": { "test/a.test.tsx": 1 },
    "browser-fixed-sleep": { "scripts/check-demo.mjs": 1 },
    "unfiltered-console-spy": {},
    "inline-browser-mock": { "test/a.test.tsx": 1 },
  });
  repo.commit();
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/dev", "HEAD");

  // Lowering a count fails normally, passes with warning under --warn-lowered.
  write(repo.root, { "scripts/check-demo.mjs": "await waitFor(() => ready);\n" });
  const loweredFail = run(repo.root, [], config);
  assert.equal(loweredFail.code, 1);
  assert.match(loweredFail.err, /browser-fixed-sleep in scripts\/check-demo\.mjs went down to 0 \(baseline 1\)/);

  const loweredWarn = run(repo.root, ["--warn-lowered"], config);
  assert.equal(loweredWarn.code, 0, loweredWarn.err);
  assert.match(loweredWarn.err, /WARNING 1 test-hygiene counts are lower/);

  // Raising a baseline entry on a branch fails against --base <sha>, even with --warn-lowered.
  repo.git("switch", "-q", "-c", "topic");
  write(repo.root, {
    "scripts/check-demo.mjs": 'await new Promise(resolve => setTimeout(resolve, 200));\nawait pause(300);\n',
    "test-hygiene-extra-baseline.json": JSON.stringify({
      version: 1,
      rules: { ...extraBase.rules, "browser-fixed-sleep": { "scripts/check-demo.mjs": 2 } },
    }, null, 2) + "\n",
  });
  repo.commit();
  const raised = run(repo.root, ["--base", baseSha, "--warn-lowered"], config);
  assert.equal(raised.code, 1);
  assert.match(raised.err, /test-hygiene-extra-baseline\.json raises browser-fixed-sleep for scripts\/check-demo\.mjs to 2 \(the base has 1\)/);

  // Invalid --base fails loudly.
  const badBase = run(repo.root, ["--base=refs/does-not-exist"], config);
  assert.equal(badBase.code, 1);
  assert.match(badBase.err, /cannot resolve base commit/);

  // Closer origin/dev wins over older origin/main in resolveBaseCommit.
  repo.git("update-ref", "refs/remotes/origin/dev", "HEAD");
  write(repo.root, { "test/b.test.ts": "export const x = 1;\n" });
  repo.commit();
  const devSha = execFileSync("git", ["rev-parse", "origin/dev"], { cwd: repo.root, encoding: "utf8" }).trim();
  assert.equal(resolveBaseCommit(repo.root), devSha);

  // parseHygieneArgs rejects invalid combinations/flags.
  assert.throws(() => parseHygieneArgs(["--init", "--update"]), /cannot be combined/);
  assert.throws(() => parseHygieneArgs(["--base"]), /requires a commit ref/);
  assert.throws(() => parseHygieneArgs(["--bogus"]), /unknown option/);

  // Subpath export @maxvyshniakov/package-kit/test-hygiene resolves cleanly.
  const exported = await import("@maxvyshniakov/package-kit/test-hygiene");
  assert.equal(typeof exported.maskJs, "function");
  assert.equal(typeof exported.browserFixedSleepFindings, "function");
  assert.equal(typeof exported.unfilteredConsoleSpyFindings, "function");
  assert.equal(typeof exported.inlineBrowserMockFindings, "function");
});

test("--init writes only missing baseline files when core baseline already exists and handles extraBaseline === baseline", () => {
  const repo = repository({
    "test/a.test.tsx": 'expect(el.className.split(" ")).toContain("a");\nawait page.waitForTimeout(500);\n',
  });
  // First initialize core baseline only.
  const first = run(repo.root, ["--init"]);
  assert.equal(first.code, 0, first.err);
  const originalCore = fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8");

  // Later enable extraBaseline alongside existing core baseline: --init writes only the missing extra baseline.
  const config = {
    testHygiene: {
      rules: ["fixed-sleep", "timing-assert", "classname-split"],
      extraBaseline: "test-hygiene-extra-baseline.json",
    },
  };
  const second = run(repo.root, ["--init"], config);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /wrote test-hygiene-extra-baseline\.json/);
  assert.doesNotMatch(second.out, /wrote test-hygiene-baseline\.json/);
  assert.equal(fs.readFileSync(path.join(repo.root, "test-hygiene-baseline.json"), "utf8"), originalCore);
  const extra = JSON.parse(fs.readFileSync(path.join(repo.root, "test-hygiene-extra-baseline.json"), "utf8"));
  assert.deepEqual(extra.rules, { "classname-split": { "test/a.test.tsx": 1 } });

  // Running --init again when all configured baselines already exist refuses with exit 1.
  const third = run(repo.root, ["--init"], config);
  assert.equal(third.code, 1);
  assert.match(third.err, /exist; use --update to lower it/);

  // extraBaseline === baseline is treated as a single baseline file without double-writing.
  const sameRepo = repository({ "test/a.test.tsx": 'expect(el.className.split(" ")).toContain("a");\n' });
  const sameCfg = {
    testHygiene: {
      baseline: "test-hygiene-baseline.json",
      extraBaseline: "./test-hygiene-baseline.json",
      rules: ["fixed-sleep", "classname-split"],
    },
  };
  const sameInit = run(sameRepo.root, ["--init"], sameCfg);
  assert.equal(sameInit.code, 0, sameInit.err);
  const combined = JSON.parse(fs.readFileSync(path.join(sameRepo.root, "test-hygiene-baseline.json"), "utf8"));
  assert.deepEqual(combined.rules, { "fixed-sleep": {}, "classname-split": { "test/a.test.tsx": 1 } });
});

test("--update prints an explicit message when blocked by a raised baseline", () => {
  const repo = repository({ "test/a.test.mjs": sleepy(1) });
  run(repo.root, ["--init"]);
  repo.commit();
  write(repo.root, {
    "test-hygiene-baseline.json": JSON.stringify({ version: 1, rules: { "fixed-sleep": { "test/a.test.mjs": 2 }, "timing-assert": {} } }),
  });
  const res = run(repo.root, ["--update"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /did not update test-hygiene-baseline\.json because it raises entries above the base commit/);
  assert.match(res.err, /raises fixed-sleep for test\/a\.test\.mjs to 2 \(the base has 1\)/);
});

test("browser-fixed-sleep handles default-parameter wrappers, watchdog helpers, and 1-arg setTimeout(r) vs timers/promises", () => {
  const text = [
    'const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));',
    'function dwell(ms = 150) { return new Promise(r => setTimeout(r, ms)); }',
    'const zeroDefault = (ms = 0) => new Promise(r => setTimeout(r, ms));',
    'function waitForCond(cond, timeout) {',
    '  return new Promise((resolve, reject) => {',
    '    const id = setTimeout(() => reject(new Error("timeout")), timeout);',
    '    if (cond()) { clearTimeout(id); resolve(); }',
    '  });',
    '}',
    'await settle();', // positive default: flagged
    'await settle(0);', // explicit 0: allowed
    'await dwell();', // positive default: flagged
    'await zeroDefault();', // 0 default: allowed
    'await waitForCond(() => true, 5000);', // watchdog helper: allowed
    'await new Promise(r => setTimeout(r));', // 1-arg macrotask yield: allowed
    'browser("eval", "new Promise(r => setTimeout(r))");', // 1-arg eval yield: allowed
    'await setTimeout(200);', // 1-arg positive numeric literal: flagged
  ].join("\n");
  assert.deepEqual(lines(browserFixedSleepFindings(text)), [10, 12, 17]);

  const timersPromises = [
    'import { setTimeout } from "node:timers/promises";',
    'await setTimeout(DELAY);',
    'await setTimeout(0);',
  ].join("\n");
  assert.deepEqual(lines(browserFixedSleepFindings(timersPromises)), [2]);
});

test("unfiltered-console-spy rejects negated spy.mock.calls[...] matchers and allows anonymous console.error/warn assertions", () => {
  const text = [
    'describe("edge cases", () => {',
    '  it("negated mock.calls[0] does not count as positive args", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).toHaveBeenCalledTimes(1);',
    '    expect(err.mock.calls[0][0]).not.toContain("act");',
    '  });',
    '  it("positive mock.calls[0] with exact count is allowed", () => {',
    '    const err = vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(err).toHaveBeenCalledTimes(1);',
    '    expect(err.mock.calls[0][0]).toContain("expected");',
    '  });',
    '  it("anonymous spy verified via console.error", () => {',
    '    vi.spyOn(console, "error").mockImplementation(() => {});',
    '    expect(console.error).not.toHaveBeenCalled();',
    '  });',
    '  it("anonymous spy verified via console.warn toHaveBeenCalledTimes(0)", () => {',
    '    vi.spyOn(console, "warn").mockImplementation(() => {});',
    '    expect(console.warn).toHaveBeenCalledTimes(0);',
    '  });',
    '  it("anonymous spy without assertion still fails", () => {',
    '    vi.spyOn(console, "error").mockImplementation(() => {});',
    '  });',
    '});',
  ].join("\n");
  assert.deepEqual(lines(unfilteredConsoleSpyFindings(text)), [3, 21]);
});

test("inline-browser-mock catches TS casts and bracket access, scopes savedOriginals, ignores matchMedia() calls, and allows typed restores", () => {
  const text = [
    'describe("casts and brackets", () => {',
    '  it("flags TS casts and bracket assignments", () => {',
    '    (globalThis as any).ResizeObserver = class {};',
    '    (window as any).matchMedia = vi.fn();',
    '    Object.defineProperty(window as any, "matchMedia", { value: vi.fn() });',
    '    window["matchMedia"] = vi.fn();',
    '  });',
    '  it("matchMedia() call is not a saved original; typed restore in scope is allowed", () => {',
    '    const mql = window.matchMedia("(min-width: 768px)");',
    '    window.matchMedia = mql as any;', // NOT a restore of the function: flagged
    '    const orig = window.matchMedia;',
    '    window.matchMedia = vi.fn();',
    '    window.matchMedia = orig as typeof window.matchMedia;', // restore with TS cast: allowed
    '    window.matchMedia = orig!;', // restore with non-null assertion: allowed
    '  });',
    '  it("saved original from sibling it() does not exempt this block", () => {',
    '    const orig = vi.fn();',
    '    window.matchMedia = orig;', // sibling orig out of scope: flagged
    '  });',
    '});',
  ].join("\n");
  assert.deepEqual(lines(inlineBrowserMockFindings(text)), [3, 4, 5, 6, 10, 12, 18]);
});

test("runTestHygiene permits newly adopted rules absent from the committed baseline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-hygiene-adopt-"));
  const env = isolatedGitEnv();
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/sample.test.ts"), "vi.stubGlobal('matchMedia', () => ({}));\n");
    fs.writeFileSync(
      path.join(dir, "test-hygiene-extra-baseline.json"),
      JSON.stringify({ version: 1, rules: { "classname-split": {} } }, null, 2) + "\n",
    );
    execFileSync("git", ["add", "."], { cwd: dir, env });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env });

    fs.writeFileSync(
      path.join(dir, "test-hygiene-extra-baseline.json"),
      JSON.stringify({
        version: 1,
        rules: { "classname-split": {}, "inline-browser-mock": { "src/sample.test.ts": 1 } },
      }, null, 2) + "\n",
    );
    const errors = [];
    const code = runTestHygiene({
      root: dir,
      config: {
        testHygiene: {
          baseline: "test-hygiene-extra-baseline.json",
          rules: ["classname-split", "inline-browser-mock"],
          globs: ["src/*.test.ts"],
        },
      },
      args: ["--base", "HEAD"],
      env,
      print: () => {},
      printError: msg => errors.push(msg),
    });
    assert.equal(code, 0, errors.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
