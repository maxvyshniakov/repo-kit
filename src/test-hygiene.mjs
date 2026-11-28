// `package-kit test-hygiene`: shrink-only rules over a repository's test files.
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
//                  toHaveClass(...), an asserted .className, classList, getAttribute("class"),
//                  or .matches(".<class>"), or a string holding a CSS declaration
//                  (`"color: var(--x);"`) inside an assertion.
//
// Today's findings go into a baseline file, per rule and file. A file may not
// gain findings, a new file may not have any, and a count that dropped must be
// lowered in the baseline (`--update`), so the counts only shrink. Compared
// with the baseline committed at HEAD, no entry may rise. `--init` writes the
// first baseline. Without a package-kit.config.mjs (a Python repository, say) the
// defaults apply.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  collapseSnippet,
  enclosingScope,
  findDeclarationScope,
  findMatchingClose,
  lineAt,
  maskJs,
  parseCallArgs,
} from "./test-hygiene-lex.mjs";
import {
  EXTRA_RULES,
  RULE_HINTS,
  browserFixedSleepFindings,
  classNameSplitFindings,
  computedStyleSpyFindings,
  cssFileReadFindings,
  inlineBrowserMockFindings,
  scanExtraSource,
  unfilteredConsoleSpyFindings,
} from "./test-hygiene-rules.mjs";

export {
  EXTRA_RULES,
  RULE_HINTS,
  browserFixedSleepFindings,
  classNameSplitFindings,
  collapseSnippet,
  computedStyleSpyFindings,
  cssFileReadFindings,
  enclosingScope,
  findDeclarationScope,
  findMatchingClose,
  inlineBrowserMockFindings,
  lineAt,
  maskJs,
  parseCallArgs,
  scanExtraSource,
  unfilteredConsoleSpyFindings,
};

