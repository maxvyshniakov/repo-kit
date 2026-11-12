// The agent friction journal: one local, append-only JSONL file of moments an
// agent misread or misused a package (a lint finding beyond the baseline, a type
// error on the package's types, an owner's correction, a vendored copy patched).
// Writers: `repo-kit friction log`, sid-kit-lint, the mastack hook and scanners.
// `report` ranks it; `export` writes a redacted bundle a person can send.
// Nothing here opens a network connection. See docs/reference.md#friction-journal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FRICTION_SCHEMA = 1;
export const FRICTION_KINDS = ["lint-finding", "selector-reach-in", "type-error", "owner-correction", "misuse",
  "vendored-patch", "review-finding", "note"];
export const DETAIL_LIMIT = 500;
const LINE_LIMIT = 4000;
const STRING_FIELDS = ["project", "package", "kind", "component", "rule", "detail", "session", "source", "why", "file", "fingerprint"];
// Kinds whose detail is a person's or an agent's words, not a tool's message:
// the only ones `export --notes` takes a redacted note from.
const NOTE_KINDS = new Set(["owner-correction", "misuse", "review-finding", "note"]);
const IDENTIFIER = /^[A-Za-z_$][\w$.\-/]{0,79}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

/** The journal file: FRICTION_JOURNAL, else $XDG_STATE_HOME/friction, else ~/.local/state/friction. "off" is none. */
export function journalPath(env = process.env) {
  if (env.FRICTION_JOURNAL === "off") return null;
  if (env.FRICTION_JOURNAL) return env.FRICTION_JOURNAL;
  const state = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.join(state, "friction", "events.jsonl");
}

/** The repository a directory belongs to, by name; a linked worktree names its main repository. */
export function projectName(cwd = process.cwd()) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const git = path.join(dir, ".git");
    let stat;
    try {
      stat = fs.statSync(git);
    } catch {
      if (path.dirname(dir) === dir) return path.basename(path.resolve(cwd));
      continue;
    }
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"));
      const gitdir = match ? path.resolve(dir, match[1].trim()) : "";
      const index = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
      if (index > 0) return path.basename(gitdir.slice(0, index));
    }
    return path.basename(dir);
  }
}

export function sessionId(env = process.env) {
  return env.FRICTION_SESSION || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || null;
}

export function validateEvent(event) {
  const problems = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) return ["an event is a JSON object"];
  if (event.v !== FRICTION_SCHEMA) problems.push(`v must be ${FRICTION_SCHEMA}`);
  if (typeof event.ts !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(event.ts) || Number.isNaN(Date.parse(event.ts))) {
    problems.push("ts must be an ISO 8601 time");
  }
  for (const field of ["project", "package", "source"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) problems.push(`${field} is required`);
  }
  if (!FRICTION_KINDS.includes(event.kind)) problems.push(`kind must be one of ${FRICTION_KINDS.join(", ")}`);
  for (const field of STRING_FIELDS) {
    if (event[field] !== undefined && event[field] !== null && typeof event[field] !== "string") problems.push(`${field} must be a string or null`);
  }
  if (typeof event.detail === "string" && event.detail.length > DETAIL_LIMIT) problems.push(`detail is longer than ${DETAIL_LIMIT} characters`);
  return problems;
}

/** An event from the fields given, with time, project, session and source filled in. */
export function buildEvent(fields, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  const text = value => (value === undefined || value === null || value === "" ? null : String(value));
  return {
    v: FRICTION_SCHEMA,
    ts: fields.ts ?? now.toISOString(),
    project: text(fields.project) ?? projectName(cwd),
    package: text(fields.package) ?? "",
    kind: fields.kind,
    component: text(fields.component),
    rule: text(fields.rule),
    detail: (text(fields.detail) ?? "").slice(0, DETAIL_LIMIT),
    session: text(fields.session) ?? sessionId(env),
    source: text(fields.source) ?? "repo-kit",
    why: text(fields.why),
    file: text(fields.file),
    fingerprint: text(fields.fingerprint),
  };
}

