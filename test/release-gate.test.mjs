import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import {
  attestationRefusal,
  attestationState,
  ciGateDecision,
  localContext,
  publishGatePlan,
  releaseGate,
  runReleaseGate,
  statusDescription,
} from "../src/release-gate.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

// The gate writes to the streams it is given; node --test reads this process's stdout.
const capture = () => {
  const lines = [];
  const stream = { write: chunk => (lines.push(String(chunk)), true) };
  return { stdout: stream, stderr: stream, output: () => lines.join("") };
};

test("release.gate defaults to local; ci is the one-line switch back", () => {
  assert.equal(withDefaults({}).release.gate, "local");
  assert.equal(releaseGate(withDefaults({})), "local");
  assert.equal(releaseGate(withDefaults({ release: { gate: "ci" } })), "ci");
  // afterCut and the gate live side by side.
  const afterCut = () => {};
  assert.equal(withDefaults({ release: { afterCut } }).release.afterCut, afterCut);
  assert.throws(() => releaseGate(withDefaults({ release: { gate: "github" } })), /release\.gate must be "local" or "ci", got "github"/);
});

test("gate ci keeps publish's old decisions exactly; gate local asks for the attestation outside Actions", () => {
  // ci: what publish did before release.gate existed.
  assert.equal(publishGatePlan({ gate: "ci", checks: "check.yml", inActions: false }), "workflow");
  assert.equal(publishGatePlan({ gate: "ci", checks: "check.yml", inActions: true }), "actions");
  assert.equal(publishGatePlan({ gate: "ci", checks: false, inActions: false }), "unchecked");
  assert.equal(publishGatePlan({ gate: "ci", checks: false, inActions: true }), "unchecked");
  // local: the attestation, whatever publish.checks says.
  assert.equal(publishGatePlan({ gate: "local", checks: "check.yml", inActions: false }), "attestation");
  assert.equal(publishGatePlan({ gate: "local", checks: false, inActions: false }), "attestation");
  // Data Grid's automated catalog release publishes inside Actions, after its
  // own check jobs: those jobs gate it, as before.
  assert.equal(publishGatePlan({ gate: "local", checks: "check.yml", inActions: true }), "actions");
});

test("the attestation is a commit status named by the platform that ran the gate, OS and architecture", () => {
  assert.equal(localContext("darwin", "arm64"), "Library checks (local, darwin-arm64)");
  assert.equal(localContext("linux", "x64"), "Library checks (local, linux-x64)");
  assert.equal(localContext(), `Library checks (local, ${process.platform}-${process.arch})`);
});

test("publish reads the newest local gate status on the commit and ignores other contexts", () => {
  const local = (state, description = state) => ({ context: "Library checks (local, macOS)", state, description });
  assert.equal(attestationState([]).state, "missing");
  assert.equal(attestationState([{ context: "ci/other", state: "success" }]).state, "missing");
  // The API lists the newest status first.
  assert.equal(attestationState([local("success", "newest"), local("failure")]).state, "passed");
  assert.equal(attestationState([local("success", "newest"), local("failure")]).status.description, "newest");
  assert.equal(attestationState([{ context: "ci/other", state: "success" }, local("failure"), local("success")]).state, "failed");
  assert.equal(attestationState([local("error")]).state, "failed");
  assert.equal(attestationState([local("pending")]).state, "pending");
  assert.equal(attestationState([{ ...local("success"), context: "Library checks (local, Linux)" }]).state, "passed");
});

test("without a passed attestation publish refuses and names the command that records one", () => {
  const sha = "a".repeat(40);
  const missing = attestationRefusal({ state: "missing" }, sha).join("\n");
  assert.match(missing, /no local release gate attestation \(Library checks \(local, …\)\) on aaaaaaa/);
  assert.match(missing, /bunx repo-kit release-gate aaaaaaaaaaaa/);
  assert.match(missing, /release: \{ gate: "ci" \}/, "names the switch back");
  const failed = attestationRefusal({ state: "failed", status: { description: "Failed on mac", state: "failure" } }, sha).join("\n");
  assert.match(failed, /the local release gate failed on aaaaaaa: Failed on mac/);
});

