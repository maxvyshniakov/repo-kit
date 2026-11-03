// `repo-kit checks`: browser.yml's checks, one after another in one job, after
// the one build they all read. REPO_KIT_CHECKS holds the workflow's `checks`
// input, a JSON list of { name, run }; each `run` is a shell command. Every
// check runs, after a failed one too, so one run reports each check; the
// command fails when any did and names them.
import { spawnSync } from "node:child_process";

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
  if (failed.length) console.error(`checks failed: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}
