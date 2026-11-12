// Machine-wide slot leases for heavy checks. With slotfather on PATH a command
// runs under `slotfather run -n <slots>`; without it, as on CI runners, it runs
// directly. A command already under a lease (SLOTFATHER_LEASE set by an outer
// slotfather run) runs without a second one, so nested commands lease once.
// REPO_KIT_SLOT_WAIT=<seconds> (or the older SID_KIT_SLOT_WAIT) gives up
// waiting for the lease after that long: slotfather exits 75, so a CI job fails
// with that reason instead of being cancelled at its time limit while queued.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function hasSlotfather(env = process.env) {
  return spawnSync("sh", ["-c", "command -v slotfather"], { env, stdio: "ignore" }).status === 0;
}

/**
 * The slots `verify` leases: REPO_KIT_VERIFY_SLOTS when set (CI's reusable
 * workflows set it, `all` by default, so a job holds the whole runner),
 * otherwise the repository's configured count.
 */
export function verifyLeaseSlots(configured, env = process.env) {
  return env.REPO_KIT_VERIFY_SLOTS || configured;
}

// slotfather's exit status when --wait ran out before a lease was granted.
export const WAIT_EXPIRED = 75;

/** Seconds to wait for a lease before giving up, or 0: wait as long as it takes. */
export function slotWait(env = process.env) {
  const seconds = Number.parseInt(env.REPO_KIT_SLOT_WAIT ?? env.SID_KIT_SLOT_WAIT ?? "", 10);
  return seconds > 0 ? seconds : 0;
}

/**
 * The project a lease runs for: the main checkout's directory (the same in
 * every worktree, unlike the worktree's own name), else package.json's
 * unscoped name, else the directory.
 */
export function projectName(cwd = process.cwd()) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.basename(common) === ".git") return path.basename(path.dirname(common));
  } catch { /* not a repository */ }
  try {
    const { name } = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (name) return name.replace(/^@[^/]+\//, "");
  } catch { /* no package.json */ }
  return path.basename(cwd);
}

/** What a lease is for when the caller does not say: the package script that runs it, or the command's first words. */
export function commandPurpose(command, env = process.env) {
  if (env.npm_lifecycle_event) return env.npm_lifecycle_event;
  const words = command.filter(word => !word.startsWith("-")).slice(0, 3).map(word => path.basename(word));
  return words.join(" ") || "command";
}

/**
 * The lease's label: who and what, never a bare directory name. A label from
 * REPO_KIT_SLOT_LABEL (a lane's, say) gets the purpose appended unless it has
 * one already (a space).
 */
export function slotLabel(purpose, { env = process.env, cwd = process.cwd() } = {}) {
  const given = env.REPO_KIT_SLOT_LABEL;
  if (given) return given.includes(" ") || !purpose ? given : `${given} ${purpose}`;
  return `${projectName(cwd)} ${purpose}`;
}

/** The argv that runs `command` under a lease, or `command` itself when no lease applies. */
export function leasedCommand(slots, command, { env = process.env, cwd = process.cwd(), slotfather = hasSlotfather(env), purpose } = {}) {
  if (env.SLOTFATHER_LEASE || !slotfather) return command;
  const wait = slotWait(env);
  const context = [];
  if (env.REPO_KIT_SLOT_PRIORITY) {
    if (!["interactive", "normal", "batch"].includes(env.REPO_KIT_SLOT_PRIORITY)) throw new Error("invalid execution priority");
    context.push("--priority", env.REPO_KIT_SLOT_PRIORITY);
  }
  if (env.REPO_KIT_SLOT_TICKET) context.push("--ticket", env.REPO_KIT_SLOT_TICKET);
  if (env.REPO_KIT_SLOT_META) {
    let metadata;
    try { metadata = JSON.parse(env.REPO_KIT_SLOT_META); }
    catch { throw new Error("invalid execution metadata JSON"); }
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") throw new Error("execution metadata must be an object");
    for (const [key, value] of Object.entries(metadata)) {
      if (["priority", "ticket"].includes(key) || typeof value !== "string") throw new Error("invalid execution metadata fields");
      context.push("--meta", `${key}=${value}`);
    }
  }
  if (env.REPO_KIT_SLOT_YIELDABLE === "1") context.push("--yieldable");
  const label = env.REPO_KIT_SLOT_LABEL && !purpose ? env.REPO_KIT_SLOT_LABEL : slotLabel(purpose ?? commandPurpose(command, env), { env, cwd });
  return ["slotfather", "run", "-n", String(slots), "--label", label,
    ...context, ...(wait ? ["--wait", String(wait)] : []), "--", ...command];
}

/**
 * Runs `command` (argv) under a lease; resolves to its exit code. `input`, when
 * given, is written to its stdin. SIGTERM and SIGHUP are forwarded. SIGINT is
 * not: Ctrl-C reaches the child from the terminal's process group already, and
 * forwarding it too would deliver it twice. The listeners keep this process
 * alive until the child has handled the signal, and are in place before the
 * child starts: the child writes to the same stdout, so whoever reads it can
 * signal this process before spawn's caller runs another line.
 */
export function runLeased(slots, command, { env = process.env, cwd = process.cwd(), input, purpose, spawn: start = spawn } = {}) {
  const argv = leasedCommand(slots, command, { env, cwd, purpose });
  const [file, ...args] = argv;
  const leased = argv !== command;
  // A signal is caught from here on and handled on the event loop, by when
  // `child` is set.
  let child;
  const forward = signal => child.kill(signal);
  const ignore = () => {};
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", ignore);
  const release = () => {
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", ignore);
  };
  child = start(file, args, { cwd, env, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
  if (input !== undefined) child.stdin.end(input);
  return new Promise(resolve => {
    child.on("error", error => {
      release();
      console.error(`${file}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      release();
      if (leased && code === WAIT_EXPIRED && slotWait(env)) {
        console.error(`repo-kit: gave up waiting for ${slots} slot(s) after ${slotWait(env)}s (slotfather status shows the queue)`);
      }
      resolve(code ?? 128 + os.constants.signals[signal]);
    });
  });
}

/**
 * Re-runs this process under a lease unless it already holds one or there is
 * no slotfather; resolves to whether it did (process.exitCode then holds the
 * leased run's code).
 */
export async function leaseSelf(slots, { env = process.env, input, purpose = process.argv.slice(2, 4).map(arg => arg.replace(/^-+/, "")).join(" ") || "repo-kit" } = {}) {
  if (env.SLOTFATHER_LEASE || !hasSlotfather(env)) return false;
  process.exitCode = await runLeased(slots, [process.execPath, ...process.argv.slice(1)], { env, input, purpose });
  return true;
}
