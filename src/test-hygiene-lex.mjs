// Lexical masking and lightweight delimiter/scope helpers for JS/TS test-hygiene scanners.

const REGEX_KEYWORDS = new Set([
  "return", "case", "in", "of", "typeof", "void", "delete",
  "throw", "new", "yield", "await", "else", "do", "instanceof",
]);
const REGEX_AFTER_PUNCT = new Set(["(", "[", ",", ";", ":", "=", "?", "&", "|", "^", "~", "+", "-", "*", "%"]);

export const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Return two same-length strings with exact line/column preservation:
 * - `noComments`: comments replaced with spaces (strings, templates, and regexes intact).
 * - `codeOnly`: comments AND string/template/regex literal contents replaced with spaces.
 *
 * Handles JSX text apostrophes (stops `'..."` at unescaped `\n`), JSX tags (`</Tag>`, `<Comp />`),
 * TypeScript non-null assertions (`width! / 2`), postfix `++/--` (`count++ / 2`), and `.keyword / 2`.
 */
export function maskJs(text) {
  const n = text.length;
  const noComments = [];
  const codeOnly = [];
  const templateBraceDepths = [];

  let canStartRegex = true;
  let prevWasDot = false;

  const blank = ch => (ch === "\n" ? "\n" : " ");

  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    // Resume template literal after closing `}` of `${...}`.
    if (ch === "}" && templateBraceDepths.length > 0 && templateBraceDepths[templateBraceDepths.length - 1] === 0) {
      templateBraceDepths.pop();
      noComments[i] = ch;
      codeOnly[i] = ch;
      i++;
      while (i < n) {
        const tc = text[i];
        if (tc === "\\") {
          noComments[i] = tc; codeOnly[i] = " ";
          if (i + 1 < n) { noComments[i + 1] = text[i + 1]; codeOnly[i + 1] = blank(text[i + 1]); i += 2; continue; }
          i++; continue;
        }
        if (tc === "$" && text[i + 1] === "{") {
          noComments[i] = "$"; codeOnly[i] = "$";
          noComments[i + 1] = "{"; codeOnly[i + 1] = "{";
          templateBraceDepths.push(0);
          canStartRegex = true;
          prevWasDot = false;
          i += 2;
          break;
        }
        if (tc === "`") {
          noComments[i] = tc; codeOnly[i] = tc;
          canStartRegex = false;
          prevWasDot = false;
          i++;
          break;
        }
        noComments[i] = tc;
        codeOnly[i] = blank(tc);
        i++;
      }
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        noComments[i] = " "; codeOnly[i] = " "; i++;
      }
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      noComments[i] = " "; codeOnly[i] = " ";
      noComments[i + 1] = " "; codeOnly[i + 1] = " ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        const b = blank(text[i]);
        noComments[i] = b; codeOnly[i] = b; i++;
      }
      if (i < n) {
        noComments[i] = " "; codeOnly[i] = " ";
        noComments[i + 1] = " "; codeOnly[i + 1] = " ";
        i += 2;
      }
      continue;
    }

    // Single or double quoted string (stop at unescaped newline so JSX apostrophes like `Don't` never blank the file).
    if (ch === "'" || ch === '"') {
      const quote = ch;
      noComments[i] = ch; codeOnly[i] = ch; i++;
      while (i < n && text[i] !== quote && text[i] !== "\n") {
        if (text[i] === "\\") {
          noComments[i] = text[i]; codeOnly[i] = " ";
          if (i + 1 < n) { noComments[i + 1] = text[i + 1]; codeOnly[i + 1] = blank(text[i + 1]); i += 2; continue; }
          i++; continue;
        }
        noComments[i] = text[i];
        codeOnly[i] = blank(text[i]);
        i++;
      }
      if (i < n && text[i] === quote) { noComments[i] = quote; codeOnly[i] = quote; i++; }
      canStartRegex = false;
      prevWasDot = false;
      continue;
    }

    // Template literal
    if (ch === "`") {
      noComments[i] = ch; codeOnly[i] = ch; i++;
      while (i < n) {
        const tc = text[i];
        if (tc === "\\") {
          noComments[i] = tc; codeOnly[i] = " ";
          if (i + 1 < n) { noComments[i + 1] = text[i + 1]; codeOnly[i + 1] = blank(text[i + 1]); i += 2; continue; }
          i++; continue;
        }
        if (tc === "$" && text[i + 1] === "{") {
          noComments[i] = "$"; codeOnly[i] = "$";
          noComments[i + 1] = "{"; codeOnly[i + 1] = "{";
          templateBraceDepths.push(0);
          canStartRegex = true;
          prevWasDot = false;
          i += 2;
          break;
        }
        if (tc === "`") {
          noComments[i] = tc; codeOnly[i] = tc;
          canStartRegex = false;
          prevWasDot = false;
          i++;
          break;
        }
        noComments[i] = tc;
        codeOnly[i] = blank(tc);
        i++;
      }
      continue;
    }

    // Regex literal (never on JSX self-closing `/>` or when division follows an expression/postfix token).
    if (ch === "/" && next !== ">" && canStartRegex) {
      noComments[i] = ch; codeOnly[i] = ch; i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const rc = text[i];
        if (rc === "\\") {
          noComments[i] = rc; codeOnly[i] = " ";
          if (i + 1 < n) { noComments[i + 1] = text[i + 1]; codeOnly[i + 1] = blank(text[i + 1]); i += 2; continue; }
          i++; continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) {
          noComments[i] = "/"; codeOnly[i] = "/"; i++;
          break;
        }
        noComments[i] = rc; codeOnly[i] = " "; i++;
      }
      canStartRegex = false;
      prevWasDot = false;
      continue;
    }

    // Identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < n && /[\w$]/.test(text[i])) {
        noComments[i] = text[i]; codeOnly[i] = text[i]; i++;
      }
      const word = text.slice(start, i);
      canStartRegex = !prevWasDot && REGEX_KEYWORDS.has(word);
      prevWasDot = false;
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch)) {
      while (i < n && /[\w.]/.test(text[i])) {
        noComments[i] = text[i]; codeOnly[i] = text[i]; i++;
      }
      canStartRegex = false;
      prevWasDot = false;
      continue;
    }

    // Postfix/prefix `++` and `--`: keep `canStartRegex` as-is (false after `count++`, true after `++` in prefix position).
    if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
      noComments[i] = ch; codeOnly[i] = ch;
      noComments[i + 1] = next; codeOnly[i + 1] = next;
      prevWasDot = false;
      i += 2;
      continue;
    }

    // Arrow `=>`: allows a regex body `() => /re/`.
    if (ch === "=" && next === ">") {
      noComments[i] = ch; codeOnly[i] = ch;
      noComments[i + 1] = next; codeOnly[i + 1] = next;
      canStartRegex = true;
      prevWasDot = false;
      i += 2;
      continue;
    }

    // Non-null `!` after an expression keeps `canStartRegex = false`; logical `!` keeps `canStartRegex = true`.
    if (ch === "!" && next !== "=") {
      noComments[i] = ch; codeOnly[i] = ch;
      prevWasDot = false;
      i++;
      continue;
    }

    if (templateBraceDepths.length > 0) {
      if (ch === "{") templateBraceDepths[templateBraceDepths.length - 1]++;
      else if (ch === "}") templateBraceDepths[templateBraceDepths.length - 1]--;
    }

    noComments[i] = ch;
    codeOnly[i] = ch;
    if (!/\s/.test(ch)) {
      if (ch === ".") {
        canStartRegex = false;
        prevWasDot = true;
      } else if (ch === ")" || ch === "]" || ch === "<" || ch === ">") {
        canStartRegex = false;
        prevWasDot = false;
      } else if (ch === "{" || ch === "}" || ch === "/" || REGEX_AFTER_PUNCT.has(ch) || ch === "!") {
        canStartRegex = true;
        prevWasDot = false;
      } else {
        prevWasDot = false;
      }
    }
    i++;
  }
  return { noComments: noComments.join(""), codeOnly: codeOnly.join("") };
}