export const CORE_RULES = ["fixed-sleep", "timing-assert", "ui-assertion"];
export const RULES = [...CORE_RULES, ...EXTRA_RULES];
export const DEFAULTS = {
  baseline: "test-hygiene-baseline.json",
  extraBaseline: null,
  tests: [
    "**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx,mts,cts}", "**/__tests__/**/*.{js,mjs,cjs,ts,tsx,jsx}",
    "test/**/*.{js,mjs,cjs,ts,tsx,py}", "tests/**/*.{js,mjs,cjs,ts,tsx,py,rs,swift}",
    "**/test_*.py", "**/*_test.py", "test-*.{py,mjs,js,swift}", "{scripts,tools}/**/test-*.{py,mjs,js}",
    "**/*Tests.swift", "**/*_tests.rs",
  ],
  exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
  perfSuite: ["**/*.perf.{js,mjs,ts,tsx}", "**/perf/**", "**/test_perf_*.py", "**/*.perf.test.*"],
  browserChecks: ["scripts/check-*.mjs", "scripts/*.browser.mjs", "scripts/lib/*.mjs"],
  browserExclude: ["**/node_modules/**", "**/dist/**"],
  mockAdapters: [],
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
const CLASS_ATTR_BLOCK = /^\[\s*class(?:\s*[~|^$*]?=|\s*\])/i;
const CLASS_SELECTOR = /(?<!\\)(?:\\\\)*\.(?:[A-Za-z_-]|\\)/;
const REGEX_PREFIX_KEYWORDS = new Set(["return", "throw", "case", "in", "of", "typeof", "void", "delete", "await", "yield", "new", "else", "do"]);
// A declaration whose value looks like CSS (a var(), a number or unit, a colour, a keyword), not prose such as
// "warning: deprecated; use x".
const CSS_TEXT = /(["'`])(?:[^"'`]*?[\s{;])?(?:--)?[a-z]+(?:-[a-z0-9]+)*\s*:\s*(?=[^;"'`]*(?:var\(|\d|#[0-9a-f]{3}|\b(?:none|auto|inherit|initial|transparent|currentColor|solid|flex|grid|block|inline|hidden|absolute|relative|fixed|bold|normal)\b))[^;"'`]+;[^"'`]*\1/i;
const ASSERTING = /\b(?:expect|assert(?:\.\w+)?)\s*\(|\.to(?:Contain|Match|Be|Equal|Include)\w*\s*\(/;

function unescapeJsChar(c) {
  if (c === "n") return "\n";
  if (c === "r") return "\r";
  if (c === "t") return "\t";
  return c;
}

/** Reads a quoted JS string starting at `start` (`'` or `"`) in linear time. */
function scanJsString(line, start) {
  const quote = line[start];
  let value = "";
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      if (i + 1 < line.length) value += unescapeJsChar(line[i + 1]);
      i += 2;
      continue;
    }
    if (c === quote) return { value, next: i + 1 };
    value += c;
    i++;
  }
  return { value, next: i };
}

/** Reads a JS template literal starting at `start` (`` ` ``), replacing each `${...}` span with `_`. */
function scanJsTemplate(line, start) {
  let value = "";
  let hasExpr = false;
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      if (i + 1 < line.length) value += unescapeJsChar(line[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") return { value, next: i + 1, hasExpr };
    if (c === "$" && line[i + 1] === "{") {
      hasExpr = true;
      value += "_";
      i += 2;
      let depth = 1;
      while (i < line.length && depth > 0) {
        const ch = line[i];
        if (ch === "'" || ch === '"') { i = scanJsString(line, i).next; continue; }
        if (ch === "`") { i = scanJsTemplate(line, i).next; continue; }
        if (line.startsWith("//", i)) { i = line.length; break; }
        if (line.startsWith("/*", i)) {
          const end = line.indexOf("*/", i + 2);
          i = end === -1 ? line.length : end + 2;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      continue;
    }
    value += c;
    i++;
  }
  return { value, next: i, hasExpr };
}

/** Skips a JS regex literal starting at `start` (`/`), respecting escapes and `[...]` classes. */
function skipJsRegex(line, start) {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") { i += 2; continue; }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") { inClass = true; i++; continue; }
    if (c === "/") {
      i++;
      while (i < line.length && /[a-z]/i.test(line[i])) i++;
      return i;
    }
    i++;
  }
  return i;
}

/** Whether a CSS selector targets a class (`.foo`, `.\!hidden`, `[class~="foo"]`) outside `[...]` values. */
function hasClassSelectorMatch(selector) {
  let stripped = "";
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === "\\") {
      stripped += selector.slice(i, i + 2);
      i++;
      continue;
    }
    if (selector[i] !== "[") {
      stripped += selector[i];
      continue;
    }
    let j = i + 1;
    let quote = null;
    while (j < selector.length) {
      const c = selector[j];
      if (c === "\\") { j += 2; continue; }
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; j++; continue; }
      if (c === "]") { j++; break; }
      j++;
    }
    if (CLASS_ATTR_BLOCK.test(selector.slice(i, j))) return true;
    i = j - 1;
  }
  return CLASS_SELECTOR.test(stripped);
}

const skipWs = (line, i) => {
  while (i < line.length && /\s/.test(line[i])) i++;
  return i;
};

/** Single-pass linear JS scanner for `.getAttribute("class")` and `.matches(".<class>")` calls in code. */
function hasClassDomCall(line) {
  let i = 0;
  let prev = "op";
  while (i < line.length) {
    const c = line[i];
    if (/\s/.test(c)) { i++; continue; }
    if (line.startsWith("//", i)) break;
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      i = end === -1 ? line.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = scanJsString(line, i).next;
      prev = "val";
      continue;
    }
    if (c === "`") {
      i = scanJsTemplate(line, i).next;
      prev = "val";
      continue;
    }
    if (c === "/" && prev === "op") {
      i = skipJsRegex(line, i);
      prev = "val";
      continue;
    }
    if (c === ".") {
      let j = skipWs(line, i + 1);
      const idStart = j;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const name = line.slice(idStart, j);
      if (name === "getAttribute" || name === "matches") {
        let k = skipWs(line, j);
        if (line.startsWith("?.", k)) k = skipWs(line, k + 2);
        if (line[k] === "(") {
          const argStart = skipWs(line, k + 1);
          const ch = line[argStart];
          if (ch === "'" || ch === '"' || ch === "`") {
            const parsed = ch === "`" ? scanJsTemplate(line, argStart) : scanJsString(line, argStart);
            const after = skipWs(line, parsed.next);
            if (name === "getAttribute") {
              if (!parsed.hasExpr && parsed.value === "class" && line[after] === ")") return true;
            } else if (line[after] === ")") {
              if (hasClassSelectorMatch(parsed.value)) return true;
            } else if (line[after] === "+") {
              if (parsed.value.startsWith(".") || hasClassSelectorMatch(parsed.value)) return true;
            }
            i = after;
            prev = "val";
            continue;
          }
        }
      }
      i = j > idStart ? j : i + 1;
      prev = j > idStart ? "val" : "op";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      prev = REGEX_PREFIX_KEYWORDS.has(line.slice(i, j)) ? "op" : "val";
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < line.length && /[0-9a-zA-Z_.]/.test(line[i])) i++;
      prev = "val";
      continue;
    }
    prev = (c === ")" || c === "]") ? "val" : "op";
    i++;
  }
  return false;
}

