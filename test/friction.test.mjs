import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendEvent, buildEvent, exportBundle, FRICTION_KINDS, FRICTION_SCHEMA, journalPath, parseSince, readEvents, redactNote, report,
  validateEvent,
} from "../src/friction.mjs";
import { kitRoot } from "./fixtures.mjs";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-friction-"));
const event = (fields = {}) => ({
  v: 1, ts: "2026-11-10T10:00:00.000Z", project: "app", package: "@acme/kit", kind: "type-error",
  component: "Button", rule: "TS2322", detail: "", session: "s1", source: "repo-kit", ...fields,
});
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "friction", ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: os.tmpdir(),
});

test("the journal path follows FRICTION_JOURNAL, then XDG_STATE_HOME, then ~/.local/state", () => {
  assert.equal(journalPath({ FRICTION_JOURNAL: "/x/j.jsonl" }), "/x/j.jsonl");
  assert.equal(journalPath({ XDG_STATE_HOME: "/state" }), "/state/friction/events.jsonl");
  assert.equal(journalPath({ HOME: "/home/a" }), "/home/a/.local/state/friction/events.jsonl");
  assert.equal(journalPath({ FRICTION_JOURNAL: "off" }), null);
});

test("schema version 1 has the documented fields and closed kinds", () => {
  assert.equal(FRICTION_SCHEMA, 1);
  assert.deepEqual(FRICTION_KINDS, ["lint-finding", "selector-reach-in", "type-error", "owner-correction", "misuse",
    "vendored-patch", "review-finding", "note"]);
  assert.deepEqual(validateEvent(event()), []);
  assert.match(validateEvent(event({ kind: "oops" })).join("\n"), /kind must be one of/);
  assert.match(validateEvent(event({ package: "" })).join("\n"), /package is required/);
  assert.match(validateEvent(event({ ts: "yesterday" })).join("\n"), /ts must be an ISO 8601 time/);
  assert.match(validateEvent(event({ v: 2 })).join("\n"), /v must be 1/);
});

test("buildEvent fills time, project, session and source, and caps the detail", () => {
  const built = buildEvent({ package: "@acme/kit", kind: "note", detail: "x".repeat(900) },
    { cwd: "/repos/app", env: { CLAUDE_CODE_SESSION_ID: "abc" }, now: new Date("2026-11-12T00:00:00Z") });
  assert.equal(built.ts, "2026-11-12T00:00:00.000Z");
  assert.equal(built.project, "app");
  assert.equal(built.session, "abc");
  assert.equal(built.source, "repo-kit");
  assert.equal(built.detail.length, 500);
});

test("appendEvent writes one private JSON line per event and refuses invalid ones", () => {
  const dir = scratch();
  const file = path.join(dir, "deep/events.jsonl");
  appendEvent(event(), { FRICTION_JOURNAL: file });
  appendEvent(event({ component: "Card" }), { FRICTION_JOURNAL: file });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.component), ["Button", "Card"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => appendEvent(event({ kind: "bogus" }), { FRICTION_JOURNAL: file }), /kind must be one of/);
  assert.equal(appendEvent(event(), { FRICTION_JOURNAL: "off" }), null);
});

test("readEvents skips broken lines and unknown schema versions, and counts them", () => {
  const dir = scratch();
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, [JSON.stringify(event()), "{broken", JSON.stringify(event({ v: 9 })), ""].join("\n"));
  const { events, skipped } = readEvents(file);
  assert.equal(events.length, 1);
  assert.deepEqual(skipped, { unreadable: 1, version: 1 });
});

