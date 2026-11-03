// The repository's gate: the one command that decides whether a commit may be
// pushed. CI's check job and the pre-push hook run exactly this, so project
// skills and instructions can name the command instead of listing steps.
//
//   repo-kit verify                 the steps of repo-kit.config.mjs verify.steps
//   repo-kit verify --release       the same with release: true (main: no unreleased entries)
//   repo-kit verify --browser       verify.browser, the slower browser checks
//
// A step starts as soon as the steps it needs have passed, so independent steps
// run side by side. Their output streams live, each line prefixed with its
// step. The first failure stops the rest and shows that step's last lines
// again; a signal stops every step and waits for them. A step marked usesCores
// gets the cores this run may use (verifyCores), less what the steps beside it
// keep busy, as VITEST_MAX_WORKERS and REPO_KIT_WORKERS.
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";

// Cores the steps beside a usesCores step keep busy while it runs.
const RESERVED_CORES = 2;

/**
 * Each step: { name, command (bun arguments), needs (names of steps that must
 * pass first), usesCores? }. `needs` defaults to [].
 */
export function normalizeSteps(steps) {
  const seen = new Set();
  return steps.map(step => {
    if (!step?.name || !Array.isArray(step.command)) throw new Error(`verify step needs a name and a command array: ${JSON.stringify(step)}`);
    if (seen.has(step.name)) throw new Error(`duplicate verify step "${step.name}"`);
    const needs = step.needs ?? [];
    for (const need of needs) {
      if (!seen.has(need)) throw new Error(`verify step "${step.name}" needs "${need}", which is not an earlier step`);
    }
    seen.add(step.name);
    return { ...step, needs };
  });
}

/** Steps that run one after another: [[name, command], ...]. */
export function chain(steps) {
  return steps.map(([name, command], index) => ({ name, command, needs: index ? [steps[index - 1][0]] : [] }));
}

export function verifySteps(config, { release = false, browser = false } = {}) {
  const declared = browser ? config.verify.browser : config.verify.steps;
  if (!declared) throw new Error(`repo-kit.config.mjs declares no verify.${browser ? "browser" : "steps"}`);
  return normalizeSteps(typeof declared === "function" ? declared({ release }) : declared);
}

/**
 * The cores this run may use: REPO_KIT_VERIFY_CORES (or the older
 * SID_KIT_VERIFY_CORES) when set; under a slotfather lease its share of the
 * machine (SLOTFATHER_COUNT of `slotfather slots`); otherwise, as on CI, every core.
 */
export function verifyCores(env = process.env, { cpus = os.availableParallelism(), totalSlots = readTotalSlots } = {}) {
  const override = Number.parseInt(env.REPO_KIT_VERIFY_CORES ?? env.SID_KIT_VERIFY_CORES ?? "", 10);
  if (override > 0) return override;
  const leased = Number.parseInt(env.SLOTFATHER_COUNT ?? "", 10);
  if (env.SLOTFATHER_LEASE && leased > 0) {
    const total = totalSlots();
    if (total > 0) return Math.max(1, Math.min(cpus, Math.floor((leased * cpus) / total)));
  }
  return cpus;
}

