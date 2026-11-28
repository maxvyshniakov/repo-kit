// Consolidated lexical JS/TS test-hygiene rules:
//   classname-split               splitting `.className` strings in tests
//   css-file-read                 reading `.css` files with `readFileSync` (or `readDataGridCss()`) in tests
//   unasserted-computed-style-spy spying on `window`/`globalThis.getComputedStyle` without a positive call assertion
//   browser-fixed-sleep           fixed sleeps in browser checks (direct, wrapper helpers, and string-evaluated waits)
//   unfiltered-console-spy        suppressing `console.error` / `console.warn` spies without total call accountability
//   inline-browser-mock           inline `ResizeObserver` / `matchMedia` mocks outside shared `mockAdapters`

import {
  arrowBodyEnd,
  collapseSnippet,
  enclosingScope,
  escapeRe,
  findDeclarationScope,
  findMatchingClose,
  hasLineMarker,
  lineAt,
  maskJs,
  parseCallArgs,
} from "./test-hygiene-lex.mjs";

export const EXTRA_RULES = [
  "classname-split",
  "css-file-read",
  "unasserted-computed-style-spy",
  "browser-fixed-sleep",
  "unfiltered-console-spy",
  "inline-browser-mock",
];

export const RULE_HINTS = {
  "classname-split": "Assert roles, states, or data attributes instead of splitting element.className.",
  "css-file-read": "Verify rendered styling in browser/story checks instead of reading .css files with readFileSync.",
  "unasserted-computed-style-spy": "Assert that the getComputedStyle spy was actually called (e.g. expect(spy).toHaveBeenCalled()) so it cannot pass vacuously under happy-dom.",
  "browser-fixed-sleep": "Wait for a deterministic DOM, style, font, animation, or frame condition instead of a fixed sleep, pair watchdogs with clearTimeout, or annotate intentional waits with `// sleep-ok: <reason>`.",
  "unfiltered-console-spy": "Account for every suppressed console.error/warn call via expect(spy).not.toHaveBeenCalled(), exact call-count + argument assertions, or a shared captureConsoleCalls helper.",
  "inline-browser-mock": "Use a shared matchMedia / ResizeObserver test adapter (configured in testHygiene.mockAdapters) instead of duplicating inline mocks.",
};

const SLEEP_OK = /sleep-ok:\s*\S+/;

// ---- Rule 1: classname-split -----------------------------------------------