export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Collapse a span of source text into a single-line snippet capped at 120 characters. */
export function collapseSnippet(text, start, end, maxLen = 120) {
  const flat = text.slice(start, end).replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

/** Find matching closing delimiter in `codeOnly` starting at the opening `(`, `[`, or `{`. */
export function findMatchingClose(codeOnly, openIndex) {
  const open = codeOnly[openIndex];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 1;
  for (let i = openIndex + 1; i < codeOnly.length; i++) {
    if (codeOnly[i] === open) depth++;
    else if (codeOnly[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return codeOnly.length - 1;
}

/** Split top-level call arguments in `codeOnly` starting at the opening `(`; returns `{ end, args: [{ start, end }] }`. */
export function parseCallArgs(codeOnly, openParenIndex) {
  let depth = 1;
  let argStart = openParenIndex + 1;
  const args = [];
  for (let i = openParenIndex + 1; i < codeOnly.length; i++) {
    const ch = codeOnly[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (codeOnly.slice(argStart, i).trim()) args.push({ start: argStart, end: i });
        return { end: i, args };
      }
    } else if (ch === "," && depth === 1) {
      args.push({ start: argStart, end: i });
      argStart = i + 1;
    }
  }
  return null;
}

/** Return `{ start, end }` of the nearest enclosing `{...}` block around `pos` (or the whole file if top-level). */
export function enclosingScope(codeOnly, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (codeOnly[i] === "}") depth++;
    else if (codeOnly[i] === "{") {
      if (depth === 0) return { start: i, end: findMatchingClose(codeOnly, i) };
      depth--;
    }
  }
  return { start: 0, end: codeOnly.length };
}

/** Whether `segment` declares `varName` at top-level of that segment (including comma-separated `let a = 0, spy;`). */
function declaresVar(segment, varName) {
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "{" || ch === "(" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (i > 0 && /[\w$]/.test(segment[i - 1])) continue;
    const kw = segment.slice(i).match(/^(?:const|let|var)\s+/);
    if (!kw) continue;
    let j = i + kw[0].length;
    let stmtDepth = 0;
    let expectName = true;
    while (j < segment.length) {
      const c = segment[j];
      if (c === "{" || c === "(" || c === "[") { stmtDepth++; j++; continue; }
      if (c === "}" || c === ")" || c === "]") { stmtDepth = Math.max(0, stmtDepth - 1); j++; continue; }
      if (stmtDepth === 0 && (c === ";" || c === "\n")) break;
      if (stmtDepth === 0 && c === ",") { expectName = true; j++; continue; }
      if (stmtDepth === 0 && expectName) {
        if (/\s/.test(c)) { j++; continue; }
        const id = segment.slice(j).match(/^([A-Za-z_$][\w$]*)/);
        if (id) {
          if (id[1] === varName) return true;
          j += id[0].length;
          expectName = false;
          continue;
        }
        expectName = false;
      }
      j++;
    }
    i = j;
  }
  return false;
}

/** Whether the `{` at `bracePos` opens a `describe(...)` callback or function body. */
function isDescribeOrFunctionScope(codeOnly, bracePos) {
  const before = codeOnly.slice(Math.max(0, bracePos - 120), bracePos);
  return /(?:=>|\bfunction\b[^;{}]*\))\s*$/.test(before);
}

