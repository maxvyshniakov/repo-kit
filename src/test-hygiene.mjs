// `repo-kit test-hygiene`: shrink-only rules over a repository's test files.
//
//   fixed-sleep    a fixed wait: waitForTimeout(<n>), a setTimeout(resolve, <n ≥ 50>) promise,
//                  sleep(<n ≥ 50 ms>), time.sleep(<n ≥ 0.2>), Thread.sleep, usleep, Task.sleep,
//                  thread::sleep, runMain(for:). A line, or the comment right above it, carrying
//                  `sleep-ok: <reason>` is allowed.
//   timing-assert  a raw timing assertion outside the perf suite: an assertion bounding a measured
//                  duration from above (`Date.now() - started < 2000`, `assertLess(elapsed, .2)`),
//                  ported from Straylight's tools/perf-budget-check.py. A budget goes through the
//                  perf helper (perfBudget / perf_budget), which enforces only in the perf suite;
//                  a deadline that only bounds a wait passes with a literal bound of at least
//                  30 s, or with a `load-tolerant: <why>` comment. Each file calling the helper
//                  must be part of the perf suite (testHygiene.perfSuite), or its budgets never hold.
//   ui-assertion   (opt-in, testHygiene.ui) a class-name or CSS-text assertion in a unit test:
//                  toHaveClass(...), an asserted .className or classList, a string holding a
//                  CSS declaration (`"color: var(--x);"`) inside an assertion.
//
// Today's findings go into a baseline file, per rule and file. A file may not
// gain findings, a new file may not have any, and a count that dropped must be
// lowered in the baseline (`--update`), so the counts only shrink. Compared
// with the baseline committed at HEAD, no entry may rise. `--init` writes the
// first baseline. Without a repo-kit.config.mjs (a Python repository, say) the
// defaults apply.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const RULES = ["fixed-sleep", "timing-assert", "ui-assertion"];
export const DEFAULTS = {
  baseline: "test-hygiene-baseline.json",
  tests: [
    "**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx,mts,cts}", "**/__tests__/**/*.{js,mjs,cjs,ts,tsx,jsx}",
    "test/**/*.{js,mjs,cjs,ts,tsx,py}", "tests/**/*.{js,mjs,cjs,ts,tsx,py,rs,swift}",
    "**/test_*.py", "**/*_test.py", "test-*.{py,mjs,js,swift}", "{scripts,tools}/**/test-*.{py,mjs,js}",
    "**/*Tests.swift", "**/*_tests.rs",
  ],
  exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
  perfSuite: ["**/*.perf.{js,mjs,ts,tsx}", "**/perf/**", "**/test_perf_*.py", "**/*.perf.test.*"],
  rules: ["fixed-sleep", "timing-assert"],
};

const LANGUAGE = { ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".jsx": "js", ".mts": "js", ".cts": "js", ".py": "python", ".swift": "swift", ".rs": "rust" };
export const languageOf = file => LANGUAGE[path.extname(file)];

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over a repository-relative path. */
export function globRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches no directory or any number of them.
      if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      out += `(?:${glob.slice(i + 1, end).split(",").map(part => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const matcher = globs => {
  const expressions = globs.map(globRegExp);
  return file => expressions.some(expression => expression.test(file));
};

/** The line without its comment and with string literal contents blanked: neither asserts nor waits. */
export function code(line, language) {
  const quotes = { js: "\"'`", python: "\"'", swift: "\"", rust: "\"" }[language];
  const comment = language === "python" ? "#" : "//";
  let kept = "", quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { quote = null; kept += c; }
      continue;
    }
    if (line.startsWith(comment, i)) break;
    if (quotes.includes(c)) quote = c;
    kept += c;
  }
  return kept;
}