test("parseSince takes days, weeks and dates", () => {
  const now = new Date("2026-11-12T00:00:00Z");
  assert.equal(parseSince("30d", now).toISOString(), "2026-10-13T00:00:00.000Z");
  assert.equal(parseSince("2w", now).toISOString(), "2026-10-29T00:00:00.000Z");
  assert.equal(parseSince("2026-10-01", now).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.throws(() => parseSince("soon", now), /--since/);
});

test("report ranks kinds, components and rules, counting distinct facts, sessions and projects", () => {
  const events = [
    event({ fingerprint: "a" }), event({ fingerprint: "a" }), event({ fingerprint: "b", session: "s2", project: "web" }),
    event({ kind: "lint-finding", component: "Sheet", rule: "kit/no-restyle", fingerprint: "c" }),
    event({ ts: "2026-01-01T00:00:00.000Z", component: "Old" }),
  ];
  const result = report(events, { since: new Date("2026-11-01T00:00:00Z") });
  assert.equal(result.total, 4);
  assert.deepEqual(result.kinds[0], { key: "type-error", events: 3, distinct: 2, sessions: 2, projects: 2 });
  assert.deepEqual(result.components.map(row => [row.key, row.events]), [["Button", 3], ["Sheet", 1]]);
  assert.deepEqual(result.rules.map(row => row.key), ["TS2322", "kit/no-restyle"]);
  assert.equal(result.triples[0].key, "@acme/kit Button TS2322");
  assert.ok(!result.components.some(row => row.key === "Old"), "events before --since are left out");
});

test("redactNote removes code, paths, URLs, e-mail addresses and long numbers, and keeps 12 words", () => {
  assert.equal(redactNote("Use `<Button iconOnly />` not raw html in /Users/me/app/src/a.tsx see https://x.io/y mail me@corp.com id 12345678"),
    "Use not raw html in see mail id");
  assert.equal(redactNote("const x = {a: 1}; return x"), "");
  assert.equal(redactNote("one two three four five six seven eight nine ten eleven twelve thirteen").split(" ").length, 12);
  assert.equal(redactNote("~/secret/plan.md и ещё вместо Button"), "и ещё вместо Button");
});

test("export keeps package, component, rule, kind and counts, and nothing that names a person, project or prompt", () => {
  const events = [
    event({ project: "secret-client", session: "sess-123", detail: "the owner said: use `Foo` in /Users/me/secret-client/src/x.tsx, mail boss@client.com", file: "/Users/me/secret-client/src/x.tsx", fingerprint: "a" }),
    event({ project: "zeta-project", kind: "owner-correction", component: "Item", rule: null, detail: "Item already clamps its title, put full text in ItemBody" }),
    event({ component: "<script>alert(1)</script>", detail: "x" }),
    event({ package: "not a package!", component: "Button" }),
  ];
  const bundle = exportBundle(events, { since: new Date("2026-11-01T00:00:00Z"), until: new Date("2026-11-12T00:00:00Z"), notes: true });
  const text = JSON.stringify(bundle);
  for (const secret of ["secret-client", "sess-123", "/Users", "boss@client.com", "the owner said", "zeta-project", "<script>", "not a package"]) {
    assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  }
  assert.equal(bundle.format, "friction-export");
  assert.equal(bundle.schema, 1);
  assert.deepEqual(bundle.period, { from: "2026-11-01", to: "2026-11-12" });
  const button = bundle.rows.find(row => row.component === "Button" && row.rule === "TS2322");
  assert.deepEqual({ ...button, notes: undefined }, { package: "@acme/kit", component: "Button", rule: "TS2322", kind: "type-error",
    events: 1, distinct: 1, projects: 1, sessions: 1, paraphrase: "TS2322 type error on Button", notes: undefined });
  assert.ok(bundle.rows.some(row => row.component === "(other)"));
  const item = bundle.rows.find(row => row.component === "Item");
  assert.deepEqual(item.notes, ["Item already clamps its title put full text in ItemBody"]);
  assert.equal(exportBundle(events, {}).rows.find(row => row.component === "Item").notes, undefined, "notes are opt-in");
});

test("the CLI logs, reports and exports through one journal", () => {
  const dir = scratch();
  const env = { FRICTION_JOURNAL: path.join(dir, "events.jsonl"), CLAUDE_CODE_SESSION_ID: "" };
  const logged = cli(["log", "--package", "@acme/kit", "--kind", "type-error", "--component", "Button", "--rule", "TS2322",
    "--detail", "Property 'tone' does not exist", "--project", "app"], env);
  assert.equal(logged.status, 0, logged.stderr);
  const bad = cli(["log", "--package", "@acme/kit", "--kind", "nonsense"], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /kind must be one of/);
  const shown = cli(["report", "--since", "1d"], env);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /1 events/);
  assert.match(shown.stdout, /Button\s+1/);
  const json = JSON.parse(cli(["report", "--json"], env).stdout);
  assert.equal(json.total, 1);
  const out = path.join(dir, "bundle.json");
  const exported = cli(["export", "--out", out], env);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).rows[0].component, "Button");
  assert.match(cli(["help"], env).stdout, /repo-kit friction log/);
});