/** Append one valid event as one line; returns the file, or null when the journal is off. */
export function appendEvent(event, env = process.env) {
  const problems = validateEvent(event);
  if (problems.length) throw new Error(`friction event: ${problems.join("; ")}`);
  const file = journalPath(env);
  if (!file) return null;
  let line = JSON.stringify(event);
  if (line.length > LINE_LIMIT) line = JSON.stringify({ ...event, detail: event.detail.slice(0, Math.max(0, event.detail.length - (line.length - LINE_LIMIT))) });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // One write with O_APPEND: concurrent writers never interleave a line.
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, `${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

export function readEvents(file) {
  const events = [], skipped = { unreadable: 0, version: 0 };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (event?.v !== FRICTION_SCHEMA) skipped.version++;
    else if (validateEvent(event).length) skipped.unreadable++;
    else events.push(event);
  }
  return { events, skipped };
}

/** --since/--until: Nd, Nw, Nh or a date. */
export function parseSince(value, now = new Date()) {
  const relative = /^(\d+)([hdw])$/.exec(value ?? "");
  if (relative) {
    const hours = { h: 1, d: 24, w: 24 * 7 }[relative[2]] * Number(relative[1]);
    return new Date(now.getTime() - hours * 3600_000);
  }
  if (/^\d{4}-\d\d-\d\d/.test(value ?? "") && !Number.isNaN(Date.parse(value))) return new Date(value);
  throw new Error(`--since/--until takes 30d, 2w, 12h or a date (YYYY-MM-DD), not "${value}"`);
}

function within(events, { since, until, project, package: pkg, kind } = {}) {
  return events.filter(event => {
    const time = Date.parse(event.ts);
    return (!since || time >= since.getTime()) && (!until || time < until.getTime())
      && (!project || event.project === project) && (!pkg || event.package === pkg) && (!kind || event.kind === kind);
  });
}

function ranked(events, keyOf) {
  const rows = new Map();
  for (const event of events) {
    const key = keyOf(event);
    if (key === null || key === undefined) continue;
    let row = rows.get(key);
    if (!row) rows.set(key, row = { key, events: 0, facts: new Set(), sessions: new Set(), projects: new Set() });
    row.events++;
    row.facts.add(event.fingerprint ?? `${row.events}\0unique`);
    if (event.session) row.sessions.add(event.session);
    row.projects.add(event.project);
  }
  return [...rows.values()]
    .map(({ key, events: count, facts, sessions, projects }) => ({ key, events: count, distinct: facts.size, sessions: sessions.size, projects: projects.size }))
    .sort((a, b) => b.events - a.events || b.distinct - a.distinct || (a.key < b.key ? -1 : 1));
}

export function report(all, options = {}) {
  const events = within(all, options);
  const top = options.top ?? 15;
  return {
    total: events.length,
    from: events.length ? events.map(event => event.ts).sort()[0] : null,
    to: events.length ? events.map(event => event.ts).sort().at(-1) : null,
    kinds: ranked(events, event => event.kind),
    packages: ranked(events, event => event.package),
    components: ranked(events, event => event.component).slice(0, top),
    rules: ranked(events, event => event.rule).slice(0, top),
    triples: ranked(events, event => `${event.package} ${event.component ?? "-"} ${event.rule ?? "-"}`).slice(0, top),
  };
}

export function formatReport(result, skipped = { unreadable: 0, version: 0 }) {
  const lines = [`Friction journal: ${result.total} events${result.from ? `, ${result.from.slice(0, 10)} to ${result.to.slice(0, 10)}` : ""}`];
  const table = (title, rows) => {
    if (!rows.length) return;
    const width = Math.max(...rows.map(row => row.key.length), title.length);
    lines.push("", `${title.padEnd(width)}  events  distinct  sessions  projects`);
    for (const row of rows) {
      lines.push(`${row.key.padEnd(width)}  ${String(row.events).padStart(6)}  ${String(row.distinct).padStart(8)}  ${String(row.sessions).padStart(8)}  ${String(row.projects).padStart(8)}`);
    }
  };
  table("Kind", result.kinds);
  table("Package", result.packages);
  table("Component", result.components);
  table("Rule", result.rules);
  table("Package component rule", result.triples);
  if (skipped.unreadable || skipped.version) {
    lines.push("", `Skipped ${skipped.unreadable} unreadable lines and ${skipped.version} lines of another schema version.`);
  }
  return lines.join("\n");
}

/** A note a person may share: no code, paths, URLs, addresses or long numbers; at most 12 words. */
export function redactNote(text) {
  let note = String(text ?? "").replace(/`[^`]*`/g, " ");
  note = note.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ");
  // A note with code punctuation left outside backticks is code: drop it whole.
  if (/[{}<>=;$\\|]|=>|\(\)/.test(note)) return "";
  const words = note.split(/\s+/)
    .filter(word => word && !/[/~]/.test(word) && !/\d{5,}|[0-9a-f]{8,}/i.test(word))
    .map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(word => word && /^[\p{L}\p{N}'’-]+$/u.test(word));
  return words.slice(0, 12).join(" ");
}

function paraphrase({ kind, component, rule }) {
  const what = component ?? "the package";
  switch (kind) {
    case "type-error": return `${rule ?? "TS"} type error on ${what}`;
    case "lint-finding": return `lint ${rule ?? "finding"} on ${what}`;
    case "selector-reach-in": return `selector into ${what} internals${rule ? ` (${rule})` : ""}`;
    case "owner-correction": return `owner corrected usage of ${what}`;
    case "misuse": return `misuse of ${what}${rule ? ` (${rule})` : ""}`;
    case "vendored-patch": return `vendored copy patched ${what}`;
    case "review-finding": return `review finding${rule ? ` (${rule})` : ""} on ${what}`;
    default: return `note on ${what}`;
  }
}

/**
 * The bundle a person can send: package, component, rule and kind with counts and a
 * paraphrase. Never projects, sessions, files, timestamps or the detail text;
 * with `notes`, at most three redacted notes per row from people's and agents' words.
 */
export function exportBundle(all, options = {}) {
  const events = within(all, options).filter(event => PACKAGE_NAME.test(event.package));
  const safe = value => (value === null || value === undefined ? null : IDENTIFIER.test(value) ? value : "(other)");
  const rows = new Map();
  for (const event of events) {
    const fields = { package: event.package, component: safe(event.component), rule: safe(event.rule), kind: event.kind };
    const key = JSON.stringify(fields);
    let row = rows.get(key);
    if (!row) rows.set(key, row = { fields, events: [] });
    row.events.push(event);
  }
  const dates = events.map(event => event.ts).sort();
  const day = (date, fallback) => (date ? date.toISOString().slice(0, 10) : fallback?.slice(0, 10) ?? null);
  const out = [...rows.values()].map(({ fields, events: list }) => {
    const [counts] = ranked(list, () => "row");
    const row = { ...fields, events: counts.events, distinct: counts.distinct, projects: counts.projects, sessions: counts.sessions,
      paraphrase: paraphrase(fields) };
    if (options.notes && NOTE_KINDS.has(fields.kind)) {
      const notes = [...new Set(list.map(event => redactNote(event.detail)).filter(Boolean))].slice(0, 3);
      if (notes.length) row.notes = notes;
    }
    return row;
  }).sort((a, b) => b.events - a.events || (a.paraphrase < b.paraphrase ? -1 : 1));
  return {
    format: "friction-export",
    schema: FRICTION_SCHEMA,
    period: { from: day(options.since, dates[0]), to: day(options.until, dates.at(-1)) },
    redaction: "package, component, rule and kind with counts and template paraphrases; no projects, sessions, files, times or detail text" +
      (options.notes ? "; notes: redacted, at most 12 words, code, paths, URLs, addresses and long numbers removed" : ""),
    rows: out,
  };
}

const USAGE = `Usage:
  repo-kit friction log --package <npm name> --kind <kind> [--component <export>] [--rule <rule>]
                        [--detail <text>] [--why <text>] [--file <path>] [--project <name>] [--session <id>]
                        [--source <writer>] [--fingerprint <key>]
  repo-kit friction report [--since 30d|YYYY-MM-DD] [--until ...] [--project P] [--package P] [--kind K] [--top N] [--json]
  repo-kit friction export [--since ...] [--until ...] [--package P] [--notes] [--out FILE]

Kinds: ${FRICTION_KINDS.join(", ")}.
Journal: FRICTION_JOURNAL, else $XDG_STATE_HOME/friction/events.jsonl (~/.local/state/friction/events.jsonl);
FRICTION_JOURNAL=off turns logging off. --journal FILE reads or writes another file. Everything stays local:
export writes a file for a person to read and send.`;

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(args[index]);
    if (!match) throw new Error(`unexpected argument "${args[index]}"`);
    const [, name, inline] = match;
    if (name === "json" || name === "notes") flags[name] = true;
    else if (inline !== undefined) flags[name] = inline;
    else if (index + 1 < args.length) flags[name] = args[++index];
    else throw new Error(`--${name} needs a value`);
  }
  return flags;
}

