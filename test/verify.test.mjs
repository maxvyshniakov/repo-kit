import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import { chain, normalizeSteps, runSteps, sizeSteps, unitTestWorkers, verifyCores, verifyMemory, verifySteps } from "../src/verify.mjs";
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
  assert.throws(() => normalizeSteps([{ name: "a", command: [], memory: "1 GiB" }]), /memory is GiB/);
  assert.throws(() => normalizeSteps([{ name: "a", command: [], workers: 0 }]), /workers is a positive integer/);
  assert.throws(() => normalizeSteps([{ name: "a", command: [], workers: 2, usesCores: true }]), /exclude each other/);
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

test("runSteps starts a step only when its memory fits beside the running ones", async () => {
  const { started, start, settle } = fakeStarts();
  const steps = [
    { name: "big", needs: [], memory: 3 },
    { name: "small", needs: [], memory: 1 },
    { name: "wide", needs: [], memory: 2 },
    { name: "huge", needs: [], memory: 9 },
  ];
  const run = runSteps(steps, start, { now: () => 0, memory: 4 });
  assert.deepEqual(started, ["big", "small"]);
  await settle("small", true);
  assert.deepEqual(started, ["big", "small"], "wide waits for room");
  await settle("big", true);
  assert.deepEqual(started, ["big", "small", "wide"], "huge never fits beside another step");
  await settle("wide", true);
  assert.deepEqual(started, ["big", "small", "wide", "huge"], "a step larger than the budget runs alone");
  await settle("huge", true);
  assert.deepEqual((await run).map(({ status }) => status), ["ok", "ok", "ok", "ok"]);
});

test("verify caps the workers by memory and plans a usesCores step by its workers", () => {
  assert.equal(unitTestWorkers(6, Infinity), 4);
  assert.equal(unitTestWorkers(6, 12), 4, "plenty of memory: cores decide");
  assert.equal(unitTestWorkers(6, 4.5), 2, "a busy runner: half its memory decides");
  assert.equal(unitTestWorkers(6, 1), 1, "never fewer than one");
  assert.equal(unitTestWorkers(12, 8, 2), 2, "the repository's worker memory");
  const sized = sizeSteps(normalizeSteps([
    { name: "unit tests", command: [], usesCores: true },
    { name: "heavy tests", command: [], usesCores: true, memory: 1 },
    { name: "storybook tests", command: [], workers: 2, memory: 1.1 },
    { name: "lint", command: [] },
  ]), { workers: 3, workerMemory: 0.9 });
  assert.deepEqual(sized.map(({ workers, memory }) => [workers, Number(memory.toFixed(2))]), [[3, 2.95], [3, 3.7], [2, 1.1], [undefined, 0]]);
});

test("verify's memory is its lease's slots, capped by the cgroup and MemAvailable", () => {
  const GiB = 1024 ** 3;
  // constrained: 0 is "no cgroup limit"; left out, the test would read the runner's own.
  const noSlotfather = () => ({});
  const linux = { platform: "linux", free: 5 * GiB, total: 12 * GiB, constrained: 0, capacity: noSlotfather };
  assert.equal(verifyMemory({}, linux), 5, "no lease on Linux: what the kernel reports available");
  assert.equal(verifyMemory({}, { ...linux, constrained: 4 * GiB }), 4, "a cgroup limit below it");
  assert.equal(verifyMemory({}, { platform: "darwin", free: 1 * GiB, total: 32 * GiB, constrained: 0, capacity: noSlotfather }), 32, "macOS reports cached pages as used");
  // The homelab runner: two slots of 5 GiB.
  const runner = { platform: "linux", free: 9 * GiB, total: 12 * GiB, constrained: 6 * GiB, capacity: () => ({ total: 2, gib_per_slot: 5 }) };
  const lease = count => ({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: String(count) });
  assert.equal(verifyMemory(lease(1), runner), 5, "one slot: its memory");
  assert.equal(verifyMemory(lease(3), runner), 6, "every slot, capped by the cgroup");
  assert.equal(verifyMemory(lease(3), { ...runner, free: 3 * GiB }), 3, "and by MemAvailable");
  assert.equal(verifyMemory(lease(3), { ...runner, constrained: 0 }), 9, "two slots of 5 GiB, MemAvailable lower");
  assert.equal(verifyMemory(lease(3), { platform: "darwin", free: 1 * GiB, total: 32 * GiB, constrained: 0, capacity: () => ({ total: 6, gib_per_slot: null }) }), Infinity, "a lease of cores only: cores decide");
  assert.equal(verifyMemory({ REPO_KIT_VERIFY_MEMORY_GIB: "6" }, linux), 6);
});