function isClassAssertion(line, stripped) {
  if (CLASS_ASSERTION.test(stripped)) return true;
  if (!ASSERTING.test(stripped)) return false;
  return hasClassDomCall(line);
}

export function uiFindings(file, text) {
  if (languageOf(file) !== "js") return [];
  const found = [];
  text.split("\n").forEach((line, index) => {
    const stripped = code(line, "js");
    if (isClassAssertion(line, stripped)) found.push({ line: index + 1, text: `class-name assertion: ${line.trim()}` });
    else if (ASSERTING.test(stripped) && CSS_TEXT.test(line)) found.push({ line: index + 1, text: `CSS-text assertion: ${line.trim()}` });
  });
  return found;
}

// ---- the check -------------------------------------------------------------

export function hygieneConfig(config = {}) {
  const own = config.testHygiene ?? {};
  const rules = own.rules ?? (own.ui ? [...DEFAULTS.rules, "ui-assertion"] : DEFAULTS.rules);
  return {
    ...DEFAULTS,
    ...own,
    baseline: own.baseline ?? DEFAULTS.baseline,
    extraBaseline: own.extraBaseline ?? DEFAULTS.extraBaseline,
    tests: own.tests ?? DEFAULTS.tests,
    exclude: own.exclude ?? DEFAULTS.exclude,
    perfSuite: own.perfSuite ?? DEFAULTS.perfSuite,
    browserChecks: own.browserChecks ?? DEFAULTS.browserChecks,
    browserExclude: own.browserExclude ?? DEFAULTS.browserExclude,
    mockAdapters: own.mockAdapters ?? DEFAULTS.mockAdapters,
    rules,
  };
}

function listFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

const JS_EXTRA_TEST_RULES = new Set([
  "classname-split",
  "css-file-read",
  "unasserted-computed-style-spy",
  "unfiltered-console-spy",
  "inline-browser-mock",
]);

/** Every finding per rule and file, and the perf-helper callers outside the perf suite. */
export function scan(root, settings, files = listFiles(root)) {
  const isTest = matcher(settings.tests);
  const excluded = matcher(settings.exclude);
  const inPerfSuite = matcher(settings.perfSuite);
  const isBrowserCheck = matcher(settings.browserChecks ?? DEFAULTS.browserChecks);
  const browserExcluded = matcher(settings.browserExclude ?? DEFAULTS.browserExclude);
  const isMockAdapter = matcher(settings.mockAdapters ?? DEFAULTS.mockAdapters);

  const ruleSet = new Set(settings.rules);
  const wantsBrowserSleep = ruleSet.has("browser-fixed-sleep");
  const wantsJsExtraTest = [...JS_EXTRA_TEST_RULES].some(rule => ruleSet.has(rule));

  const findings = Object.fromEntries(settings.rules.map(rule => [rule, {}]));
  const unrunBudgets = [];
  let scanned = 0;

  for (const file of files) {
    const lang = languageOf(file);
    if (!lang) continue;
    const matchTest = isTest(file) && !excluded(file);
    const matchBrowser = wantsBrowserSleep && lang === "js" && isBrowserCheck(file) && !browserExcluded(file);
    if (!matchTest && !matchBrowser) continue;

    const full = path.join(root, file);
    if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) continue;
    scanned++;
    const text = fs.readFileSync(full, "utf8");
    const add = (rule, list) => { if (list.length) findings[rule][file] = list; };

    let masked = null;
    const getMasked = () => (masked ??= maskJs(text));

    if (matchTest) {
      // The perf suite's files run the helper; a raw timing assertion fails there too, as anywhere.
      const perf = inPerfSuite(file);
      if (ruleSet.has("fixed-sleep")) add("fixed-sleep", sleepFindings(file, text));
      if (ruleSet.has("timing-assert")) {
        add("timing-assert", timingFindings(file, text));
        if (!perf && callsPerfHelper(file, text)) unrunBudgets.push(file);
      }
      if (ruleSet.has("ui-assertion")) add("ui-assertion", uiFindings(file, text));
      if (lang === "js" && wantsJsExtraTest) {
        const m = getMasked();
        if (ruleSet.has("classname-split")) add("classname-split", classNameSplitFindings(text, m));
        if (ruleSet.has("css-file-read")) add("css-file-read", cssFileReadFindings(text, m));
        if (ruleSet.has("unasserted-computed-style-spy")) add("unasserted-computed-style-spy", computedStyleSpyFindings(text, m));
        if (ruleSet.has("unfiltered-console-spy")) add("unfiltered-console-spy", unfilteredConsoleSpyFindings(text, m));
        if (ruleSet.has("inline-browser-mock") && !isMockAdapter(file)) add("inline-browser-mock", inlineBrowserMockFindings(text, m));
      }
    }

    if (matchBrowser) {
      add("browser-fixed-sleep", browserFixedSleepFindings(text, getMasked()));
    }
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

/** Strict CLI flag parser for `package-kit test-hygiene`. */
export function parseHygieneArgs(args = []) {
  let init = false;
  let update = false;
  let warnLowered = false;
  let base = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--init") init = true;
    else if (arg === "--update") update = true;
    else if (arg === "--warn-lowered") warnLowered = true;
    else if (arg === "--base") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) throw new Error("test-hygiene: --base requires a commit ref");
      base = value;
      i++;
    } else if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (!value) throw new Error("test-hygiene: --base= requires a commit ref");
      base = value;
    } else {
      throw new Error(`test-hygiene: unknown option ${arg}`);
    }
  }
  if (init && update) throw new Error("test-hygiene: --init and --update cannot be combined");
  return { init, update, warnLowered, base };
}

