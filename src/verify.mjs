// The repository's gate: the one command that decides whether a commit may be
// pushed. CI's check job and the pre-push hook run exactly this, so project
// skills and instructions can name the command instead of listing steps.
//
//   repo-kit verify                 the steps of repo-kit.config.mjs verify.steps
//   repo-kit verify --release       the same with release: true (main: no unreleased entries)
//   repo-kit verify --browser       verify.browser, the slower browser checks
//
// A step starts as soon as the steps it needs have passed and its memory fits
// beside the running steps, so independent steps run side by side. Their
// output streams live, each line prefixed with its step. The first failure
// stops the rest and shows that step's last lines again; a signal stops every
// step and waits for them, and a reaper stops them when verify itself is
// killed outright. A step marked usesCores gets the cores this run may use
// (verifyCores), less what the steps beside it keep busy, and no more workers
// than half the run's memory holds (verifyMemory), as VITEST_MAX_WORKERS and
// REPO_KIT_WORKERS; a step with `workers` gets that fixed count. The summary
// shows each step's measured peak memory beside the figure it declares: the
// resident memory of its whole process tree, browsers in sessions of their own
// included, and on Linux the job cgroup's peak.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cores the steps beside a usesCores step keep busy while it runs.
const RESERVED_CORES = 2;
const GiB = 1024 ** 3;
// What one test worker holds at its peak, by default (verify.workerMemory):
// Data Grid's Vitest workers, VM contexts up to vmMemoryLimit plus the worker.
export const WORKER_MEMORY_GIB = 0.9;
// What a usesCores step holds besides its workers, by default (its `memory`).
const USES_CORES_BASE_GIB = 0.25;

/**
 * Each step: { name, command (bun arguments), needs (names of steps that must
 * pass first), memory? (GiB it holds at its peak; 0 when left out), usesCores?
 * (test workers from the run's cores and memory; `memory` is then what it holds
 * besides them), workers? (a fixed worker count) }. `needs` defaults to [].
 */