test("verify sizes the steps that use cores to its lease", () => {
  const options = { cpus: 12, capacity: () => ({ total: 6 }) };
  assert.equal(verifyCores({}, options), 12);
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "3" }, options), 6);
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "6" }, options), 12);
  assert.equal(verifyCores({ SLOTFATHER_COUNT: "3" }, options), 12, "no lease without SLOTFATHER_LEASE");
  assert.equal(verifyCores({ SLOTFATHER_LEASE: "/lease", SLOTFATHER_COUNT: "3" }, { cpus: 12, capacity: () => ({}) }), 12, "slotfather unreadable");
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
  { name: "build", command: ["run", "build"], memory: 0.1 },
  { name: "typecheck", command: ["run", "typecheck"], needs: ["build"], workers: 2 },
  { name: "story baseline", command: ["run", "baseline"], needs: ["typecheck"] },
] } };
`,
  });
  fs.mkdirSync(path.join(repository.root, "bin"));
  fs.writeFileSync(path.join(repository.root, "bin/bun"), bunScript, { mode: 0o755 });
  const env = { ...process.env, PATH: `${path.join(repository.root, "bin")}:${process.env.PATH}`, REPO_KIT_VERIFY_CORES: "2", REPO_KIT_VERIFY_MEMORY_GIB: "16", SLOTFATHER_LEASE: "test" };
  delete env.GITHUB_ACTIONS;
  return { ...repository, env };
}

function runFakeVerify({ failing = "", bytes = 1 << 20, sleepBuild = false } = {}) {
  const repository = fakeRepository(`#!/bin/sh
node -e 'process.stdout.write("x".repeat(${bytes}) + "\\n")'
[ "$2" = "${failing}" ] && exit 3
[ -n "${failing}" ] && sleep 5
[ "$2" = "test" ] && echo "workers=$VITEST_MAX_WORKERS/$REPO_KIT_WORKERS"
[ "$2" = "typecheck" ] && echo "workers=$VITEST_MAX_WORKERS/$REPO_KIT_WORKERS"
[ "$2" = "build" ] && [ -n "${sleepBuild}" ] && node -e 'const a = Buffer.alloc(64 << 20, 1); setTimeout(() => a.length, 2500)'
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
  assert.match(stdout, /\[typecheck\] workers=2\/2\n/, "a step's fixed worker count");
  assert.match(stdout, /^verify: 2 cores, 16\.0 GiB, 1 workers for the steps that use them\n/);
  assert.match(stdout, /\nPassed in [\d.]+s\n$/);
});

test("verify's summary shows each step's measured peak beside its declared memory", () => {
  const { status, stdout } = runFakeVerify({ bytes: 10, sleepBuild: true });
  assert.equal(status, 0);
  assert.match(stdout, /\nPeak RSS [\d.]+ GiB \(.*build [\d.]+.*\), sampled every second\n/);
  assert.match(stdout, /\nStep peaks, measured\/declared GiB: .*build [\d.]+\/0\.1/);
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

test("when verify is killed outright, its reaper stops every step", async () => {
  const pids = path.join(os.tmpdir(), `repo-kit-reaped-${process.pid}-${Date.now()}`);
  const repository = fakeRepository(`#!/bin/sh
echo "$$" >> "${pids}"
echo "started $2"
exec sleep 30
`);
  try {
    const verify = spawn(process.execPath, [cli, "verify"], { cwd: repository.root, env: repository.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
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
    const started = () => fs.readFileSync(pids, "utf8").trim().split("\n").map(Number);
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.ok(started().every(alive));
    verify.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (started().some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(started().filter(alive), [], "step processes outlived a killed verify");
  } finally {
    repository.cleanup();
    fs.rmSync(pids, { force: true });
  }
});

test("one Ctrl-C delivered twice, as under bun run, still lets every step stop on its own", async () => {
  const marks = path.join(os.tmpdir(), `repo-kit-marks-${process.pid}-${Date.now()}`);
  const repository = fakeRepository(`#!/bin/sh
trap 'sleep 0.3; echo "$2" >> "${marks}"; exit 130' INT TERM
echo "started $2"
while :; do sleep 0.1; done
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
    verify.kill("SIGINT");
    await new Promise(resolve => setTimeout(resolve, 50));
    verify.kill("SIGINT");
    assert.equal(await exited, 128 + os.constants.signals.SIGINT);
    assert.match(stdout, /\nFailed in [\d.]+s\n$/, "the summary printed");
    assert.match(fs.readFileSync(marks, "utf8"), /lint/, "the step's own handler ran, so it was not SIGKILLed");
  } finally {
    repository.cleanup();
    fs.rmSync(marks, { force: true });
  }
});