/**
 * Resolve the commit whose baseline this tree may not exceed.
 * An explicit non-empty base (`--base`, `PACKAGE_KIT_HYGIENE_BASE`, `PACKAGE_KIT_BASE`) fails loudly when unresolvable.
 * Otherwise picks the closest merge-base ancestor among `origin/dev`, `origin/HEAD`, `origin/main` (falling back to `HEAD~1` / `HEAD`).
 */
export function resolveBaseCommit(root, { baseArg = null, env = process.env } = {}) {
  const tryGit = args => { try { return git(root, args); } catch { return null; } };
  const nonEmpty = value => (typeof value === "string" && value.length > 0 ? value : null);
  const explicit = baseArg !== null && baseArg !== undefined
    ? baseArg
    : (nonEmpty(env.PACKAGE_KIT_HYGIENE_BASE) ?? nonEmpty(env.PACKAGE_KIT_BASE));
  if (explicit !== null) {
    const resolved = tryGit(["rev-parse", "--verify", "--end-of-options", `${explicit}^{commit}`]);
    if (!resolved) throw new Error(`test-hygiene: cannot resolve base commit ${JSON.stringify(explicit)}`);
    return resolved;
  }
  const head = tryGit(["rev-parse", "--verify", "HEAD"]);
  if (!head) return null;

  let bestBase = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ref of ["origin/dev", "origin/HEAD", "origin/main"]) {
    const base = tryGit(["merge-base", "HEAD", ref]);
    if (!base) continue;
    const distance = Number(tryGit(["rev-list", "--count", `${base}..HEAD`]) ?? Number.POSITIVE_INFINITY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestBase = base;
    }
  }
  if (!bestBase) return head;
  return bestBase === head ? (tryGit(["rev-parse", "--verify", "HEAD~1"]) ?? head) : bestBase;
}

/** Backwards-compatible baseCommit helper delegating to resolveBaseCommit. */
export function baseCommit(root, env = process.env) {
  try {
    return resolveBaseCommit(root, { env });
  } catch {
    return null;
  }
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

function sliceObject(obj, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(obj, key)) out[key] = obj[key];
  return out;
}