export function normalizeSteps(steps) {
  const seen = new Set();
  return steps.map(step => {
    if (!step?.name || !Array.isArray(step.command)) throw new Error(`verify step needs a name and a command array: ${JSON.stringify(step)}`);
    if (seen.has(step.name)) throw new Error(`duplicate verify step "${step.name}"`);
    if (step.memory !== undefined && !(step.memory >= 0)) throw new Error(`verify step "${step.name}": memory is GiB, a number of 0 or more`);
    if (step.workers !== undefined && !(Number.isInteger(step.workers) && step.workers > 0)) throw new Error(`verify step "${step.name}": workers is a positive integer`);
    if (step.workers && step.usesCores) throw new Error(`verify step "${step.name}": usesCores and workers exclude each other`);
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
 * machine (SLOTFATHER_COUNT of slotfather's total slots); otherwise, as on CI
 * without slotfather, every core.
 */
export function verifyCores(env = process.env, { cpus = os.availableParallelism(), capacity = readCapacity } = {}) {
  const override = Number.parseInt(env.REPO_KIT_VERIFY_CORES ?? env.SID_KIT_VERIFY_CORES ?? "", 10);
  if (override > 0) return override;
  const leased = leasedSlots(env);
  if (leased) {
    const { total } = capacity();
    if (total > 0) return Math.max(1, Math.min(cpus, Math.floor((leased * cpus) / total)));
  }
  return cpus;
}

function leasedSlots(env) {
  const count = Number.parseInt(env.SLOTFATHER_COUNT ?? "", 10);
  return env.SLOTFATHER_LEASE && count > 0 ? count : 0;
}

let capacityCache;
/** slotfather's capacity (`slotfather advise`: total slots, gib_per_slot), or {} without slotfather. */
function readCapacity() {
  if (!capacityCache) {
    try {
      capacityCache = JSON.parse(execFileSync("slotfather", ["advise"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      capacityCache = {};
    }
  }
  return capacityCache;
}

/**
 * The memory this run may use, in GiB: REPO_KIT_VERIFY_MEMORY_GIB when set.
 * Under a slotfather lease, the leased slots times the memory slotfather gives
 * a slot (the homelab runner: 5 GiB), or no figure where slotfather budgets
 * cores only (this Mac); without a lease, what Linux reports available, or all
 * memory elsewhere (macOS counts its cache as used). Always no more than the
 * job's cgroup limit (process.constrainedMemory) and, on Linux, MemAvailable.
 * Infinity: no figure, cores decide.
 */
export function verifyMemory(env = process.env, {
  platform = process.platform, free = os.freemem(), total = os.totalmem(),
  constrained = process.constrainedMemory?.(), capacity = readCapacity,
} = {}) {
  const override = Number.parseFloat(env.REPO_KIT_VERIFY_MEMORY_GIB ?? "");
  if (override > 0) return override;
  const limits = [];
  if (constrained > 0 && constrained < total) limits.push(constrained / GiB);
  if (platform === "linux") limits.push(free / GiB);
  const leased = leasedSlots(env);
  if (leased) {
    // A request above the total holds every slot.
    const { gib_per_slot: perSlot, total: slots } = capacity();
    if (perSlot > 0) limits.push(Math.min(leased, slots > 0 ? slots : leased) * perSlot);
  } else if (platform !== "linux") {
    limits.push(total / GiB);
  }
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * Workers for a usesCores step: the run's cores less those the steps beside it
 * keep busy, and no more than half the run's memory (GiB) holds at
 * `workerMemory` GiB each, so the other steps keep room beside it. Several jobs
 * share CI's runner, so a core count alone can run it out of memory.
 */
export function unitTestWorkers(cores, memory = Infinity, workerMemory = WORKER_MEMORY_GIB) {
  const byMemory = Math.floor(memory / 2 / workerMemory);
  return Math.max(1, Math.min(cores - RESERVED_CORES, byMemory));
}

/** Each step's worker count and the memory it is planned with: a usesCores step's follows its workers. */
export function sizeSteps(steps, { workers, workerMemory = WORKER_MEMORY_GIB }) {
  return steps.map(step => {
    if (step.usesCores) return { ...step, workers, memory: workers * workerMemory + (step.memory ?? USES_CORES_BASE_GIB) };
    return { ...step, memory: step.memory ?? 0 };
  });
}

/**
 * Runs each step once the steps it needs have passed and its `memory` fits in
 * the run's `memory` beside the running steps, every such step at once; one
 * that never fits runs alone. `start(step)` returns { done: Promise<boolean>,
 * stop(signal), stopped }. After the first failure, or once `signal` aborts (its
 * reason is the signal name to forward), nothing new starts and the running
 * steps are stopped. Resolves, once every started step has ended, to { name,
 * status: "ok" | "fail" | "stopped", seconds } per started step.
 */
export async function runSteps(steps, start, { now = Date.now, signal, memory = Infinity } = {}) {
  const results = new Map();
  const running = new Map();
  let held = 0;
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
        const needed = step.memory ?? 0;
        if (running.size && held + needed > memory) continue;
        held += needed;
        const started = now();
        const handle = start(step);
        running.set(step.name, handle);
        handle.done.then(passed => {
          running.delete(step.name);
          held -= needed;
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

/**
 * Each step's processes in one process table ({ pid, ppid, pgid, rss } rows,
 * rss in KiB): its process group, every descendant of its first process by
 * parent pid (Chromium and agent-browser start sessions of their own, outside
 * the group), and every process an earlier sample found in it that is still
 * running (one reparented to init has left the tree). `roots` maps each running
 * step's first pid, its group, to its name; `members` (name -> Set of pids)
 * carries what earlier samples found. A child of init that no step holds and
 * `checked` has not seen is offered once to `marked` (pids -> Map of pid to
 * step name): a daemon such as agent-browser's, orphaned before any sample saw
 * it, joins the step whose REPO_KIT_STEP its environment carries. Returns
 * name -> { pids, gib }.
 */
export function stepProcesses(table, roots, members = new Map(), { marked = () => new Map(), checked = new Set() } = {}) {
  const byPid = new Map(table.map(row => [row.pid, row]));
  const children = new Map();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const tree = (starts, pids = new Set()) => {
    const stack = starts.filter(pid => byPid.has(pid));
    while (stack.length) {
      const pid = stack.pop();
      if (pids.has(pid)) continue;
      pids.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    return pids;
  };
  const names = new Set(roots.values());
  for (const name of members.keys()) if (!names.has(name)) members.delete(name);
  const found = new Map();
  for (const [root, name] of roots) {
    const known = [...(members.get(name) ?? [])];
    found.set(name, tree([root, ...known, ...table.filter(row => row.pgid === root).map(row => row.pid)]));
  }
  const held = new Set([...found.values()].flatMap(pids => [...pids]));
  const orphans = table.filter(row => row.ppid === 1 && !held.has(row.pid) && !checked.has(row.pid)).map(row => row.pid);
  for (const pid of orphans) checked.add(pid);
  if (orphans.length && names.size) {
    for (const [pid, name] of marked(orphans)) if (found.has(name)) tree([pid], found.get(name));
  }
  const result = new Map();
  for (const [name, pids] of found) {
    members.set(name, pids);
    let kib = 0;
    for (const pid of pids) kib += byPid.get(pid).rss;
    result.set(name, { pids, gib: (kib * 1024) / GiB });
  }
  return result;
}

// Each step's environment carries REPO_KIT_STEP=<this run>.<step index>, so a
// process it starts that leaves its tree can still be told apart.
const STEP_MARK = "REPO_KIT_STEP";
const RUN_MARK = `${process.pid}-${Date.now().toString(36)}`;

/**
 * Those of `pids` whose environment carries one of `marks` (REPO_KIT_STEP
 * value -> step name), as pid -> name. Linux reads /proc/<pid>/environ, macOS
 * `ps -E`; either shows only the user's own processes (macOS: not platform
 * binaries), and the rest read as unmarked.
 */
export function markedProcesses(pids, marks, { platform = process.platform } = {}) {
  const found = new Map();
  if (!pids.length || !marks.size) return found;
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        const entry = fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").find(item => item.startsWith(`${STEP_MARK}=`));
        const name = entry && marks.get(entry.slice(STEP_MARK.length + 1));
        if (name) found.set(pid, name);
      } catch {
        // gone, or not ours
      }
    }
    return found;
  }
  let output = "";
  try {
    output = execFileSync("ps", ["-wwE", "-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    output = error.stdout ?? ""; // ps exits 1 when one of the pids is gone
  }
  for (const line of output.split("\n")) {
    const match = line.match(new RegExp(`^\\s*(\\d+) .* ${STEP_MARK}=(\\S+)(?: |$)`));
    const name = match && marks.get(match[2]);
    if (name) found.set(Number(match[1]), name);
  }
  return found;
}

/** The machine's process table, for stepProcesses. */
function parseProcessTable(output) {
  const table = [];
  for (const line of output.split("\n")) {
    const [pid, ppid, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) table.push({ pid, ppid, pgid, rss: rss || 0 });
  }
  return table;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,rss="];


/**
 * The job's cgroup (cgroup v2, this process's, from /proc/self/cgroup) on
 * Linux, for the summary: the memory of everything in the job, its page cache
 * included. memory.peak is reset for this reader where the kernel allows it
 * (6.12 and later), so it covers this run alone; elsewhere the samples of
 * memory.current give the peak. `sample()` takes one, `stop()` returns { gib,
 * source }. Undefined off Linux and where the cgroup has no memory files.
 */
export function cgroupMemory({ proc = "/proc/self/cgroup", root = "/sys/fs/cgroup" } = {}) {
  let group;
  try {
    group = fs.readFileSync(proc, "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3).trim();
  } catch {
    return undefined;
  }
  if (!group) return undefined;
  const dir = path.join(root, group);
  const read = file => {
    try {
      const bytes = Number.parseInt(fs.readFileSync(path.join(dir, file), "utf8"), 10);
      return Number.isFinite(bytes) ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
  if (read("memory.current") === undefined) return undefined;
  let peakFd;
  try {
    peakFd = fs.openSync(path.join(dir, "memory.peak"), "r+");
    fs.writeSync(peakFd, "reset\n");
  } catch {
    if (peakFd !== undefined) fs.closeSync(peakFd);
    peakFd = undefined;
  }
  let sampled = 0;
  return {
    path: group,
    sample() {
      sampled = Math.max(sampled, read("memory.current") ?? 0);
    },
    stop() {
      this.sample();
      if (peakFd !== undefined) {
        try {
          const buffer = Buffer.alloc(64);
          const bytes = Number.parseInt(buffer.toString("utf8", 0, fs.readSync(peakFd, buffer, 0, 64, 0)), 10);
          if (Number.isFinite(bytes)) return { gib: Math.max(bytes, sampled) / GiB, source: "memory.peak" };
        } catch {
          // fall back to the samples
        } finally {
          fs.closeSync(peakFd);
          peakFd = undefined;
        }
      }
      return { gib: sampled / GiB, source: "memory.current" };
    },
  };
}

/**
 * Samples the resident memory of every running step's processes
 * (stepProcesses) once a second, and the job's cgroup where there is one;
 * `stop()` returns the highest total (GiB), each step's share of it, each
 * step's own peak (`each`), the figure its `memory` declares, and the cgroup's
 * peak (`cgroup`).
 */
function sampleMemory(roots, marks, { cgroup = cgroupMemory() } = {}) {
  let peak = { total: 0, steps: {} };
  const each = {};
  const members = new Map();
  const checked = new Set();
  const marked = pids => markedProcesses(pids, marks);
  const sample = () => {
    cgroup?.sample();
    execFile("ps", PS_ARGS, (error, output) => {
      if (error) return;
      const steps = {};
      for (const [name, { gib }] of stepProcesses(parseProcessTable(output), roots, members, { marked, checked })) {
        steps[name] = gib;
        each[name] = Math.max(each[name] ?? 0, gib);
      }
      const total = Object.values(steps).reduce((sum, gib) => sum + gib, 0);
      if (total > peak.total) peak = { total, steps };
    });
  };
  const timer = setInterval(sample, 1000);
  timer.unref();
  return {
    /** Every process step `name` runs now, read at once: to stop all of them. */
    processes(name) {
      const root = [...roots].find(([, step]) => step === name)?.[0];
      try {
        const table = parseProcessTable(execFileSync("ps", PS_ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
        return [...(stepProcesses(table, roots, members, { marked, checked }).get(name)?.pids ?? [root])];
      } catch {
        return root ? [root] : [];
      }
    },
    stop: () => {
      clearInterval(timer);
      return { ...peak, each, cgroup: cgroup && { path: cgroup.path, ...cgroup.stop() } };
    },
  };
}

// Runs beside verify in its own process group and reads the step groups verify
// starts ("+pgid") and ends ("-pgid") from its stdin. When that pipe closes
// before "done", verify itself died, SIGKILL included, which no handler sees:
// the reaper stops every step group still listed, SIGKILL after 5 s.
const REAPER = `
const groups = new Set();
let done = false;
let pending = "";
const signal = (name) => { for (const group of groups) { try { process.kill(-group, name); } catch {} } };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (pending + chunk).split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    if (line === "done") done = true;
    else if (line[0] === "+") groups.add(Number(line.slice(1)));
    else if (line[0] === "-") groups.delete(Number(line.slice(1)));
  }
});
process.stdin.on("end", () => {
  if (done || !groups.size) return;
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5000);
});
`;

/** Starts the reaper; `add`/`remove` report step groups, `done` releases it. */
export function startReaper() {
  const reaper = spawn(process.execPath, ["-e", REAPER], { stdio: ["pipe", "ignore", "ignore"], detached: true });
  reaper.unref();
  reaper.stdin.on("error", () => {});
  reaper.stdin.unref?.();
  return {
    add: pgid => reaper.stdin.write(`+${pgid}\n`),
    remove: pgid => reaper.stdin.write(`-${pgid}\n`),
    done: () => reaper.stdin.end("done\n"),
  };
}

const REPEAT_SIGNAL_MS = 1000;

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

function startProcess(step, { root, running, mark }) {
  const env = { ...process.env, [STEP_MARK]: mark };
  if (step.workers) env.VITEST_MAX_WORKERS = env.REPO_KIT_WORKERS = String(step.workers);
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
    pid: child.pid,
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
  const cores = verifyCores();
  const memory = verifyMemory();
  const { workerMemory } = config.verify;
  const workers = unitTestWorkers(cores, memory, workerMemory);
  const steps = sizeSteps(verifySteps(config, { release, browser }), { workers, workerMemory });
  const running = new Set();
  // A signal stops every running step's process group and waits for them; a
  // second one kills them. One Ctrl-C under `bun run verify` arrives twice, from
  // the terminal's process group and from bun forwarding it, so a repeat within
  // REPEAT_SIGNAL_MS of the first is the same keypress.
  const interrupt = new AbortController();
  let interrupted = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!interrupt.signal.aborted) {
        console.log(`\nverify: ${signal}, stopping the running steps`);
        interrupted = Date.now();
        interrupt.abort(signal);
        return;
      }
      if (Date.now() - interrupted < REPEAT_SIGNAL_MS) return;
      for (const handle of running) handle.stop("SIGKILL");
      process.exit(128 + os.constants.signals[signal]);
    });
  }
  const memoryText = Number.isFinite(memory) ? `, ${memory.toFixed(1)} GiB` : "";
  console.log(`verify: ${cores} cores${memoryText}${steps.some(step => step.usesCores) ? `, ${workers} workers for the steps that use them` : ""}`);
  const started = Date.now();
  const tails = new Map();
  const groups = new Map();
  const marks = new Map(steps.map((step, index) => [`${RUN_MARK}.${index}`, step.name]));
  const memorySamples = sampleMemory(groups, marks);
  const reaper = startReaper();
  const results = await runSteps(steps, step => {
    console.log(`  start ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    const handle = startProcess(step, { root: config.root, running, mark: `${RUN_MARK}.${steps.indexOf(step)}` });
    tails.set(step.name, handle.tail);
    if (handle.pid) {
      groups.set(handle.pid, step.name);
      reaper.add(handle.pid);
      handle.done.then(() => {
        groups.delete(handle.pid);
        reaper.remove(handle.pid);
      });
    }
    return handle;
  }, { signal: interrupt.signal, memory });
  const peak = memorySamples.stop();
  reaper.done();
  for (const { name } of results.filter(result => result.status === "fail")) {
    console.log(`\n=== ${name} failed; its last ${FAILURE_TAIL_LINES} lines:`);
    for (const line of tails.get(name)) console.log(line);
  }
  console.log("\nverify:");
  const symbol = { ok: "ok  ", fail: "FAIL", stopped: "stop" };
  for (const { name, status, seconds } of results) console.log(`  ${symbol[status]} ${name} (${seconds.toFixed(1)}s)`);
  for (const { name } of steps.filter(step => !results.some(result => result.name === step.name))) console.log(`  skip ${name}`);
  const failed = results.length < steps.length || results.some(result => result.status !== "ok");
  const shares = Object.entries(peak.steps).filter(([, gib]) => gib > 0).sort((a, b) => b[1] - a[1])
    .map(([name, gib]) => `${name} ${gib.toFixed(1)}`).join(", ");
  if (peak.total > 0) console.log(`Peak RSS ${peak.total.toFixed(1)} GiB${shares ? ` (${shares})` : ""}, sampled every second`);
  const declared = new Map(steps.map(step => [step.name, step.memory]));
  const eachPeak = Object.entries(peak.each).filter(([, gib]) => gib > 0).sort((a, b) => b[1] - a[1])
    .map(([name, gib]) => `${name} ${gib.toFixed(1)}/${declared.get(name).toFixed(1)}`).join(", ");
  if (eachPeak) console.log(`Step peaks, measured/declared GiB: ${eachPeak}`);
  if (peak.cgroup?.gib > 0) console.log(`Job cgroup peak ${peak.cgroup.gib.toFixed(1)} GiB (${peak.cgroup.source} of ${peak.cgroup.path}, page cache included)`);
  console.log(`${failed ? "Failed" : "Passed"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // Not process.exit: stdout to a pipe (CI, the pre-push hook) is written
  // asynchronously, and exiting at once would cut off the steps' output.
  process.exitCode = interrupt.signal.aborted ? 128 + os.constants.signals[interrupt.signal.reason] : failed ? 1 : 0;
}
