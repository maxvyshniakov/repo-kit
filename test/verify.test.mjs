import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import { chain, normalizeSteps, runSteps, unitTestWorkers, verifyCores, verifySteps } from "../src/verify.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const names = steps => steps.map(({ name }) => name);
const cli = path.join(kitRoot, "src/cli.mjs");

test("verify takes the repository's steps, with release passed to them", () => {
  const config = withDefaults({
    verify: {
      steps: ({ release }) => [
        { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])] },
        { name: "build", command: ["run", "build"] },
        { name: "typecheck", command: ["run", "typecheck"], needs: ["build"] },
      ],
      browser: chain([["build", ["run", "build"]], ["stories", ["run", "check:stories"]]]),
    },
  });
  assert.deepEqual(names(verifySteps(config)), ["changelogs", "build", "typecheck"]);
  assert.deepEqual(verifySteps(config)[0].command, ["run", "check:changelogs"]);
  assert.deepEqual(verifySteps(config, { release: true })[0].command, ["run", "check:changelogs", "--", "--release"]);
  assert.deepEqual(verifySteps(config)[1].needs, []);
  assert.deepEqual(verifySteps(config, { browser: true }).map(({ needs }) => needs), [[], ["build"]]);
  assert.throws(() => verifySteps(withDefaults({})), /declares no verify.steps/);
});

test("a step may need only earlier steps, and names are unique", () => {
  assert.throws(() => normalizeSteps([{ name: "a", command: [], needs: ["b"] }, { name: "b", command: [] }]), /needs "b", which is not an earlier step/);
  assert.throws(() => normalizeSteps([{ name: "a", command: [] }, { name: "a", command: [] }]), /duplicate verify step "a"/);
  assert.throws(() => normalizeSteps([{ name: "a", command: "bun run a" }]), /a command array/);
});

test("repo-kit's own verify runs its package scripts", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8"));
  return import(path.join(kitRoot, "repo-kit.config.mjs")).then(({ default: config }) => {
    for (const { name, command: [run, script] } of verifySteps(withDefaults(config))) {
      assert.equal(run, "run", name);
      assert.ok(scripts[script], `${name}: package.json has no "${script}" script`);
    }
  });
});

// A fake step runner: each started step waits until the test settles it.
function fakeStarts() {
  const started = [];
  const pending = new Map();
  const start = step => {
    started.push(step.name);
    let settle;
    const handle = { stopped: false, done: new Promise(resolve => { settle = resolve; }), stop() { handle.stopped = true; settle(false); } };
    pending.set(step.name, passed => settle(passed));
    return handle;
  };
  const settle = async (name, passed) => {
    pending.get(name)(passed);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { started, start, settle };
}

const plan = [
  { name: "a", needs: [] },
  { name: "b", needs: [] },
  { name: "c", needs: ["a"] },
  { name: "d", needs: ["c"] },
];

test("runSteps starts every step whose needs passed, all at once", async () => {
  const { started, start, settle } = fakeStarts();
  const run = runSteps(plan, start, { now: () => 0 });
  assert.deepEqual(started, ["a", "b"]);
  await settle("a", true);
  assert.deepEqual(started, ["a", "b", "c"]);
  await settle("c", true);
  await settle("b", true);
  await settle("d", true);
  assert.deepEqual((await run).map(({ name, status }) => [name, status]), [["a", "ok"], ["c", "ok"], ["b", "ok"], ["d", "ok"]]);
});

test("runSteps stops the running steps and starts nothing after the first failure", async () => {
  const { started, start, settle } = fakeStarts();
  const run = runSteps(plan, start, { now: () => 0 });
  await settle("a", false);
  assert.deepEqual(started, ["a", "b"]);
  const results = await run;
  assert.deepEqual(results.map(({ name, status }) => [name, status]), [["a", "fail"], ["b", "stopped"]]);
});

test("runSteps forwards an abort's signal to the running steps and starts nothing after it", async () => {
  const stops = [];
  const { started, start: fakeStart } = fakeStarts();
  const start = step => {
    const handle = fakeStart(step);
    const stop = handle.stop;
    handle.stop = signal => {
      stops.push([step.name, signal]);
      stop();
    };
    return handle;
  };
  const interrupt = new AbortController();
  const run = runSteps(plan, start, { now: () => 0, signal: interrupt.signal });
  interrupt.abort("SIGINT");
  const results = await run;
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(stops, [["a", "SIGINT"], ["b", "SIGINT"]]);
  assert.deepEqual(results.map(({ status }) => status), ["stopped", "stopped"]);
});

test("verify sizes the steps that use cores to its lease", () => {
  const options = { cpus: 12, totalSlots: () => 6 };
  assert.equal(verifyCores({}, options), 12);
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "3" }, options), 6);
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "6" }, options), 12);
  assert.equal(verifyCores({ SLOTFATHER_COUNT: "3" }, options), 12, "no lease without SLOTFATHER_LEASE");
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "3" }, { cpus: 12, totalSlots: () => 0 }), 12, "slotfather unreadable");
  assert.equal(verifyCores({ REPO_KIT_VERIFY_CORES: "4", SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "6" }, options), 4);
  assert.equal(verifyCores({ SID_KIT_VERIFY_CORES: "5" }, options), 5, "the older name still works");
  assert.equal(unitTestWorkers(1), 1);
  assert.ok(unitTestWorkers(6) >= 1 && unitTestWorkers(6) < 6);
});