export function runFriction(args, { env = process.env, cwd = process.cwd(), now = new Date() } = {}) {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    console.log(USAGE);
    return action ? 0 : 1;
  }
  let flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    console.error(`repo-kit friction: ${error.message}\n${USAGE}`);
    return 1;
  }
  const journalEnv = flags.journal ? { ...env, FRICTION_JOURNAL: flags.journal } : env;
  const period = () => ({
    since: flags.since ? parseSince(flags.since, now) : undefined,
    until: flags.until ? parseSince(flags.until, now) : undefined,
  });
  try {
    if (action === "log") {
      const event = buildEvent(flags, { cwd, env, now });
      const file = appendEvent(event, journalEnv);
      console.log(file ? `friction: logged ${event.kind} ${event.component ?? ""} ${event.rule ?? ""}`.replace(/\s+$/, "") : "friction: journal is off");
      return 0;
    }
    const file = journalPath(journalEnv);
    if (!file) {
      console.error("repo-kit friction: the journal is off (FRICTION_JOURNAL=off)");
      return 1;
    }
    const { events, skipped } = readEvents(file);
    if (action === "report") {
      const result = report(events, { ...period(), project: flags.project, package: flags.package, kind: flags.kind,
        top: flags.top ? Number(flags.top) : undefined });
      console.log(flags.json ? JSON.stringify({ ...result, skipped }, null, 2) : formatReport(result, skipped));
      return 0;
    }
    if (action === "export") {
      const bundle = exportBundle(events, { ...period(), package: flags.package, notes: flags.notes });
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (flags.out) {
        fs.writeFileSync(flags.out, text, { mode: 0o600 });
        console.log(`friction: wrote ${bundle.rows.length} rows to ${flags.out}; read it before you send it.`);
      } else process.stdout.write(text);
      return 0;
    }
  } catch (error) {
    console.error(`repo-kit friction: ${error.message}`);
    return 1;
  }
  console.error(USAGE);
  return 1;
}
