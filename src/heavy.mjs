// Machine-wide slot leases for heavy checks. With slotfather on PATH a command
// runs under `slotfather run -n <slots>`; without it, as on CI runners, it runs
// directly. A command already under a lease (SLOTFATHER_LEASE set by an outer
// slotfather run) runs without a second one, so nested commands lease once.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function hasSlotfather(env = process.env) {
  return spawnSync("sh", ["-c", "command -v slotfather"], { env, stdio: "ignore" }).status === 0;
}

/** The argv that runs `command` under a lease, or `command` itself when no lease applies. */
export function leasedCommand(slots, command, { env = process.env, cwd = process.cwd(), slotfather = hasSlotfather(env) } = {}) {
  if (env.SLOTFATHER_LEASE || !slotfather) return command;
  return ["slotfather", "run", "-n", String(slots), "--label", path.basename(cwd), "--", ...command];
}

/**
 * Runs `command` (argv) under a lease; resolves to its exit code. `input`, when
 * given, is written to its stdin. SIGTERM and SIGHUP are forwarded. SIGINT is
 * not: Ctrl-C reaches the child from the terminal's process group already, and
 * forwarding it too would deliver it twice. The listener keeps this process
 * alive until the child has handled it.
 */
export function runLeased(slots, command, { env = process.env, cwd = process.cwd(), input } = {}) {
  const [file, ...args] = leasedCommand(slots, command, { env, cwd });
  const child = spawn(file, args, { cwd, env, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
  if (input !== undefined) child.stdin.end(input);
  const forward = signal => child.kill(signal);
  const ignore = () => {};
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", ignore);
  return new Promise(resolve => {
    child.on("error", error => {
      console.error(`${file}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
      process.off("SIGINT", ignore);
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