/**
 * Walk outward through enclosing `{...}` scopes to find the scope that declares `varName`.
 * When `varName` is undeclared in all enclosing scopes, cap the fallback to the nearest enclosing
 * `describe`/function scope (never the whole file) so sibling `describe` blocks stay isolated.
 */
export function findDeclarationScope(codeOnly, pos, varName) {
  let cursor = pos;
  let nearestFnScope = null;
  let nearestScope = null;
  while (cursor > 0) {
    const scope = enclosingScope(codeOnly, cursor);
    if (!nearestScope && scope.start > 0) nearestScope = scope;
    if (!nearestFnScope && scope.start > 0 && isDescribeOrFunctionScope(codeOnly, scope.start)) {
      nearestFnScope = scope;
    }
    const innerStart = scope.start > 0 ? scope.start + 1 : 0;
    if (declaresVar(codeOnly.slice(innerStart, pos), varName)) return scope;
    if (scope.start === 0) return nearestFnScope ?? nearestScope ?? scope;
    cursor = scope.start;
  }
  return { start: 0, end: codeOnly.length };
}

/** Whether the line at 0-based `index`, or the comment lines immediately above it, matches `marker`. */
export function hasLineMarker(rawLines, index, marker) {
  if (index < 0 || index >= rawLines.length) return false;
  if (marker.test(rawLines[index])) return true;
  for (let above = index - 1; above >= 0 && /^\s*(?:\/\/|#|\/?\*|\*)/.test(rawLines[above]); above--) {
    if (marker.test(rawLines[above])) return true;
  }
  return false;
}

/** End offset of an arrow function body starting at `bodyStart` in `codeOnly`. */
export function arrowBodyEnd(codeOnly, bodyStart) {
  if (codeOnly[bodyStart] === "{") return findMatchingClose(codeOnly, bodyStart) + 1;
  let depth = 0;
  let end = bodyStart;
  for (; end < codeOnly.length; end++) {
    const ch = codeOnly[end];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ";" || ch === "\n")) break;
  }
  return end;
}
