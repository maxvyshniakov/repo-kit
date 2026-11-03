// Machine-wide slot leases for heavy checks. With slotfather on PATH a command
// runs under `slotfather run -n <slots>`; without it, as on CI runners, it runs
// directly. A command already under a lease (SLOTFATHER_LEASE set by an outer
// slotfather run) runs without a second one, so nested commands lease once.
// REPO_KIT_SLOT_WAIT=<seconds> (or the older SID_KIT_SLOT_WAIT) gives up
// waiting for the lease after that long: slotfather exits 75, so a CI job fails
// with that reason instead of being cancelled at its time limit while queued.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function hasSlotfather(env = process.env) {
  return spawnSync("sh", ["-c", "command -v slotfather"], { env, stdio: "ignore" }).status === 0;
}

// slotfather's exit status when --wait ran out before a lease was granted.
export const WAIT_EXPIRED = 75;

/** Seconds to wait for a lease before giving up, or 0: wait as long as it takes. */
export function slotWait(env = process.env) {
  const seconds = Number.parseInt(env.REPO_KIT_SLOT_WAIT ?? env.SID_KIT_SLOT_WAIT ?? "", 10);
  return seconds > 0 ? seconds : 0;
}

/** The argv that runs `command` under a lease, or `command` itself when no lease applies. */
export function leasedCommand(slots, command, { env = process.env, cwd = process.cwd(), slotfather = hasSlotfather(env) } = {}) {
  if (env.SLOTFATHER_LEASE || !slotfather) return command;
  const wait = slotWait(env);
  return ["slotfather", "run", "-n", String(slots), "--label", path.basename(cwd), ...(wait ? ["--wait", String(wait)] : []), "--", ...command];
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
export function runLeased(slots, command, { env = process.env, cwd = process.cwd(), input, spawn: start = spawn } = {}) {
  const argv = leasedCommand(slots, command, { env, cwd });
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
export async function leaseSelf(slots, { env = process.env, input } = {}) {
  if (env.SLOTFATHER_LEASE || !hasSlotfather(env)) return false;
  process.exitCode = await runLeased(slots, [process.execPath, ...process.argv.slice(1)], { env, input });
  return true;
}