function readTotalSlots() {
  try {
    const output = execFileSync("slotfather", ["slots"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number(output.match(/^(\d+) slots?\b/)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** Workers for a usesCores step: the run's cores less those the steps beside it keep busy. */
export function unitTestWorkers(cores) {
  return Math.max(1, cores - RESERVED_CORES);
}

/**
 * Runs each step once the steps it needs have passed, every ready step at once.
 * `start(step)` returns { done: Promise<boolean>, stop(signal), stopped }. After
 * the first failure, or once `signal` aborts (its reason is the signal name to
 * forward), nothing new starts and the running steps are stopped. Resolves, once
 * every started step has ended, to { name, status: "ok" | "fail" | "stopped",
 * seconds } per started step.
 */
export async function runSteps(steps, start, { now = Date.now, signal } = {}) {
  const results = new Map();
  const running = new Map();
  let halted = false;
  const halt = reason => {
    halted = true;
    for (const handle of running.values()) handle.stop(reason);
  };
  await new Promise(resolve => {
    const launch = () => {
      for (const step of halted ? [] : steps) {
        if (results.has(step.name) || running.has(step.name)) continue;
        if (!step.needs.every(need => results.get(need)?.status === "ok")) continue;
        const started = now();
        const handle = start(step);
        running.set(step.name, handle);
        handle.done.then(passed => {
          running.delete(step.name);
          const status = passed ? "ok" : handle.stopped ? "stopped" : "fail";
          results.set(step.name, { name: step.name, status, seconds: (now() - started) / 1000 });
          if (status === "fail" && !halted) halt("SIGTERM");
          launch();
        });
      }
      if (!running.size) resolve();
    };
    if (signal?.aborted) halted = true;
    signal?.addEventListener("abort", () => halt(signal.reason), { once: true });
    launch();
  });
  return [...results.values()];
}

// Lines of a failed step's output shown again under the summary.
const FAILURE_TAIL_LINES = 80;

/** Splits a stream into lines and hands each complete one to `line`; `flush` hands over the rest. */
function lineReader(line) {
  let pending = "";
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const text of lines) line(text);
    },
    flush() {
      if (pending) line(pending);
      pending = "";
    },
  };
}

function startProcess(step, { root, cores, running }) {
  const env = { ...process.env };
  if (step.usesCores) env.VITEST_MAX_WORKERS = env.REPO_KIT_WORKERS = String(unitTestWorkers(cores));
  // Each step gets its own process group, so stopping it reaches its workers too.
  const child = spawn("bun", step.command, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // Output streams live, each line prefixed with its step, so a step that hangs is visible.
  const tail = [];
  const write = text => {
    process.stdout.write(`[${step.name}] ${text}\n`);
    tail.push(text);
    if (tail.length > FAILURE_TAIL_LINES) tail.shift();
  };
  const readers = [child.stdout, child.stderr].map(stream => {
    const reader = lineReader(write);
    stream.setEncoding("utf8");
    stream.on("data", chunk => reader.push(chunk));
    return reader;
  });
  const handle = {
    step,
    stopped: false,
    tail,
    stop(signal = "SIGTERM") {
      handle.stopped = true;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    },
  };
  handle.done = new Promise(resolve => {
    let ended = false;
    const finish = passed => {
      if (ended) return;
      ended = true;
      for (const reader of readers) reader.flush();
      running.delete(handle);
      resolve(passed);
    };
    child.on("error", error => {
      write(String(error.stack));
      finish(false);
    });
    child.on("close", code => finish(code === 0));
  });
  running.add(handle);
  return handle;
}

/** Runs the gate in `root`; sets process.exitCode rather than exiting, so piped output drains. */
export async function runVerify(config, { release = false, browser = false } = {}) {
  const steps = verifySteps(config, { release, browser });
  const cores = verifyCores();
  const running = new Set();
  // A signal stops every running step's process group and waits for them; a second one kills them.
  const interrupt = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!interrupt.signal.aborted) {
        console.log(`\nverify: ${signal}, stopping the running steps`);
        interrupt.abort(signal);
        return;
      }
      for (const handle of running) handle.stop("SIGKILL");
      process.exit(128 + os.constants.signals[signal]);
    });
  }
  console.log(`verify: ${cores} cores${steps.some(step => step.usesCores) ? `, ${unitTestWorkers(cores)} workers for the steps that use them` : ""}`);
  const started = Date.now();
  const tails = new Map();
  const results = await runSteps(steps, step => {
    console.log(`  start ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    const handle = startProcess(step, { root: config.root, cores, running });
    tails.set(step.name, handle.tail);
    return handle;
  }, { signal: interrupt.signal });
  for (const { name } of results.filter(result => result.status === "fail")) {
    console.log(`\n=== ${name} failed; its last ${FAILURE_TAIL_LINES} lines:`);
    for (const line of tails.get(name)) console.log(line);
  }
  console.log("\nverify:");
  const symbol = { ok: "ok  ", fail: "FAIL", stopped: "stop" };
  for (const { name, status, seconds } of results) console.log(`  ${symbol[status]} ${name} (${seconds.toFixed(1)}s)`);
  for (const { name } of steps.filter(step => !results.some(result => result.name === step.name))) console.log(`  skip ${name}`);
  const failed = results.length < steps.length || results.some(result => result.status !== "ok");
  console.log(`${failed ? "Failed" : "Passed"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // Not process.exit: stdout to a pipe (CI, the pre-push hook) is written
  // asynchronously, and exiting at once would cut off the steps' output.
  process.exitCode = interrupt.signal.aborted ? 128 + os.constants.signals[interrupt.signal.reason] : failed ? 1 : 0;
}