test("a status description fits GitHub's 140 characters and points at the local log", () => {
  const description = statusDescription({ passed: true, host: "a-very-long-host-name-that-goes-on-and-on-and-on", platform: "darwin", kitVersion: "0.2.4", seconds: 3725, log: ".git/repo-kit-gate/0123456789ab.log", browser: 72 });
  assert.ok(description.length <= 140, `${description.length}: ${description}`);
  assert.match(description, /^Passed on /);
  assert.match(description, /log \.git\/repo-kit-gate\/0123456789ab\.log/);
  assert.match(statusDescription({ passed: true, host: "m", platform: "darwin", kitVersion: "0.2.4", seconds: 65, log: "l", browser: 72 }), /1m 5s.*72 software-GPU Chromium launches/);
  assert.match(statusDescription({ passed: false, host: "m", platform: "darwin", kitVersion: "0.2.4", seconds: 5, log: "l" }), /^Failed on m \(macOS\)/);
});

test("the deploy follows release.gate: advisory checks under local, every check passed under ci", () => {
  const needs = { check: { result: "failure" }, browser: { result: "success" } };
  assert.deepEqual(ciGateDecision({ gate: "local", needs }), { run: true, failed: ["check"] });
  assert.deepEqual(ciGateDecision({ gate: "ci", needs }), { run: false, failed: ["check"] });
  assert.deepEqual(ciGateDecision({ gate: "ci", needs: { check: { result: "success" } } }), { run: true, failed: [] });
  // A caller that passes no needs ordered the deploy itself, as before.
  assert.deepEqual(ciGateDecision({ gate: "ci", needs: {} }), { run: true, failed: [] });
  // A skipped job did not pass.
  assert.deepEqual(ciGateDecision({ gate: "ci", needs: { check: { result: "skipped" } } }), { run: false, failed: ["check"] });
});

test("repo-kit ci-gate writes run=true|false for the deploy's later steps", () => {
  const repository = tempRepository({ "repo-kit.config.mjs": 'export default { release: { gate: "ci" } };\n' });
  try {
    const outputFile = path.join(repository.root, "github-output");
    const run = needs => {
      fs.writeFileSync(outputFile, "");
      const result = spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "ci-gate"], { cwd: repository.root, encoding: "utf8", env: { ...process.env, REPO_KIT_NEEDS: JSON.stringify(needs), GITHUB_OUTPUT: outputFile } });
      return { ...result, output: fs.readFileSync(outputFile, "utf8") };
    };
    const failed = run({ check: { result: "failure" } });
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(failed.output, "run=false\n");
    assert.match(failed.stdout, /release\.gate is "ci" and check did not pass/);
    assert.equal(run({ check: { result: "success" } }).output, "run=true\n");
    fs.writeFileSync(path.join(repository.root, "repo-kit.config.mjs"), "export default {};\n");
    const advisory = run({ check: { result: "failure" } });
    assert.equal(advisory.output, "run=true\n");
    assert.match(advisory.stdout, /advisory/);
    const mode = spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "release-gate", "--mode"], { cwd: repository.root, encoding: "utf8" });
    assert.equal(mode.stdout, "local\n");
  } finally {
    repository.cleanup();
  }
});