/** The marker on the line or in the comment lines right above it. */
function marked(raw, index, marker) {
  if (marker.test(raw[index])) return true;
  for (let above = index - 1; above >= 0 && /^\s*(?:\/\/|#|\/?\*)/.test(raw[above]); above--) {
    if (marker.test(raw[above])) return true;
  }
  return false;
}

// ---- fixed-sleep ----------------------------------------------------------

const SLEEP_OK = /sleep-ok:\s*\S+/;
const NUMBER = String.raw`(\d[\d_]*(?:\.\d+)?|\.\d+)`;
const num = text => Number(text.replaceAll("_", ""));

const SLEEPS = {
  js: [
    // A fixed wait whatever its argument.
    [/\bwaitForTimeout\s*\(/, () => true],
    // new Promise(resolve => setTimeout(resolve, 100 or DELAY)); a timer that is not a promise's resolve is not a wait.
    [new RegExp(String.raw`\bnew\s+Promise\b.*\bsetTimeout\s*\(\s*(?:\w+|\(\)\s*=>\s*\w+\(\s*\))\s*,\s*(?:${NUMBER}|[A-Za-z_$][\w.$]*)\s*\)`), ms => ms === undefined || ms >= 50],
    // await sleep(100), Bun.sleep(100), delay(100), setTimeout(100) from timers/promises
    [new RegExp(String.raw`(?:\bBun\.|(?<![\w.]))(?:sleep|delay|setTimeout)\s*\(\s*${NUMBER}\s*[,)]`), ms => ms >= 50],
  ],
  python: [
    [new RegExp(String.raw`(?:\b(?:time|asyncio)\.|(?<![\w.]))sleep\s*\(\s*${NUMBER}\s*\)`), s => s >= 0.2],
    // Playwright for Python: a fixed wait whatever its argument.
    [/\bwait_for_timeout\s*\(/, () => true],
  ],
  // A bare sleep, not a method such as TestClock.sleep(for:), which waits on a test clock.
  swift: [[/\b(?:Thread\.sleep|Task\.sleep)\s*\(|(?<![\w.])(?:usleep|sleep)\s*\(|\brunMain\s*\(\s*for\s*:/, () => true]],
  rust: [[/\b(?:thread::sleep|std::thread::sleep|tokio::time::sleep)\s*\(/, () => true]],
};

export function sleepFindings(file, text) {
  const language = languageOf(file);
  if (!language) return [];
  const raw = text.split("\n");
  const found = [];
  raw.forEach((line, index) => {
    const stripped = code(line, language);
    for (const [pattern, counts] of SLEEPS[language]) {
      const match = stripped.match(pattern);
      if (!match || !counts(match[1] === undefined ? undefined : num(match[1]))) continue;
      if (!marked(raw, index, SLEEP_OK)) found.push({ line: index + 1, text: line.trim() });
      break;
    }
  });
  return found;
}

// ---- timing-assert (from Straylight tools/perf-budget-check.py) ------------

export const FLOOR_SECONDS = 30;
const CLOCK = {
  js: String.raw`Date\.now\(\)|performance\.now\(\)|process\.hrtime|process\.cpuUsage\(`,
  swift: String.raw`systemUptime\b|\.timeIntervalSince\(|\.timeIntervalSinceNow\b|CFAbsoluteTimeGetCurrent\(\)|clock_gettime|mach_absolute_time\(\)|uptimeNanoseconds|CPUTime\(\)`,
  python: String.raw`\btime\.(?:monotonic|perf_counter|time|process_time|thread_time)(?:_ns)?\(\)|\bmonotonic\(\)|\bperf_counter\(\)`,
  rust: String.raw`Instant::now\(\)|\.elapsed\(\)|SystemTime::now\(\)`,
};
const ASSERTION = {
  js: String.raw`\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(`,
  swift: String.raw`\b(?:precondition|assert|expect|XCTAssert\w*)\s*\(`,
  python: String.raw`\bassert\b|\bself\.assert\w+\s*\(`,
  rust: String.raw`\b(?:debug_)?assert(?:_eq|_ne)?!\s*\(`,
};
export const HELPER = { swift: "perfBudget", js: "perfBudget", python: "perf_budget", rust: "perf_budget" };
const DEFINITION = /\b(?:func|function|def|fn)\s+(?:perfBudget|perf_budget)\b|\bexport\s+(?:const|let)\s+perfBudget\b/;
const LOAD_TOLERANT = /load-tolerant:\s*\S+(?:\s+\S+){2,}/;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A literal bound in seconds: JS literals are milliseconds, Rust names its unit, Swift and Python use seconds. */
function seconds(text, language, deadlines) {
  const name = text.match(/^\s*(\w+)\b(?!\s*[(.[])/);
  if (deadlines && name && name[1] in deadlines) return deadlines[name[1]];
  if (language === "rust") {
    const match = text.match(new RegExp(String.raw`^\s*(?:std::time::)?Duration::from_(secs|millis|secs_f64|secs_f32)\(\s*${NUMBER}`));
    if (!match) return null;
    return match[1] === "millis" ? num(match[2]) / 1000 : num(match[2]);
  }
  const match = text.match(new RegExp(String.raw`^\s*${NUMBER}(?![\w.(])`));
  if (!match) return null;
  return language === "js" ? num(match[1]) / 1000 : num(match[1]);
}

/** The assertion starting on `start` up to its closing parenthesis, at most six lines. */
function window(lines, start) {
  let depth = 0, end = start;
  for (end = start; end < Math.min(start + 5, lines.length - 1); end++) {
    // An escaped parenthesis (in a regular expression literal) opens nothing.
    depth += (lines[end].match(/(?<!\\)\(/g)?.length ?? 0) - (lines[end].match(/(?<!\\)\)/g)?.length ?? 0);
    if (depth <= 0) break;
  }
  return [end, lines.slice(start, end + 1).join(" ")];
}

/** The upper bounds the assertion puts on a measurement (null for a bound that is not a literal). */
function bounds(text, measured, language, deadlines) {
  const found = [];
  for (const match of text.matchAll(new RegExp(String.raw`(?:${measured})(?:[^,;<>&|?]|->)*?(?<![<-])<(?![<-])=?`, "g"))) {
    found.push(seconds(text.slice(match.index + match[0].length), language, deadlines));
  }
  for (const match of text.matchAll(new RegExp(String.raw`(?<![=\-<>])>=?\s*(?:${measured})`, "g"))) {
    const before = text.slice(0, match.index).match(new RegExp(String.raw`(\w+|${NUMBER})\s*$`));
    found.push(before ? seconds(before[1], language, deadlines) : null);
  }
  if (language === "js") {
    // expect(elapsed).toBeLessThan(100): the matcher form of `elapsed < 100`.
    // ...and chai's `.to.be.below(100)`, `.lessThan(100)`, `.at.most(100)`.
    for (const match of text.matchAll(new RegExp(String.raw`expect\(\s*[^)]*?(?:${measured})[^)]*\)\s*(?:\.\w+)*?\.(?:toBeLessThan(?:OrEqual)?|below|lessThan|most)\(`, "g"))) {
      found.push(seconds(text.slice(match.index + match[0].length), language, deadlines));
    }
  }
  if (language === "python") {
    for (const match of text.matchAll(new RegExp(String.raw`assertLess(?:Equal)?\(\s*[^,]*?(?:${measured})[^,]*,`, "g"))) {
      found.push(seconds(text.slice(match.index + match[0].length), language, deadlines));
    }
    for (const match of text.matchAll(new RegExp(String.raw`assertGreater(?:Equal)?\(([^,]*),\s*(?:${measured})`, "g"))) {
      found.push(seconds(match[1], language, deadlines));
    }
  }
  return found;
}

export function timingFindings(file, text) {
  const language = languageOf(file);
  if (!language || !new RegExp(CLOCK[language]).test(text)) return [];
  const raw = text.split("\n");
  const lines = raw.map(line => code(line, language));
  const clock = new RegExp(CLOCK[language]);
  const names = new Set(), assigned = [], derived = [];
  const difference = /-|\.elapsed\(\)|\.timeIntervalSince\(|\.timeIntervalSinceNow\b/;
  lines.forEach((line, number) => {
    // `elapsed = Date.now() - started`; `deadline = time.monotonic() + 5` is a deadline with its bound.
    for (const [, name, value] of line.matchAll(/\b(\w+)\s*(?::\s*[\w.<>[\]]+\s*)?=(?![=>])\s*((?:[^,;=]|==)+)/g)) {
      derived.push([name, value]);
      if (!clock.test(value)) continue;
      const plus = value.match(new RegExp(String.raw`(?:${clock.source})\s*\+\s*(.+)`));
      if (plus) assigned.push([number, name, seconds(plus[1], language)]);
      else if (difference.test(value)) names.add(name);
    }
    // Durations collected for a statistic: `samples.push(performance.now() - start)`.
    for (const [, name, value] of line.matchAll(/\b(\w+)\s*\.\s*(?:append|push|insert)\((.*)\)/g)) {
      if (clock.test(value) && difference.test(value)) names.add(name);
    }
  });
  // What is computed from a measurement measures too: a median of samples, not their count.
  for (let round = 0; round < 3; round++) {
    for (const [name, value] of derived) {
      if (!names.has(name) && [...names].some(known => new RegExp(String.raw`(?<!len\()\b${escape(known)}\b(?!\s*\.\s*(?:count|length|isEmpty)\b)`).test(value))) names.add(name);
    }
  }
  const measured = clock.source + [...names].sort().map(name => String.raw`|\b${escape(name)}\b`).join("");
  const assertion = new RegExp(ASSERTION[language]);
  const helper = new RegExp(String.raw`\b${HELPER[language]}\s*\(`);
  const found = [];
  lines.forEach((line, index) => {
    if (!assertion.test(line)) return;
    const [end, statement] = window(lines, index);
    if (helper.test(statement)) return;
    const deadlines = Object.fromEntries(assigned.filter(([number]) => number <= index).map(([, name, bound]) => [name, bound]));
    const tight = bounds(statement, measured, language, deadlines).filter(bound => bound === null || bound < FLOOR_SECONDS);
    if (!tight.length) return;
    let above = index;
    while (above > 0 && !lines[above - 1].trim() && raw[above - 1].trim()) above--;
    if (LOAD_TOLERANT.test(raw.slice(above, end + 1).join("\n"))) return;
    const bound = tight.includes(null) ? "a computed bound" : `${Math.min(...tight)} s`;
    found.push({ line: index + 1, text: `timing assertion with ${bound}: ${raw[index].trim()}` });
  });
  return found;
}

/** Whether a file calls the perf helper (and not only defines it). */
export function callsPerfHelper(file, text) {
  const language = languageOf(file);
  if (!language) return false;
  const helper = new RegExp(String.raw`\b${HELPER[language]}\s*\(`);
  return text.split("\n").some(line => helper.test(code(line, language)) && !DEFINITION.test(line));
}

// ---- ui-assertion ----------------------------------------------------------

const CLASS_ASSERTION = /\btoHaveClass\s*\(|\b(?:expect|assert(?:\.\w+)?)\s*\(.*?\.(?:className|classList)\b|\.classList\.contains\s*\([^)]*\)\s*\)?\s*\.(?:toBe|toEqual)|\bassert\w*\s*\([^)]*\.classList\.contains\(/;
// A declaration whose value looks like CSS (a var(), a number or unit, a colour, a keyword), not prose such as
// "warning: deprecated; use x".
const CSS_TEXT = /(["'`])(?:[^"'`]*?[\s{;])?(?:--)?[a-z]+(?:-[a-z0-9]+)*\s*:\s*(?=[^;"'`]*(?:var\(|\d|#[0-9a-f]{3}|\b(?:none|auto|inherit|initial|transparent|currentColor|solid|flex|grid|block|inline|hidden|absolute|relative|fixed|bold|normal)\b))[^;"'`]+;[^"'`]*\1/i;
const ASSERTING = /\b(?:expect|assert(?:\.\w+)?)\s*\(|\.to(?:Contain|Match|Be|Equal|Include)\w*\s*\(/;

export function uiFindings(file, text) {
  if (languageOf(file) !== "js") return [];
  const found = [];
  text.split("\n").forEach((line, index) => {
    const stripped = code(line, "js");
    if (CLASS_ASSERTION.test(stripped)) found.push({ line: index + 1, text: `class-name assertion: ${line.trim()}` });
    else if (ASSERTING.test(stripped) && CSS_TEXT.test(line)) found.push({ line: index + 1, text: `CSS-text assertion: ${line.trim()}` });
  });
  return found;
}

// ---- the check -------------------------------------------------------------

export function hygieneConfig(config = {}) {
  const own = config.testHygiene ?? {};
  return { ...DEFAULTS, ...own, rules: own.rules ?? (own.ui ? [...DEFAULTS.rules, "ui-assertion"] : DEFAULTS.rules) };
}

function listFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

/** Every finding per rule and file, and the perf-helper callers outside the perf suite. */
export function scan(root, settings, files = listFiles(root)) {
  const isTest = matcher(settings.tests), excluded = matcher(settings.exclude), inPerfSuite = matcher(settings.perfSuite);
  const findings = Object.fromEntries(settings.rules.map(rule => [rule, {}]));
  const unrunBudgets = [];
  let scanned = 0;
  for (const file of files) {
    if (!isTest(file) || excluded(file) || !languageOf(file)) continue;
    const full = path.join(root, file);
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) continue;
    scanned++;
    const text = fs.readFileSync(full, "utf8");
    // The perf suite's files run the helper; a raw timing assertion fails there too, as anywhere.
    const perf = inPerfSuite(file);
    const add = (rule, list) => { if (list.length) findings[rule][file] = list; };
    if (settings.rules.includes("fixed-sleep")) add("fixed-sleep", sleepFindings(file, text));
    if (settings.rules.includes("timing-assert")) {
      add("timing-assert", timingFindings(file, text));
      if (!perf && callsPerfHelper(file, text)) unrunBudgets.push(file);
    }
    if (settings.rules.includes("ui-assertion")) add("ui-assertion", uiFindings(file, text));
  }
  return { findings, unrunBudgets, scanned, files: new Set(files) };
}

export const counts = findings => Object.fromEntries(Object.entries(findings).map(([rule, files]) => [rule, Object.fromEntries(Object.entries(files).map(([file, list]) => [file, list.length]))]));

/**
 * The baseline's verdict: `problems` fail the check (growth, a new file, an
 * entry raised against the base's baseline), `stale` entries must be lowered,
 * `lowered` is the baseline --update writes. Against the base an entry may rise
 * only as far as entries of files that no longer exist (`existing` lacks them)
 * went away: a renamed or split file keeps its count.
 */
export function compare(current, baseline, committed = null, existing = null) {
  const problems = [], stale = [];
  const lowered = {};
  for (const rule of Object.keys(current)) {
    const now = current[rule], allowed = baseline?.[rule] ?? {};
    lowered[rule] = {};
    for (const [file, count] of Object.entries(now)) {
      const limit = allowed[file] ?? 0;
      if (count > limit) problems.push({ rule, file, count, limit });
      lowered[rule][file] = Math.min(count, limit) || undefined;
      if (lowered[rule][file] === undefined) delete lowered[rule][file];
    }
    for (const [file, limit] of Object.entries(allowed)) {
      const count = now[file] ?? 0;
      if (count < limit) stale.push({ rule, file, count, limit });
    }
    if (committed) {
      const before = committed[rule] ?? {};
      const raised = Object.entries(allowed).filter(([file, limit]) => limit > (before[file] ?? 0));
      const moved = Object.entries(before).filter(([file]) => existing && !existing.has(file))
        .reduce((sum, [file, limit]) => sum + Math.max(0, limit - (allowed[file] ?? 0)), 0);
      const raise = raised.reduce((sum, [file, limit]) => sum + limit - (before[file] ?? 0), 0);
      if (raise > moved) for (const [file, limit] of raised) problems.push({ rule, file, count: limit, limit: before[file] ?? 0, raised: true });
    }
  }
  return { problems, stale, lowered };
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * The commit whose baseline this one may not exceed: REPO_KIT_HYGIENE_BASE, or
 * where HEAD left origin's default branch; on that branch itself (a main push
 * in CI, the pre-push check of main) HEAD's parent. HEAD when none is known.
 */
export function baseCommit(root, env = process.env) {
  const tryGit = args => { try { return git(root, args); } catch { return null; } };
  if (env.REPO_KIT_HYGIENE_BASE) return tryGit(["rev-parse", "--verify", `${env.REPO_KIT_HYGIENE_BASE}^{commit}`]);
  const head = tryGit(["rev-parse", "--verify", "HEAD"]);
  if (!head) return null;
  for (const ref of ["origin/HEAD", "origin/main"]) {
    const base = tryGit(["merge-base", "HEAD", ref]);
    if (!base) continue;
    return base === head ? tryGit(["rev-parse", "--verify", "HEAD~1"]) ?? head : base;
  }
  return head;
}

function committedBaseline(root, file, commit) {
  if (!commit) return null;
  try {
    // ./ resolves from root, which may be a subdirectory of the repository.
    return JSON.parse(git(root, ["show", `${commit}:./${file}`])).rules ?? {};
  } catch {
    return null;
  }
}

const writeBaseline = (file, rules) => fs.writeFileSync(file, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);

export function runTestHygiene({ root, config = {}, args = [], env = process.env, print = console.log, printError = console.error }) {
  const settings = hygieneConfig(config);
  const unknown = settings.rules.filter(rule => !RULES.includes(rule));
  if (unknown.length) return printError(`test-hygiene: unknown rules ${unknown.join(", ")}; known: ${RULES.join(", ")}`), 1;
  const baselineFile = path.join(root, settings.baseline);
  const { findings, unrunBudgets, scanned, files } = scan(root, settings);
  const current = counts(findings);
  let failed = false;
  for (const file of unrunBudgets) {
    printError(`test-hygiene: ${file} states a perf budget (perfBudget / perf_budget), but it is not in the perf suite (testHygiene.perfSuite), so its budgets never hold`);
    failed = true;
  }

  if (args.includes("--init")) {
    if (fs.existsSync(baselineFile)) return printError(`test-hygiene: ${settings.baseline} exists; use --update to lower it`), 1;
    writeBaseline(baselineFile, current);
    const total = Object.values(current).reduce((sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0), 0);
    print(`test-hygiene: wrote ${settings.baseline} with ${total} findings in ${scanned} test files; they may only shrink`);
    return failed ? 1 : 0;
  }
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")).rules ?? {} : {};
  const committed = committedBaseline(root, settings.baseline, baseCommit(root, env));
  const { problems, stale, lowered } = compare(current, baseline, committed, files);
  if (args.includes("--update")) {
    writeBaseline(baselineFile, lowered);
    for (const { rule, file, count, limit } of stale) print(`test-hygiene: lowered ${rule} ${file} ${limit} -> ${count}`);
  } else if (stale.length) {
    for (const { rule, file, count, limit } of stale) printError(`test-hygiene: ${rule} in ${file} went down to ${count} (baseline ${limit}); run repo-kit test-hygiene --update to lower the baseline`);
    failed = true;
  }
  for (const { rule, file, count, limit, raised } of problems) {
    if (raised) {
      printError(`test-hygiene: ${settings.baseline} raises ${rule} for ${file} to ${count} (the base has ${limit}); the baseline may only shrink`);
    } else {
      printError(`test-hygiene: ${rule} in ${file}: ${count} findings, baseline allows ${limit}:`);
      for (const { line, text } of findings[rule][file]) printError(`  ${file}:${line}: ${text}`);
    }
    failed = true;
  }
  if (problems.some(({ rule, raised }) => rule === "fixed-sleep" && !raised)) printError("Wait for the condition instead (an event, a poll with a deadline), or mark a wait that must be fixed with `sleep-ok: <reason>`.");
  if (problems.some(({ rule, raised }) => rule === "timing-assert" && !raised)) printError(`Move a budget into the perf helper (perfBudget / perf_budget), give a functional deadline a bound of at least ${FLOOR_SECONDS} s, or a tighter one a \`load-tolerant: <why>\` comment.`);
  if (!failed) print(`test-hygiene: ok (${settings.rules.join(", ")}; ${scanned} test files)`);
  return failed ? 1 : 0;
}