const CLASSNAME_SPLIT_DIRECT = /(?:\?\.|\.)\s*className\s*!?\s*(?:\?\.|\.)\s*(?:trim\s*\(\s*\)\s*(?:\?\.|\.)\s*)?split\s*\(/g;
const CLASSNAME_SPLIT_FALLBACK = new RegExp(
  "\\(\\s*[^()\\n]*(?:\\?\\.|\\.)\\s*className\\s*!?\\s*(?:\\?\\?|\\|\\|)\\s*[\"'`]{2}\\s*\\)"
    + "\\s*(?:\\?\\.|\\.)\\s*(?:trim\\s*\\(\\s*\\)\\s*(?:\\?\\.|\\.)\\s*)?split\\s*\\(",
  "g",
);

export function classNameSplitFindings(text, masked = maskJs(text)) {
  const seen = new Set();
  const found = [];
  for (const re of [CLASSNAME_SPLIT_DIRECT, CLASSNAME_SPLIT_FALLBACK]) {
    for (const match of masked.codeOnly.matchAll(re)) {
      const openParen = match.index + match[0].length - 1;
      const call = parseCallArgs(masked.codeOnly, openParen);
      const end = call ? call.end + 1 : match.index + match[0].length;
      const line = lineAt(text, match.index);
      const key = `${line}:${openParen}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ line, text: `className.split assertion: ${collapseSnippet(text, match.index, end)}` });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// ---- Rule 2: css-file-read -------------------------------------------------

const CSS_LITERAL = /\.css(?=["'`])/i;
const NON_CSS_EXT_LITERAL = /\.(?:[cm]?[jt]sx?|json|html?|md|txt|svg|png|ya?ml|toml)(?=["'`])/i;
const ENDS_WITH_CSS = /\.endsWith\s*\(\s*["'`]\.css["'`]\s*\)/i;
const READ_FILE_SYNC = /\breadFileSync\s*\(/g;
const READ_DATA_GRID_CSS = /(?<!\.)\breadDataGridCss\s*\(/g;
const NON_TEMPLATE_BRACE = /(?<!\$)\{/;

function receiverStart(codeOnly, dotIndex) {
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(codeOnly[i])) i--;
  while (i >= 0) {
    const ch = codeOnly[i];
    if (ch === ")" || ch === "]") {
      const close = ch;
      const open = close === ")" ? "(" : "[";
      let depth = 1;
      i--;
      while (i >= 0 && depth > 0) {
        if (codeOnly[i] === close) depth++;
        else if (codeOnly[i] === open) depth--;
        i--;
      }
      continue;
    }
    if (/[\w$.?]/.test(ch)) {
      i--;
      continue;
    }
    break;
  }
  return i + 1;
}

function collectCssPathVars(noComments, codeOnly) {
  const scoped = [];
  const assignments = [];
  const declRe = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?=\s*/g;
  for (const match of codeOnly.matchAll(declRe)) {
    const name = match[1];
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    for (; end < codeOnly.length; end++) {
      const ch = codeOnly[end];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === ";" || ch === "\n")) break;
    }
    const rawInit = noComments.slice(start, end);
    const codeInit = codeOnly.slice(start, end);
    if (NON_TEMPLATE_BRACE.test(codeInit)) continue;
    const scope = enclosingScope(codeOnly, match.index);
    const entry = { name, pos: match.index, start: match.index, end: scope.end, rawInit, codeInit, isCss: false };
    if (CSS_LITERAL.test(rawInit) || ENDS_WITH_CSS.test(rawInit)) {
      entry.isCss = true;
      scoped.push({ name, start: entry.start, end: entry.end });
    }
    assignments.push(entry);
  }

  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const entry of assignments) {
      if (entry.isCss) continue;
      for (const known of scoped) {
        if (entry.pos >= known.start && entry.pos <= known.end && new RegExp(`\\b${escapeRe(known.name)}\\b`).test(entry.codeInit)) {
          entry.isCss = true;
          scoped.push({ name: entry.name, start: entry.start, end: entry.end });
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  const isCssExpr = (rawExpr, codeExpr, atPos) => {
    if (CSS_LITERAL.test(rawExpr) || ENDS_WITH_CSS.test(rawExpr)) return true;
    for (const known of scoped) {
      if (atPos >= known.start && atPos <= known.end && new RegExp(`\\b${escapeRe(known.name)}\\b`).test(codeExpr)) {
        return true;
      }
    }
    return false;
  };

  for (const m of codeOnly.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+/g)) {
    const openParen = codeOnly.indexOf("(", m.index);
    const closeParen = findMatchingClose(codeOnly, openParen);
    const iterStart = m.index + m[0].length;
    if (!isCssExpr(noComments.slice(iterStart, closeParen), codeOnly.slice(iterStart, closeParen), m.index)) continue;
    let bodyStart = closeParen + 1;
    while (bodyStart < codeOnly.length && /\s/.test(codeOnly[bodyStart])) bodyStart++;
    const bodyEnd = codeOnly[bodyStart] === "{"
      ? findMatchingClose(codeOnly, bodyStart)
      : (codeOnly.indexOf("\n", bodyStart) === -1 ? codeOnly.length : codeOnly.indexOf("\n", bodyStart));
    scoped.push({ name: m[1], start: bodyStart, end: bodyEnd });
  }

  for (const m of codeOnly.matchAll(/\.\s*(?:forEach|map|flatMap|filter)\s*\(\s*(?:\(\s*)?(\w+)/g)) {
    const recvStart = receiverStart(codeOnly, m.index);
    if (!isCssExpr(noComments.slice(recvStart, m.index), codeOnly.slice(recvStart, m.index), m.index)) continue;
    const openParen = codeOnly.indexOf("(", m.index);
    const closeParen = findMatchingClose(codeOnly, openParen);
    scoped.push({ name: m[1], start: openParen, end: closeParen });
  }

  return scoped;
}

function collectReadFileHelpers(codeOnly) {
  const helpers = [];
  const parseParams = paramList => paramList
    .split(",")
    .map(p => p.trim().replace(/^\.\.\./, "").match(/^(\w+)/)?.[1] ?? null);

  const checkBody = (name, paramList, bodyStart, bodyEnd, defStart, defEnd) => {
    const body = codeOnly.slice(bodyStart, bodyEnd);
    if (!/\breadFileSync\s*\(/.test(body)) return;
    const params = parseParams(paramList);
    for (const m of body.matchAll(READ_FILE_SYNC)) {
      const openParen = bodyStart + m.index + m[0].length - 1;
      const call = parseCallArgs(codeOnly, openParen);
      if (!call || !call.args.length) continue;
      const firstArg = codeOnly.slice(call.args[0].start, call.args[0].end);
      for (let idx = 0; idx < params.length; idx++) {
        if (params[idx] && new RegExp(`\\b${escapeRe(params[idx])}\\b`).test(firstArg)) {
          const scope = enclosingScope(codeOnly, defStart);
          helpers.push({ name, paramIndex: idx, scopeStart: scope.start, scopeEnd: scope.end, defStart, defEnd });
        }
      }
    }
  };

  for (const m of codeOnly.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingClose(codeOnly, openParen);
    const paramList = codeOnly.slice(openParen + 1, closeParen);
    const brace = codeOnly.indexOf("{", closeParen);
    if (brace === -1 || /[^\s:<>[\]\w|&.,?]/.test(codeOnly.slice(closeParen + 1, brace))) continue;
    const closeBrace = findMatchingClose(codeOnly, brace);
    checkBody(m[1], paramList, brace, closeBrace + 1, m.index, closeBrace + 1);
  }

  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingClose(codeOnly, openParen);
    const paramList = codeOnly.slice(openParen + 1, closeParen);
    const afterParen = codeOnly.slice(closeParen + 1, closeParen + 60);
    const arrow = afterParen.match(/^(?:\s*:\s*[^=]+)?\s*=>\s*/);
    if (!arrow) continue;
    const bodyStart = closeParen + 1 + arrow[0].length;
    const bodyEnd = arrowBodyEnd(codeOnly, bodyStart);
    checkBody(m[1], paramList, bodyStart, bodyEnd, m.index, bodyEnd);
  }

  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(\w+)\s*=>\s*/g)) {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = arrowBodyEnd(codeOnly, bodyStart);
    checkBody(m[1], m[2], bodyStart, bodyEnd, m.index, bodyEnd);
  }

  return helpers;
}

export function cssFileReadFindings(text, masked = maskJs(text)) {
  const { noComments, codeOnly } = masked;
  const scopedVars = collectCssPathVars(noComments, codeOnly);
  const helpers = collectReadFileHelpers(codeOnly);
  const seen = new Set();
  const found = [];

  const argIsCss = (rawArg, codeArg, atPos) => {
    if (CSS_LITERAL.test(rawArg)) return true;
    if (NON_CSS_EXT_LITERAL.test(rawArg)) return false;
    for (const { name, start, end } of scopedVars) {
      if (atPos >= start && atPos <= end && new RegExp(`\\b${escapeRe(name)}\\b`).test(codeArg)) return true;
    }
    return false;
  };

  for (const match of codeOnly.matchAll(READ_FILE_SYNC)) {
    const openParen = match.index + match[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || !call.args.length) continue;
    const arg0 = call.args[0];
    if (!argIsCss(noComments.slice(arg0.start, arg0.end), codeOnly.slice(arg0.start, arg0.end), match.index)) continue;
    const line = lineAt(text, match.index);
    const key = `${line}:${openParen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ line, text: `readFileSync(*.css) in test: ${collapseSnippet(text, match.index, call.end + 1)}` });
  }

  for (const match of codeOnly.matchAll(READ_DATA_GRID_CSS)) {
    if (/\bfunction\s+$/.test(codeOnly.slice(Math.max(0, match.index - 20), match.index))) continue;
    const openParen = match.index + match[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    const end = call ? call.end + 1 : match.index + match[0].length;
    const line = lineAt(text, match.index);
    const key = `${line}:${openParen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ line, text: `readDataGridCss() in test: ${collapseSnippet(text, match.index, end)}` });
  }

  for (const helper of helpers) {
    const callRe = new RegExp(`(?<!\\.)\\b${escapeRe(helper.name)}\\s*\\(`, "g");
    const slice = codeOnly.slice(helper.scopeStart, helper.scopeEnd);
    for (const m of slice.matchAll(callRe)) {
      const absIdx = helper.scopeStart + m.index;
      if (absIdx >= helper.defStart && absIdx <= helper.defEnd) continue;
      const openParen = absIdx + m[0].length - 1;
      const call = parseCallArgs(codeOnly, openParen);
      if (!call || !call.args[helper.paramIndex]) continue;
      const arg = call.args[helper.paramIndex];
      if (!argIsCss(noComments.slice(arg.start, arg.end), codeOnly.slice(arg.start, arg.end), absIdx)) continue;
      const line = lineAt(text, absIdx);
      const key = `${line}:${openParen}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ line, text: `readFileSync(*.css) via ${helper.name}(): ${collapseSnippet(text, absIdx, call.end + 1)}` });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

// ---- Rule 3: unasserted-computed-style-spy ---------------------------------

const SPY_ON_CALL = /(?:\b(?:vi|jest)\s*\.\s*)?\bspyOn\s*\(/g;
const COMPUTED_STYLE_ARGS = /^\s*(?:window|globalThis)\s*,\s*["'`]getComputedStyle["'`]\s*,?\s*$/;
const ASSIGNED_BEFORE = /(?:(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?|(\w+))\s*=\s*$/;
const POSITIVE_COUNT_MATCHER = "(?:toBeGreaterThan\\s*\\(\\s*0\\s*\\)|toBeGreaterThanOrEqual\\s*\\(\\s*[1-9]\\d*\\s*\\)"
  + "|not\\s*\\.\\s*toBe\\s*\\(\\s*0\\s*\\)|toBe\\s*\\(\\s*[1-9]\\d*\\s*\\))";

function isSpyAssertedCalled(scopeCode, spyName) {
  const n = escapeRe(spyName);
  const optMsg = "(?:\\s*,\\s*[^)]*)?";

  const calledRe = new RegExp(
    `\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*(?:toHaveBeen(?:Last|Nth)?Called(?:With|Once)?|toBeCalled(?:With)?)\\s*\\(`,
  );
  if (calledRe.test(scopeCode)) return true;

  const timesRe = new RegExp(
    `\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*(?:toHaveBeenCalledTimes|toBeCalledTimes)\\s*\\(\\s*([^)]+)\\)`,
    "g",
  );
  for (const m of scopeCode.matchAll(timesRe)) {
    if (/^[1-9]\d*$/.test(m[1].trim())) return true;
  }

  const lenPositive = new RegExp(
    `\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length${optMsg}\\s*\\)\\s*\\.\\s*${POSITIVE_COUNT_MATCHER}`,
  );
  if (lenPositive.test(scopeCode)) return true;

  const filterLenRe = new RegExp(
    `\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*filter\\s*\\(`,
    "g",
  );
  for (const m of scopeCode.matchAll(filterLenRe)) {
    const expectOpen = scopeCode.indexOf("(", m.index);
    const expectClose = findMatchingClose(scopeCode, expectOpen);
    const inner = scopeCode.slice(expectOpen + 1, expectClose);
    if (!/\.\s*length\b/.test(inner)) continue;
    const after = scopeCode.slice(expectClose + 1, expectClose + 80);
    if (new RegExp(`^\\s*\\.\\s*${POSITIVE_COUNT_MATCHER}`).test(after)) return true;
  }

  const helperRe = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:\\(\\s*\\)|\\w+)\\s*=>[^;\\n]*`
      + `\\b${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*filter\\b[^;\\n]*\\.\\s*length\\b`,
    "g",
  );
  for (const m of scopeCode.matchAll(helperRe)) {
    const h = escapeRe(m[1]);
    const helperAssert = new RegExp(
      `\\bexpect\\s*\\(\\s*${h}\\s*\\([^)]*\\)${optMsg}\\s*\\)\\s*\\.\\s*${POSITIVE_COUNT_MATCHER}`,
    );
    if (helperAssert.test(scopeCode)) return true;
  }

  const callsPositive = new RegExp(
    `\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls${optMsg}\\s*\\)\\s*\\.\\s*`
      + `(?:not\\s*\\.\\s*toHaveLength\\s*\\(\\s*0\\s*\\)|toHaveLength\\s*\\(\\s*[1-9]\\d*\\s*\\)`
      + `|(?:toEqual|toStrictEqual|toMatchObject)\\s*\\(\\s*\\[\\s*\\[)`,
  );
  if (callsPositive.test(scopeCode)) return true;

  const nodeAssert = new RegExp(
    `\\bassert(?:\\.\\w+)?\\s*\\([^)]*\\b${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length\\s*(?:>\\s*0|>=\\s*[1-9]\\d*)`,
  );
  if (nodeAssert.test(scopeCode)) return true;
  const nodeAssertEq = new RegExp(
    `\\bassert\\s*\\.\\s*(?:strictEqual|equal)\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length\\s*,\\s*[1-9]\\d*\\s*[,)]`,
  );
  if (nodeAssertEq.test(scopeCode)) return true;

  return false;
}

export function computedStyleSpyFindings(text, masked = maskJs(text)) {
  const { noComments, codeOnly } = masked;
  const found = [];

  for (const match of codeOnly.matchAll(SPY_ON_CALL)) {
    const openParen = match.index + match[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call) continue;
    const rawArgs = noComments.slice(openParen + 1, call.end);
    if (!COMPUTED_STYLE_ARGS.test(rawArgs)) continue;

    const before = codeOnly.slice(Math.max(0, match.index - 160), match.index);
    const assign = before.match(ASSIGNED_BEFORE);
    const declaredName = assign?.[1] ?? null;
    const reassignedName = assign?.[2] ?? null;
    const spyName = declaredName ?? reassignedName;
    if (spyName) {
      const scope = declaredName
        ? enclosingScope(codeOnly, match.index)
        : findDeclarationScope(codeOnly, match.index, spyName);
      const searchStart = declaredName ? match.index : scope.start;
      if (isSpyAssertedCalled(codeOnly.slice(searchStart, scope.end), spyName)) continue;
    }

    const line = lineAt(text, match.index);
    found.push({ line, text: `getComputedStyle spy without positive call assertion: ${collapseSnippet(text, match.index, call.end + 1)}` });
  }
  return found;
}

// ---- Rule 4: browser-fixed-sleep -------------------------------------------

const ZERO_LITERAL = /^\s*0(?:\.0+)?\s*$/;
const POSITIVE_NUMBER = /^\s*(?:\d[\d_]*(?:\.\d+)?|\.\d+)\s*$/;
const WAIT_FOR_TIMEOUT = /\bwaitForTimeout\s*\(/g;
const SET_TIMEOUT_CALL = /(?<!\.)\bsetTimeout\s*\(|\b(?:globalThis|window|timers)\s*\.\s*setTimeout\s*\(/g;
const WELL_KNOWN_SLEEP_CALL = /(?:\bBun\.|(?<![\w.]))(?:pause|sleep|delay)\s*\(/g;
const STRING_EVAL_CALL = /(?:(?:\.\s*|\b)(?:eval|evaluate|page|chrome)\s*\(|\bbrowser\s*\()/g;

/** Whether a delay argument expression represents a non-zero wait (positive number or non-zero dynamic expression). */
function isNonZeroDelay(expr) {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  if (ZERO_LITERAL.test(trimmed)) return false;
  if (POSITIVE_NUMBER.test(trimmed)) return Number(trimmed.replaceAll("_", "")) > 0;
  // Exclude callback functions / string literals when checking 1-arg helpers.
  if (/^(?:["'`]|(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|function\b)/.test(trimmed)) return false;
  return true;
}

/** Collect local sleep wrapper functions whose body wraps `new Promise(... setTimeout(..., param))`. */
function collectSleepWrappers(codeOnly) {
  const wrappers = [];
  const parseParams = paramList => paramList.split(",").map(raw => {
    const trimmed = raw.trim().replace(/^\.\.\./, "");
    const name = trimmed.match(/^(\w+)/)?.[1] ?? null;
    const eqIdx = trimmed.indexOf("=");
    const defaultExpr = eqIdx === -1 ? null : trimmed.slice(eqIdx + 1).trim();
    return { name, defaultExpr };
  });

  const inspect = (name, paramList, bodyStart, bodyEnd, defStart, defEnd) => {
    const body = codeOnly.slice(bodyStart, bodyEnd);
    if (!/\bnew\s+Promise\b/.test(body) || !/\bsetTimeout\s*\(/.test(body)) return;
    const params = parseParams(paramList);
    for (const m of body.matchAll(/\bsetTimeout\s*\(/g)) {
      const absTimeout = bodyStart + m.index;
      if (hasPairedClearTimeout(codeOnly, absTimeout)) continue;
      const openParen = absTimeout + m[0].length - 1;
      const call = parseCallArgs(codeOnly, openParen);
      if (!call || call.args.length < 2) continue;
      const delayExpr = codeOnly.slice(call.args[1].start, call.args[1].end);
      for (let idx = 0; idx < params.length; idx++) {
        if (params[idx].name && new RegExp(`\\b${escapeRe(params[idx].name)}\\b`).test(delayExpr)) {
          const scope = enclosingScope(codeOnly, defStart);
          const defaultNonZero = Boolean(params[idx].defaultExpr && isNonZeroDelay(params[idx].defaultExpr));
          wrappers.push({ name, paramIndex: idx, defaultNonZero, scopeStart: scope.start, scopeEnd: scope.end, defStart, defEnd });
          return;
        }
      }
    }
  };

  for (const m of codeOnly.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingClose(codeOnly, openParen);
    const paramList = codeOnly.slice(openParen + 1, closeParen);
    const brace = codeOnly.indexOf("{", closeParen);
    if (brace === -1 || /[^\s:<>[\]\w|&.,?]/.test(codeOnly.slice(closeParen + 1, brace))) continue;
    const closeBrace = findMatchingClose(codeOnly, brace);
    inspect(m[1], paramList, brace, closeBrace + 1, m.index, closeBrace + 1);
  }

  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingClose(codeOnly, openParen);
    const paramList = codeOnly.slice(openParen + 1, closeParen);
    const afterParen = codeOnly.slice(closeParen + 1, closeParen + 60);
    const arrow = afterParen.match(/^(?:\s*:\s*[^=]+)?\s*=>\s*/);
    if (!arrow) continue;
    const bodyStart = closeParen + 1 + arrow[0].length;
    const bodyEnd = arrowBodyEnd(codeOnly, bodyStart);
    inspect(m[1], paramList, bodyStart, bodyEnd, m.index, bodyEnd);
  }

  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(\w+)\s*=>\s*/g)) {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = arrowBodyEnd(codeOnly, bodyStart);
    inspect(m[1], m[2], bodyStart, bodyEnd, m.index, bodyEnd);
  }

  return wrappers;
}

/** Collect imported `wait` identifier (if any) so `wait(ms)` from a sleep helper is caught without flagging `waitFor`. */
function hasImportedWait(codeOnly) {
  return /\bimport\s*\{[^}]*\bwait\b[^}]*\}\s*from\b/.test(codeOnly);
}

/** Whether a string/template literal's raw JS text contains a fixed browser sleep (`waitForTimeout` or non-zero `setTimeout` without `clearTimeout`). */
function stringContainsFixedSleep(rawLiteral) {
  const trimmed = rawLiteral.trim();
  if (trimmed.length < 2) return false;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  if (trimmed[trimmed.length - 1] !== quote) return false;
  const inner = trimmed.slice(1, -1).replace(/\\(["'`\\])/g, "$1");
  const { codeOnly } = maskJs(inner);
  if (/\bwaitForTimeout\s*\(/.test(codeOnly)) return true;
  if (!/\bsetTimeout\s*\(/.test(codeOnly)) return false;
  if (/\bclearTimeout\s*\(/.test(codeOnly)) return false;
  for (const m of codeOnly.matchAll(/\bsetTimeout\s*\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || call.args.length < 2) continue;
    const delayExpr = codeOnly.slice(call.args[1].start, call.args[1].end);
    if (isNonZeroDelay(delayExpr)) return true;
  }
  return false;
}

/** Collect local string/template constants whose literal contents contain a fixed browser sleep (e.g. `const PROBE = \`...setTimeout(...)\`;`). */
function collectSleepStringVars(noComments, codeOnly) {
  const vars = new Map();
  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?=\s*/g)) {
    const name = m[1];
    const start = m.index + m[0].length;
    const first = noComments[start];
    if (first !== '"' && first !== "'" && first !== "`") continue;
    let end = start + 1;
    if (first === "`") {
      let exprDepth = 0;
      while (end < codeOnly.length) {
        if (codeOnly[end] === "$" && codeOnly[end + 1] === "{") { exprDepth++; end += 2; continue; }
        if (exprDepth > 0) {
          if (codeOnly[end] === "{") exprDepth++;
          else if (codeOnly[end] === "}") exprDepth--;
          end++;
          continue;
        }
        if (codeOnly[end] === "`") { end++; break; }
        end++;
      }
    } else {
      while (end < codeOnly.length && codeOnly[end] !== first && codeOnly[end] !== "\n") end++;
      if (end < codeOnly.length && codeOnly[end] === first) end++;
    }
    const rawInit = noComments.slice(start, end).trim();
    if (stringContainsFixedSleep(rawInit)) {
      vars.set(name, { lineIndex: lineAt(noComments, m.index) - 1 });
    }
  }
  return vars;
}

const TIMER_ASSIGNED_BEFORE = /(?:(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?|(?:[\w$?.]+\.)?(\w+))\s*=\s*$/;

/** Whether `setTimeout` at `pos` stores its handle and pairs with `clearTimeout(<handle>)` in its scope. */
function hasPairedClearTimeout(codeOnly, pos) {
  const before = codeOnly.slice(Math.max(0, pos - 120), pos);
  const assign = before.match(TIMER_ASSIGNED_BEFORE);
  const varName = assign?.[1] ?? assign?.[2] ?? null;
  if (!varName) return false;
  const scope = assign?.[1]
    ? enclosingScope(codeOnly, pos)
    : findDeclarationScope(codeOnly, pos, varName);
  const clearRe = new RegExp(`\\bclearTimeout\\s*\\([^)]*\\b${escapeRe(varName)}\\b`);
  return clearRe.test(codeOnly.slice(scope.start, scope.end));
}

export function browserFixedSleepFindings(text, masked = maskJs(text)) {
  const { noComments, codeOnly } = masked;
  const rawLines = text.split("\n");
  const wrappers = collectSleepWrappers(codeOnly);
  const wrapperNames = new Set(wrappers.map(w => w.name));
  const sleepStringVars = collectSleepStringVars(noComments, codeOnly);
  const seen = new Set();
  const found = [];

  const record = (pos, end, message, extraLineIndex = -1) => {
    const line = lineAt(text, pos);
    if (hasLineMarker(rawLines, line - 1, SLEEP_OK)) return;
    if (extraLineIndex >= 0 && hasLineMarker(rawLines, extraLineIndex, SLEEP_OK)) return;
    const key = `${line}:${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, text: `${message}: ${collapseSnippet(text, pos, end)}` });
  };

  const inWrapperDef = pos => wrappers.some(w => pos >= w.defStart && pos <= w.defEnd);

  // 1. Direct `waitForTimeout(...)`
  for (const m of codeOnly.matchAll(WAIT_FOR_TIMEOUT)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    const end = call ? call.end + 1 : m.index + m[0].length;
    record(m.index, end, "fixed browser sleep");
  }

  const hasTimersPromises = /\bfrom\s+["'`](?:node:)?timers\/promises["'`]/.test(noComments);

  // 2. Direct `setTimeout(...)` (inside `new Promise` or bare without `clearTimeout`, excluding `0` yields and wrapper definitions)
  for (const m of codeOnly.matchAll(SET_TIMEOUT_CALL)) {
    if (inWrapperDef(m.index)) continue;
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || !call.args.length) continue;
    const end = call.end + 1;

    if (call.args.length >= 2) {
      const delayExpr = codeOnly.slice(call.args[1].start, call.args[1].end);
      if (!isNonZeroDelay(delayExpr)) continue;
    } else {
      // 1-arg `setTimeout(cb)` is a 0-delay macrotask yield; only `timers/promises` `setTimeout(ms)` or a positive numeric literal is a wait.
      const arg0 = codeOnly.slice(call.args[0].start, call.args[0].end).trim();
      const isPositiveLiteral = POSITIVE_NUMBER.test(arg0) && Number(arg0.replaceAll("_", "")) > 0;
      if (!isPositiveLiteral && !(hasTimersPromises && isNonZeroDelay(arg0))) continue;
    }
    if (hasPairedClearTimeout(codeOnly, m.index)) continue;
    record(m.index, end, "fixed browser sleep");
  }

  // 3. Local sleep wrapper call sites (any name whose body wraps `new Promise(... setTimeout(..., param))`)
  for (const wrapper of wrappers) {
    const callRe = new RegExp(`(?<!\\.)\\b${escapeRe(wrapper.name)}\\s*\\(`, "g");
    const slice = codeOnly.slice(wrapper.scopeStart, wrapper.scopeEnd);
    for (const m of slice.matchAll(callRe)) {
      const absIdx = wrapper.scopeStart + m.index;
      if (absIdx >= wrapper.defStart && absIdx <= wrapper.defEnd) continue;
      if (/\bfunction\s+$/.test(codeOnly.slice(Math.max(0, absIdx - 20), absIdx))) continue;
      const openParen = absIdx + m[0].length - 1;
      const call = parseCallArgs(codeOnly, openParen);
      if (!call) continue;
      const arg = call.args[wrapper.paramIndex];
      if (arg) {
        if (!isNonZeroDelay(codeOnly.slice(arg.start, arg.end))) continue;
      } else if (!wrapper.defaultNonZero) {
        continue;
      }
      record(absIdx, call.end + 1, `fixed browser sleep via ${wrapper.name}()`);
    }
  }

  // 4. Imported / well-known sleep helpers: `pause(ms)`, `sleep(ms)`, `delay(ms)`, `Bun.sleep(ms)`, imported `wait(ms)`
  for (const m of codeOnly.matchAll(WELL_KNOWN_SLEEP_CALL)) {
    const nameMatch = m[0].match(/(\w+)\s*\($/);
    const name = nameMatch?.[1] ?? "";
    if (wrapperNames.has(name)) continue;
    if (/\bfunction\s+$/.test(codeOnly.slice(Math.max(0, m.index - 20), m.index))) continue;
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || !call.args.length) continue;
    const arg0 = codeOnly.slice(call.args[0].start, call.args[0].end);
    if (!isNonZeroDelay(arg0)) continue;
    record(m.index, call.end + 1, "fixed browser sleep");
  }

  if (hasImportedWait(codeOnly) && !wrapperNames.has("wait")) {
    for (const m of codeOnly.matchAll(/(?<![\w.])wait\s*\(/g)) {
      if (/\bfunction\s+$/.test(codeOnly.slice(Math.max(0, m.index - 20), m.index))) continue;
      const openParen = m.index + m[0].length - 1;
      const call = parseCallArgs(codeOnly, openParen);
      if (!call || !call.args.length) continue;
      const arg0 = codeOnly.slice(call.args[0].start, call.args[0].end);
      if (!isNonZeroDelay(arg0)) continue;
      record(m.index, call.end + 1, "fixed browser sleep via wait()");
    }
  }

  // 5. String-evaluated browser waits: `eval("...")`, `evaluate("...")`, `client.page("...")`, `browser("eval", "...")`
  for (const m of codeOnly.matchAll(STRING_EVAL_CALL)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || !call.args.length) continue;

    let scriptArg = call.args[0];
    if (/\bbrowser\s*\($/.test(m[0])) {
      const firstRaw = noComments.slice(call.args[0].start, call.args[0].end).trim();
      if (!/^["'`]eval["'`]$/.test(firstRaw) || call.args.length < 2) continue;
      scriptArg = call.args[1];
    }

    const rawScript = noComments.slice(scriptArg.start, scriptArg.end).trim();
    if (stringContainsFixedSleep(rawScript)) {
      record(m.index, call.end + 1, "string-evaluated browser sleep");
      continue;
    }
    const varInfo = sleepStringVars.get(rawScript);
    if (varInfo) {
      record(m.index, call.end + 1, "string-evaluated browser sleep", varInfo.lineIndex);
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

// ---- Rule 5: unfiltered-console-spy ----------------------------------------

const CONSOLE_SPY_ARGS = /^\s*console\s*,\s*["'`](error|warn)["'`]\s*,?\s*$/;
const MOCK_SUPPRESS = /^\s*\.\s*(?:mockImplementation(?:Once)?|mockReturnValue(?:Once)?)\s*\(/;
const POSITIVE_CALL_ITEM_MATCHER = /^\s*\.\s*(?!not\b)(?:toBe|toEqual|toStrictEqual|toContain|toMatch|toMatchObject|toHaveProperty|toBeDefined|toBeTruthy)\s*\(/;

/** Whether `scopeCode` asserts total call accountability on `targetPattern` (a spy variable or `console.error`/`console.warn`). */
function isConsoleSpyAccountedFor(scopeCode, targetPattern) {
  const n = targetPattern;
  const optMsg = "(?:\\s*,\\s*[^)]*)?";

  // 1. Zero-call assertions:
  //    expect(spy).not.toHaveBeenCalled() / expect(spy).toHaveBeenCalledTimes(0) /
  //    expect(spy.mock.calls).toHaveLength(0) / expect(spy.mock.calls).toEqual([]) /
  //    expect(spy.mock.calls.length).toBe(0) / assert.(strict)Equal(spy.mock.calls.length, 0)
  if (new RegExp(`\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*not\\s*\\.\\s*(?:toHaveBeenCalled|toBeCalled)\\s*\\(\\s*\\)`).test(scopeCode)) {
    return true;
  }
  if (new RegExp(`\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*(?:toHaveBeenCalledTimes|toBeCalledTimes)\\s*\\(\\s*0\\s*\\)`).test(scopeCode)) {
    return true;
  }
  if (new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls${optMsg}\\s*\\)\\s*\\.\\s*toHaveLength\\s*\\(\\s*0\\s*\\)`).test(scopeCode)) {
    return true;
  }
  if (new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length${optMsg}\\s*\\)\\s*\\.\\s*(?:toBe|toEqual)\\s*\\(\\s*0\\s*\\)`).test(scopeCode)) {
    return true;
  }
  if (new RegExp(`\\bassert\\s*\\.\\s*(?:strictEqual|equal)\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length\\s*,\\s*0\\s*[,)]`).test(scopeCode)) {
    return true;
  }

  // 2. Exhaustive `spy.mock.calls` equality (non-negated): toEqual / toStrictEqual
  if (new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls${optMsg}\\s*\\)\\s*\\.\\s*(?:toEqual|toStrictEqual)\\s*\\(`).test(scopeCode)) {
    return true;
  }

  // 3. Exact call-count assertion PAIRED with positive argument assertion
  const hasExactCount =
    new RegExp(`\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*(?:toHaveBeenCalledTimes|toBeCalledTimes)\\s*\\(\\s*[^)]+\\)`).test(scopeCode)
    || new RegExp(`\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*toHaveBeenCalledOnce\\s*\\(\\s*\\)`).test(scopeCode)
    || new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls${optMsg}\\s*\\)\\s*\\.\\s*toHaveLength\\s*\\(\\s*[^)]+\\)`).test(scopeCode)
    || new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\.\\s*length${optMsg}\\s*\\)\\s*\\.\\s*(?:toBe|toEqual)\\s*\\(\\s*[^)]+\\)`).test(scopeCode);

  if (hasExactCount) {
    if (new RegExp(`\\bexpect\\s*\\(\\s*${n}${optMsg}\\s*\\)\\s*\\.\\s*(?:toHaveBeen(?:Last|Nth)?CalledWith|toBeCalledWith)\\s*\\(`).test(scopeCode)) {
      return true;
    }
    const callItemRe = new RegExp(`\\bexpect\\s*\\(\\s*${n}\\s*\\.\\s*mock\\s*\\.\\s*calls\\s*\\[`, "g");
    for (const m of scopeCode.matchAll(callItemRe)) {
      const expectOpen = scopeCode.indexOf("(", m.index);
      const expectClose = findMatchingClose(scopeCode, expectOpen);
      const after = scopeCode.slice(expectClose + 1, expectClose + 80);
      if (POSITIVE_CALL_ITEM_MATCHER.test(after)) return true;
    }
  }

  return false;
}

/** Whether `scope` is the callback body of a `beforeEach(...)` call. */
function isBeforeEachBody(codeOnly, scope) {
  if (scope.start <= 0) return false;
  const before = codeOnly.slice(Math.max(0, scope.start - 80), scope.start);
  return /\bbeforeEach\s*\(\s*(?:async\s+)?(?:\(\s*\)\s*=>|function\b[^{]*)\s*$/.test(before);
}

/** Extract all `afterEach(...)` callback bodies directly within `containerCode`. */
function collectAfterEachBodies(containerCode) {
  const bodies = [];
  for (const m of containerCode.matchAll(/\bafterEach\s*\(/g)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(containerCode, openParen);
    if (!call) continue;
    bodies.push(containerCode.slice(openParen + 1, call.end));
  }
  return bodies;
}

export function unfilteredConsoleSpyFindings(text, masked = maskJs(text)) {
  const { noComments, codeOnly } = masked;
  const found = [];

  for (const match of codeOnly.matchAll(SPY_ON_CALL)) {
    const openParen = match.index + match[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call) continue;
    const rawArgs = noComments.slice(openParen + 1, call.end);
    const consoleMatch = rawArgs.match(CONSOLE_SPY_ARGS);
    if (!consoleMatch) continue;
    const consoleMethod = consoleMatch[1];

    const before = codeOnly.slice(Math.max(0, match.index - 160), match.index);
    const assign = before.match(ASSIGNED_BEFORE);
    const declaredName = assign?.[1] ?? null;
    const reassignedName = assign?.[2] ?? null;
    const spyName = declaredName ?? reassignedName;

    const afterCall = codeOnly.slice(call.end + 1, call.end + 80);
    let isSuppressing = MOCK_SUPPRESS.test(afterCall);
    const immediateScope = enclosingScope(codeOnly, match.index);

    if (!isSuppressing && spyName) {
      const checkScope = declaredName ? immediateScope : findDeclarationScope(codeOnly, match.index, spyName);
      const suppressRe = new RegExp(`\\b${escapeRe(spyName)}\\s*\\.\\s*(?:mockImplementation(?:Once)?|mockReturnValue(?:Once)?)\\s*\\(`);
      isSuppressing = suppressRe.test(codeOnly.slice(match.index, checkScope.end));
    }
    if (!isSuppressing) continue;

    const targetPattern = spyName ? escapeRe(spyName) : `console\\s*\\.\\s*${consoleMethod}`;
    if (isBeforeEachBody(codeOnly, immediateScope)) {
      // A beforeEach spy must be verified in a paired afterEach within the enclosing describe/declaration scope.
      const outerScope = spyName
        ? findDeclarationScope(codeOnly, immediateScope.start, spyName)
        : enclosingScope(codeOnly, immediateScope.start);
      const afterBodies = collectAfterEachBodies(codeOnly.slice(outerScope.start, outerScope.end));
      if (afterBodies.some(body => isConsoleSpyAccountedFor(body, targetPattern))) continue;
    } else if (spyName) {
      const scope = declaredName ? immediateScope : findDeclarationScope(codeOnly, match.index, spyName);
      const searchStart = declaredName ? match.index : scope.start;
      // If spy was declared at describe level but assigned inside a single it(), stay within the immediate it() scope.
      const effectiveScope = !declaredName && immediateScope.start > scope.start && !/\btry\s*$/.test(codeOnly.slice(Math.max(0, immediateScope.start - 20), immediateScope.start))
        ? immediateScope
        : scope;
      if (isConsoleSpyAccountedFor(codeOnly.slice(effectiveScope === scope ? searchStart : effectiveScope.start, effectiveScope.end), targetPattern)) {
        continue;
      }
    } else if (isConsoleSpyAccountedFor(codeOnly.slice(match.index, immediateScope.end), targetPattern)) {
      continue;
    }

    const line = lineAt(text, match.index);
    found.push({
      line,
      text: `unfiltered console spy: ${collapseSnippet(text, match.index, Math.min(text.length, call.end + 40))}`,
    });
  }

  return found;
}

// ---- Rule 6: inline-browser-mock -------------------------------------------

const STUB_GLOBAL_CALL = /(?:\b(?:vi|jest)\s*\.\s*)?\bstubGlobal\s*\(/g;
const DEFINE_PROPERTY_CALL = /\bObject\s*\.\s*defineProperty\s*\(/g;
const BROWSER_MOCK_NAME = /^["'`](?:ResizeObserver|matchMedia)["'`]$/;
const GLOBAL_RECEIVER_EXPR = /^\s*\(*\s*(?:window|globalThis|global|self)\b(?:\s+as\s+[^)]+)?\s*\)*\s*$/;
const DIRECT_ASSIGN_DOT = /(?:\(\s*)?\b(?:window|globalThis|global|self)\b(?:\s+as\s+[^)]+)?\s*\)?\s*\.\s*(ResizeObserver|matchMedia)\s*=(?!=)/g;
const DIRECT_ASSIGN_BRACKET = /(?:\(\s*)?\b(?:window|globalThis|global|self)\b(?:\s+as\s+[^)]+)?\s*\)?\s*\[\s*(["'`])\s*\1\s*\]\s*=(?!=)/g;
const SAVED_GLOBAL_DECL = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]+)?=\s*(?:\(\s*)?(?:window|globalThis|global|self)\b(?:\s+as\s+[^)]+)?\s*\)?\s*\.\s*(?:ResizeObserver|matchMedia)\b(?!\s*\()/g;
const SAVED_GLOBAL_REASSIGN = /\b(\w+)\s*=\s*(?:\(\s*)?(?:window|globalThis|global|self)\b(?:\s+as\s+[^)]+)?\s*\)?\s*\.\s*(?:ResizeObserver|matchMedia)\b(?!\s*\()/g;
const RESTORE_IDENT_RHS = /^(\w+)\s*(?:!|(?:\s+as\s+[^;)\n}]+)*)\s*(?:[;)\n}]|$)/;
const INLINE_RO_CLASS = /\bclass\s+(\w*ResizeObserver\w*)\b|\bclass\s+\w+\s+implements\s+ResizeObserver\b/g;

export function inlineBrowserMockFindings(text, masked = maskJs(text)) {
  const { noComments, codeOnly } = masked;
  const seen = new Set();
  const found = [];

  // Scoped variables holding the original global so restoration lines (`globalThis.ResizeObserver = original`) are not flagged.
  const savedOriginals = [];
  for (const m of codeOnly.matchAll(SAVED_GLOBAL_DECL)) {
    savedOriginals.push({ name: m[1], scope: enclosingScope(codeOnly, m.index) });
  }
  for (const m of codeOnly.matchAll(SAVED_GLOBAL_REASSIGN)) {
    savedOriginals.push({ name: m[1], scope: findDeclarationScope(codeOnly, m.index, m[1]) });
  }
  const isSavedOriginalAt = (ident, pos) => savedOriginals.some(
    entry => entry.name === ident && pos >= entry.scope.start && pos <= entry.scope.end,
  );

  const record = (pos, end, label) => {
    const line = lineAt(text, pos);
    const key = `${line}:${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, text: `${label}: ${collapseSnippet(text, pos, end)}` });
  };

  // 1. vi.stubGlobal("ResizeObserver" | "matchMedia", ...)
  for (const m of codeOnly.matchAll(STUB_GLOBAL_CALL)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || !call.args.length) continue;
    const arg0 = noComments.slice(call.args[0].start, call.args[0].end).trim();
    if (!BROWSER_MOCK_NAME.test(arg0)) continue;
    record(m.index, call.end + 1, `inline ${arg0.slice(1, -1)} stub`);
  }

  // 2. Object.defineProperty(window | globalThis | global | self [as ...], "ResizeObserver" | "matchMedia", ...)
  for (const m of codeOnly.matchAll(DEFINE_PROPERTY_CALL)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || call.args.length < 2) continue;
    const target = codeOnly.slice(call.args[0].start, call.args[0].end).trim();
    const prop = noComments.slice(call.args[1].start, call.args[1].end).trim();
    if (!GLOBAL_RECEIVER_EXPR.test(target) || !BROWSER_MOCK_NAME.test(prop)) continue;
    record(m.index, call.end + 1, `inline ${prop.slice(1, -1)} defineProperty`);
  }

  // 3. vi.spyOn(window | globalThis | global | self [as ...], "ResizeObserver" | "matchMedia")
  for (const m of codeOnly.matchAll(SPY_ON_CALL)) {
    const openParen = m.index + m[0].length - 1;
    const call = parseCallArgs(codeOnly, openParen);
    if (!call || call.args.length < 2) continue;
    const target = codeOnly.slice(call.args[0].start, call.args[0].end).trim();
    const prop = noComments.slice(call.args[1].start, call.args[1].end).trim();
    if (!GLOBAL_RECEIVER_EXPR.test(target) || !BROWSER_MOCK_NAME.test(prop)) continue;
    record(m.index, call.end + 1, `inline ${prop.slice(1, -1)} spy`);
  }

  // 4. Direct assignment (dot or bracket, with optional TS cast): `window.matchMedia = ...`, `(globalThis as any).ResizeObserver = ...`, `window["matchMedia"] = ...`
  for (const m of codeOnly.matchAll(DIRECT_ASSIGN_DOT)) {
    const rhsStart = m.index + m[0].length;
    const rhsSlice = codeOnly.slice(rhsStart, rhsStart + 120).trim();
    const ident = rhsSlice.match(RESTORE_IDENT_RHS)?.[1];
    if (ident && isSavedOriginalAt(ident, m.index)) continue;
    const lineEnd = text.indexOf("\n", m.index);
    record(m.index, lineEnd === -1 ? text.length : lineEnd, `inline ${m[1]} assignment`);
  }
  for (const m of codeOnly.matchAll(DIRECT_ASSIGN_BRACKET)) {
    const bracketOpen = codeOnly.indexOf("[", m.index);
    const bracketClose = codeOnly.indexOf("]", bracketOpen);
    const prop = noComments.slice(bracketOpen + 1, bracketClose).trim();
    if (!BROWSER_MOCK_NAME.test(prop)) continue;
    const rhsStart = m.index + m[0].length;
    const rhsSlice = codeOnly.slice(rhsStart, rhsStart + 120).trim();
    const ident = rhsSlice.match(RESTORE_IDENT_RHS)?.[1];
    if (ident && isSavedOriginalAt(ident, m.index)) continue;
    const lineEnd = text.indexOf("\n", m.index);
    record(m.index, lineEnd === -1 ? text.length : lineEnd, `inline ${prop.slice(1, -1)} assignment`);
  }

  // 5. Inline ResizeObserver mock class declarations
  for (const m of codeOnly.matchAll(INLINE_RO_CLASS)) {
    const lineEnd = text.indexOf("\n", m.index);
    record(m.index, lineEnd === -1 ? text.length : lineEnd, "inline ResizeObserver class");
  }

  return found.sort((a, b) => a.line - b.line);
}

/** Run all consolidated JS/TS extra rules on a single source string. */
export function scanExtraSource(text, rules = EXTRA_RULES) {
  const masked = maskJs(text);
  const out = {};
  if (rules.includes("classname-split")) out["classname-split"] = classNameSplitFindings(text, masked);
  if (rules.includes("css-file-read")) out["css-file-read"] = cssFileReadFindings(text, masked);
  if (rules.includes("unasserted-computed-style-spy")) out["unasserted-computed-style-spy"] = computedStyleSpyFindings(text, masked);
  if (rules.includes("browser-fixed-sleep")) out["browser-fixed-sleep"] = browserFixedSleepFindings(text, masked);
  if (rules.includes("unfiltered-console-spy")) out["unfiltered-console-spy"] = unfilteredConsoleSpyFindings(text, masked);
  if (rules.includes("inline-browser-mock")) out["inline-browser-mock"] = inlineBrowserMockFindings(text, masked);
  return out;
}