// A repository whose `bun` logs what the gate runs, and a fake GitHub API.
function gateFixture({ verifyExit = "0", browser = false, historical = false } = {}) {
  // historical: a commit from before the repository took its gate from repo-kit
  // (Sid-Kit's 0.41.1): no repo-kit.config.mjs, its own verify scripts.
  const repository = tempRepository(historical ? {
    "package.json": { name: "@maxvyshniakov/example", version: "0.2.0", scripts: { verify: "node scripts/verify.mjs", "verify:browser": "node scripts/verify.mjs --browser" } },
  } : {
    "package.json": { name: "@maxvyshniakov/example", version: "0.2.0", scripts: { verify: "repo-kit verify" } },
    "repo-kit.config.mjs": browser
      ? 'export default { verify: { steps: () => [], browser: () => [] } };\n'
      : "export default { verify: { steps: () => [] } };\n",
  }, { git: true });
  const { root } = repository;
  repository.git("remote", "add", "origin", "https://github.com/maxvyshniakov/example.git");
  const bin = fs.mkdtempSync(path.join(path.dirname(root), "repo-kit-gate-bin-"));
  const log = path.join(bin, "bun.log");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(bin, "bun"), `#!/bin/sh
case "$1" in
  --version) echo 1.4.4 ;;
  install) printf "install %s %s\\n" "$*" "$GITHUB_TOKEN" >> ${quote(log)}; echo installed ;;
  run) shift; printf "run %s %s\\n" "$*" "$PLAYWRIGHT_BROWSERS_PATH" >> ${quote(log)}; echo "verify output $*"; exit $VERIFY_EXIT ;;
esac
`, { mode: 0o755 });
  const sha = repository.git("rev-parse", "HEAD");
  const requests = [];
  const github = { commitKnown: true, statuses: [] };
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? "GET", body: options.body && JSON.parse(options.body) });
    if (url.endsWith(`/commits/${sha}`)) return github.commitKnown ? { ok: true, status: 200, json: async () => ({ sha }) } : { ok: false, status: 422, statusText: "Unprocessable", json: async () => ({ message: `No commit found for SHA: ${sha}` }) };
    if (url.includes(`/commits/${sha}/statuses`)) return { ok: true, status: 200, json: async () => github.statuses };
    if (url.endsWith(`/statuses/${sha}`) && options.method === "POST") {
      if (!github.commitKnown) return { ok: false, status: 422, statusText: "Unprocessable", json: async () => ({ message: `No commit found for SHA: ${sha}` }) };
      github.statuses.unshift(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => ({}) };
    }
    throw new Error(`unexpected request ${url}`);
  };
  const env = { ...repository.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_TOKEN: "gate-token", VERIFY_EXIT: verifyExit };
  // The pre-push hook runs these tests under its own lease; a browsers path
  // could be set too. Neither may reach the gate under test.
  for (const name of ["SLOTFATHER_LEASE", "SLOTFATHER_COUNT", "PLAYWRIGHT_BROWSERS_PATH"]) delete env[name];
  const deps = (extra = {}) => ({ env, fetch, tls: () => true, lease: async () => false, platform: "darwin", arch: "arm64", host: "test-mac", softwareChromium: async () => undefined, ...extra });
  const ran = () => {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => line.trimEnd()) : [];
    fs.rmSync(log, { force: true });
    return lines;
  };
  const config = async () => withDefaults(historical ? {} : (await import(`${path.join(root, "repo-kit.config.mjs")}?${Date.now()}`)).default);
  const gate = async (args = [], extra) => {
    const streams = capture();
    const result = await runReleaseGate({ root, ...(await config()) }, args, { ...deps(extra), ...streams });
    return { result, output: streams.output() };
  };
  const cleanup = () => {
    repository.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  };
  return { ...repository, sha, requests, github, gate, ran, cleanup };
}

test("the gate verifies the exact commit in a clean worktree and records a passed attestation", async () => {
  const fixture = gateFixture();
  try {
    // An uncommitted change must not reach the gate.
    fs.writeFileSync(path.join(fixture.root, "dirty.txt"), "x");
    const { result, output } = await fixture.gate();
    assert.equal(result, 0, output);
    assert.deepEqual(fixture.ran(), ["install install --frozen-lockfile gate-token", "run verify -- --release"]);
    const posts = fixture.requests.filter(request => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `https://api.github.com/repos/maxvyshniakov/example/statuses/${fixture.sha}`);
    assert.equal(posts[0].body.state, "success");
    assert.equal(posts[0].body.context, "Library checks (local, darwin-arm64)");
    assert.match(posts[0].body.description, new RegExp(`^Passed on test-mac \\(macOS\\).*log \\.git/repo-kit-gate/${fixture.sha.slice(0, 12)}\\.log`));
    // The log holds what ran.
    const log = fs.readFileSync(path.join(fixture.root, ".git/repo-kit-gate", `${fixture.sha.slice(0, 12)}.log`), "utf8");
    assert.match(log, /verify output verify -- --release/);
    assert.match(log, /TLS gate passed; slotfather lease none/);
    assert.match(output, /no Playwright in this commit/);
    assert.match(output, /no verify\.browser/);
    // A second run finds the commit attested and runs nothing.
    fixture.requests.length = 0;
    const again = await fixture.gate();
    assert.equal(again.result, 0, again.output);
    assert.deepEqual(fixture.ran(), []);
    assert.equal(fixture.requests.filter(request => request.method === "POST").length, 0);
    assert.match(again.output, /already attested/);
  } finally {
    fixture.cleanup();
  }
});

