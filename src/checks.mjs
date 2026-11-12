// `repo-kit checks`: browser.yml's checks, one after another in one job, after
// the one build they all read. REPO_KIT_CHECKS holds the workflow's `checks`
// input, a JSON list of { name, run }; each `run` is a shell command. Every
// check runs, after a failed one too, so one run reports each check; the
// command fails when any did and names them. With REPO_KIT_CHECKS_JUNIT set
// it also writes each check's result and time there as JUnit XML.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The checks list, or an error that names what is wrong with it. */
export function parseChecks(text) {
  if (!text) throw new Error("REPO_KIT_CHECKS is empty: set it to the JSON list of {name, run}");
  let checks;
  try {
    checks = JSON.parse(text);
  } catch {
    throw new Error(`REPO_KIT_CHECKS is not JSON: ${text}`);
  }
  if (!Array.isArray(checks) || !checks.length) throw new Error("REPO_KIT_CHECKS needs at least one {name, run}");
  for (const check of checks) {
    if (typeof check?.name !== "string" || typeof check?.run !== "string") throw new Error(`each check needs a name and a run command: ${JSON.stringify(check)}`);
  }
  return checks.map(({ name, run }) => ({ name, run }));
}

export function runChecks(checks, { env = process.env } = {}) {
  const results = [];
  for (const { name, run } of checks) {
    console.log(`\n== ${name}: ${run}`);
    const started = Date.now();
    const { status, signal } = spawnSync("sh", ["-c", run], { stdio: "inherit", env });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ name, ok: status === 0, how: status === null ? signal : `exit ${status}`, seconds });
    if (status !== 0 && env.GITHUB_ACTIONS) console.log(`::error title=${name}::${name} failed (${status === null ? signal : `exit ${status}`})`);
  }
  console.log("\nchecks:");
  for (const { name, ok, how, seconds } of results) console.log(ok ? `  ok   ${name} (${seconds}s)` : `  FAIL ${name} (${how}, ${seconds}s)`);
  const failed = results.filter(({ ok }) => !ok).map(({ name }) => name);
  if (env.REPO_KIT_CHECKS_JUNIT) writeJunit(env.REPO_KIT_CHECKS_JUNIT, results);
  if (failed.length) console.error(`checks failed: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}

// XML 1.0 has no control characters but tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const escapeXml = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);

/** One testsuite, one testcase per check: what CI keeps as per-check timings and failures. */
export function junitReport(results, suite = "repo-kit checks") {
  const total = results.reduce((sum, { seconds }) => sum + Number(seconds), 0).toFixed(1);
  const failures = results.filter(({ ok }) => !ok).length;
  const cases = results.map(({ name, ok, how, seconds }) => {
    const head = `<testcase classname="${escapeXml(suite)}" name="${escapeXml(name)}" time="${seconds}"`;
    return ok ? `${head}/>` : `${head}><failure message="${escapeXml(how)}"/></testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="${escapeXml(suite)}" tests="${results.length}" failures="${failures}" time="${total}">\n${cases.join("\n")}\n</testsuite>\n</testsuites>\n`;
}

function writeJunit(file, results) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, junitReport(results));
}