export function runTestHygiene({ root, config = {}, args = [], env = process.env, print = console.log, printError = console.error }) {
  let parsed;
  try {
    parsed = parseHygieneArgs(args);
  } catch (error) {
    printError(error.message);
    return 1;
  }

  const settings = hygieneConfig(config);
  const unknown = settings.rules.filter(rule => !RULES.includes(rule));
  if (unknown.length) return printError(`test-hygiene: unknown rules ${unknown.join(", ")}; known: ${RULES.join(", ")}`), 1;

  const { findings, unrunBudgets, scanned, files } = scan(root, settings);
  const current = counts(findings);
  let failed = false;
  for (const file of unrunBudgets) {
    printError(`test-hygiene: ${file} states a perf budget (perfBudget / perf_budget), but it is not in the perf suite (testHygiene.perfSuite), so its budgets never hold`);
    failed = true;
  }

  // Partition rules into one or two baseline files when `extraBaseline` is configured.
  const groups = [];
  if (settings.extraBaseline) {
    const core = settings.rules.filter(rule => CORE_RULES.includes(rule));
    const extra = settings.rules.filter(rule => EXTRA_RULES.includes(rule));
    if (core.length) groups.push({ name: settings.baseline, rules: core });
    if (extra.length) groups.push({ name: settings.extraBaseline, rules: extra });
  } else {
    groups.push({ name: settings.baseline, rules: settings.rules });
  }

  if (parsed.init) {
    for (const group of groups) {
      const baselineFile = path.join(root, group.name);
      if (fs.existsSync(baselineFile)) {
        printError(`test-hygiene: ${group.name} exists; use --update to lower it`);
        return 1;
      }
    }
    for (const group of groups) {
      const groupCurrent = sliceObject(current, group.rules);
      writeBaseline(path.join(root, group.name), groupCurrent);
      const total = Object.values(groupCurrent).reduce((sum, map) => sum + Object.values(map).reduce((a, b) => a + b, 0), 0);
      print(`test-hygiene: wrote ${group.name} with ${total} findings in ${scanned} test files; they may only shrink`);
    }
    return failed ? 1 : 0;
  }

  let baseSha;
  try {
    baseSha = resolveBaseCommit(root, { baseArg: parsed.base, env });
  } catch (error) {
    printError(error.message);
    return 1;
  }

  const allProblems = [];
  const allStale = [];
  for (const group of groups) {
    const baselineFile = path.join(root, group.name);
    const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")).rules ?? {} : {};
    const committed = committedBaseline(root, group.name, baseSha);
    const groupCurrent = sliceObject(current, group.rules);
    const { problems, stale, lowered } = compare(groupCurrent, baseline, committed, files);
    const hasRaised = problems.some(problem => problem.raised);

    if (parsed.update) {
      if (!hasRaised) {
        writeBaseline(baselineFile, lowered);
        for (const { rule, file, count, limit } of stale) print(`test-hygiene: lowered ${rule} ${file} ${limit} -> ${count}`);
      }
    } else {
      for (const entry of stale) allStale.push(entry);
    }
    for (const problem of problems) allProblems.push({ ...problem, baselineName: group.name });
  }

  const failedRules = new Set();
  for (const { rule, file, count, limit, raised, baselineName } of allProblems) {
    if (raised) {
      printError(`test-hygiene: ${baselineName} raises ${rule} for ${file} to ${count} (the base has ${limit}); the baseline may only shrink`);
    } else {
      failedRules.add(rule);
      printError(`test-hygiene: ${rule} in ${file}: ${count} findings, baseline allows ${limit}:`);
      for (const { line, text } of findings[rule][file]) printError(`  ${file}:${line}: ${text}`);
    }
    failed = true;
  }

  if (allStale.length) {
    const staleLines = allStale.map(
      ({ rule, file, count, limit }) => `test-hygiene: ${rule} in ${file} went down to ${count} (baseline ${limit}); run package-kit test-hygiene --update to lower the baseline`,
    );
    if (parsed.warnLowered && !failed) {
      printError(`WARNING ${staleLines.length} test-hygiene counts are lower than the baseline; the next lane check fails until a lane runs package-kit test-hygiene --update:`);
      for (const line of staleLines) printError(`  ${line}`);
    } else {
      for (const line of staleLines) printError(line);
      failed = true;
    }
  }

  if (failedRules.has("fixed-sleep")) printError("Wait for the condition instead (an event, a poll with a deadline), or mark a wait that must be fixed with `sleep-ok: <reason>`.");
  if (failedRules.has("timing-assert")) printError(`Move a budget into the perf helper (perfBudget / perf_budget), give a functional deadline a bound of at least ${FLOOR_SECONDS} s, or a tighter one a \`load-tolerant: <why>\` comment.`);
  for (const rule of failedRules) {
    if (RULE_HINTS[rule]) printError(RULE_HINTS[rule]);
  }
  if (!failed) print(`test-hygiene: ok (${settings.rules.join(", ")}; ${scanned} test files)`);
  return failed ? 1 : 0;
}