test("a failed gate records a failed status and no pass", async () => {
  const fixture = gateFixture({ verifyExit: "3" });
  try {
    const { result, output } = await fixture.gate();
    assert.equal(result, 1, output);
    const [post] = fixture.requests.filter(request => request.method === "POST");
    assert.equal(post.body.state, "failure");
    assert.match(post.body.description, /^Failed on test-mac/);
    assert.match(output, /FAIL verify --release/);
    // Nothing passed, so a second run runs everything again.
    await fixture.gate();
    assert.ok(fixture.ran().some(line => line.startsWith("run verify")));
  } finally {
    fixture.cleanup();
  }
});

test("a commit GitHub does not have yet passes locally and is attested by the next run after the push", async () => {
  const fixture = gateFixture();
  try {
    fixture.github.commitKnown = false;
    const first = await fixture.gate();
    assert.equal(first.result, 1, first.output);
    assert.match(first.output, /GitHub does not have [0-9a-f]{12} yet/);
    assert.match(first.output, /passed.*push it, then run .*release-gate/s);
    assert.equal(fixture.ran().length, 2, "it still ran");
    fixture.github.commitKnown = true;
    const second = await fixture.gate();
    assert.equal(second.result, 0, second.output);
    assert.deepEqual(fixture.ran(), [], "a passed commit is not run again");
    assert.equal(fixture.github.statuses[0].state, "success");
    assert.match(second.output, /passed the release gate on this machine/);
  } finally {
    fixture.cleanup();
  }
});

test("--rerun runs a passed commit again and --no-attest records nothing on GitHub", async () => {
  const fixture = gateFixture();
  try {
    assert.equal((await fixture.gate(["--no-attest"])).result, 0);
    assert.equal(fixture.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(fixture.ran().length, 2);
    assert.equal((await fixture.gate(["--rerun", "--no-attest"])).result, 0);
    assert.equal(fixture.ran().length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("the TLS gate and the token come before any install", async () => {
  const fixture = gateFixture();
  try {
    const tls = await fixture.gate([], { tls: () => false });
    assert.equal(tls.result, 1);
    assert.match(tls.output, /TLS gate failed/);
    assert.deepEqual(fixture.ran(), []);
    const noToken = await fixture.gate([], { env: { ...fixture.env, PATH: `${path.dirname(fixture.root)}:/usr/bin:/bin`, GITHUB_TOKEN: "" }, tokenSource: () => undefined });
    assert.equal(noToken.result, 1);
    assert.match(noToken.output, /GITHUB_TOKEN/);
  } finally {
    fixture.cleanup();
  }
});

test("browser checks run against Chromium with software compositing, and must start it", async () => {
  const fixture = gateFixture({ browser: true });
  try {
    // A commit with verify.browser and no Playwright cannot run them as CI did.
    const none = await fixture.gate(["--no-attest"]);
    assert.equal(none.result, 1, none.output);
    assert.match(none.output, /verify\.browser is configured, but this commit has no Playwright/);
    fixture.ran();
    let launches = 0;
    const softwareChromium = async () => ({ env: { PLAYWRIGHT_BROWSERS_PATH: "/mirror" }, summary: "gpu_compositing disabled_software", launches: () => launches, cleanup: () => {} });
    // Every Chromium of verify and the browser checks comes from the mirror.
    launches = 5;
    const passed = await fixture.gate(["--no-attest"], { softwareChromium });
    assert.equal(passed.result, 0, passed.output);
    assert.deepEqual(fixture.ran().filter(line => line.startsWith("run ")), ["run verify -- --release /mirror", "run verify -- --browser /mirror"]);
    assert.match(passed.output, /5 Chromium launches with --disable-gpu/);
    // Browser checks that start no Chromium through it prove nothing.
    launches = 0;
    const silent = await fixture.gate(["--no-attest", "--rerun"], { softwareChromium });
    assert.equal(silent.result, 1, silent.output);
    assert.match(silent.output, /started no Chromium through the software-compositing wrapper/);
  } finally {
    fixture.cleanup();
  }
});

test("a commit from before the kit runs its own verify and verify:browser scripts", async () => {
  const fixture = gateFixture({ historical: true });
  try {
    const softwareChromium = async () => ({ env: { PLAYWRIGHT_BROWSERS_PATH: "/mirror" }, summary: "software", launches: () => 2, cleanup: () => {} });
    const { result, output } = await fixture.gate(["--no-attest"], { softwareChromium });
    assert.equal(result, 0, output);
    assert.deepEqual(fixture.ran().filter(line => line.startsWith("run ")), ["run verify -- --release /mirror", "run verify:browser /mirror"]);
  } finally {
    fixture.cleanup();
  }
});