// A repository whose steps run a fake `bun`; the lease is pre-set, so verify does not take one.
function fakeRepository(bunScript) {
  const repository = tempRepository({
    "package.json": { name: "fake", version: "0.0.0", type: "module" },
    "repo-kit.config.mjs": `export default { verify: { steps: [
  { name: "lint", command: ["run", "lint"] },
  { name: "unit tests", command: ["run", "test"], usesCores: true },
  { name: "build", command: ["run", "build"] },
  { name: "typecheck", command: ["run", "typecheck"], needs: ["build"] },
  { name: "story baseline", command: ["run", "baseline"], needs: ["typecheck"] },
] } };
`,
  });
  fs.mkdirSync(path.join(repository.root, "bin"));
  fs.writeFileSync(path.join(repository.root, "bin/bun"), bunScript, { mode: 0o755 });
  const env = { ...process.env, PATH: `${path.join(repository.root, "bin")}:${process.env.PATH}`, REPO_KIT_VERIFY_CORES: "2", SLOTFATHER_LEASE: "test" };
  delete env.GITHUB_ACTIONS;
  return { ...repository, env };
}

function runFakeVerify({ failing = "", bytes = 1 << 20 } = {}) {
  const repository = fakeRepository(`#!/bin/sh
node -e 'process.stdout.write("x".repeat(${bytes}) + "\\n")'
[ "$2" = "${failing}" ] && exit 3
[ -n "${failing}" ] && sleep 5
[ "$2" = "test" ] && echo "workers=$VITEST_MAX_WORKERS/$REPO_KIT_WORKERS"
exit 0
`);
  try {
    return spawnSync(process.execPath, [cli, "verify"], { cwd: repository.root, env: repository.env, encoding: "utf8", maxBuffer: 64 << 20 });
  } finally {
    repository.cleanup();
  }
}

test("verify prints every step's output and its summary through a pipe", () => {
  const { status, stdout } = runFakeVerify();
  assert.equal(status, 0);
  assert.equal(stdout.match(/x{1048576}/g)?.length, 5);
  assert.match(stdout, /\[unit tests\] workers=1\/1\n/);
  assert.match(stdout, /\nPassed in [\d.]+s\n$/);
});

test("a failing step fails verify and stops the steps beside it", () => {
  const { status, stdout } = runFakeVerify({ failing: "lint", bytes: 10 });
  assert.equal(status, 1);
  assert.match(stdout, /  FAIL lint \(/);
  assert.match(stdout, /  stop unit tests \(/);
  assert.match(stdout, /  skip story baseline\n/);
  assert.match(stdout, /=== lint failed; its last 80 lines:/);
  assert.match(stdout, /\nFailed in [\d.]+s\n$/);
});

test("verify streams each step's output live and, on SIGTERM, stops every step before it exits", async () => {
  const pids = path.join(os.tmpdir(), `repo-kit-pids-${process.pid}-${Date.now()}`);
  const repository = fakeRepository(`#!/bin/sh
echo "$$" >> "${pids}"
echo "started $2"
exec sleep 30
`);
  try {
    const verify = spawn(process.execPath, [cli, "verify"], { cwd: repository.root, env: repository.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const exited = new Promise(resolve => verify.on("close", code => resolve(code)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no live output:\n${stdout}`)), 10_000);
      verify.stdout.on("data", chunk => {
        stdout += chunk;
        if (stdout.includes("[lint] started lint") && stdout.includes("[build] started build")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    verify.kill("SIGTERM");
    assert.equal(await exited, 128 + os.constants.signals.SIGTERM);
    assert.match(stdout, /  stop lint \(/);
    assert.match(stdout, /  skip story baseline\n/);
    assert.match(stdout, /\nFailed in [\d.]+s\n$/);
    for (const pid of fs.readFileSync(pids, "utf8").trim().split("\n").map(Number)) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `step process ${pid} outlived verify`);
    }
  } finally {
    repository.cleanup();
    fs.rmSync(pids, { force: true });
  }
});
