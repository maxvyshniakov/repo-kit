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

/** Runs `command` (argv) under a lease, forwarding signals; resolves to its exit code. */
export function runLeased(slots, command, { env = process.env, cwd = process.cwd() } = {}) {
  const [file, ...args] = leasedCommand(slots, command, { env, cwd });
  const child = spawn(file, args, { cwd, env, stdio: "inherit" });
  const forward = signal => child.kill(signal);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, forward);
  return new Promise(resolve => {
    child.on("error", error => {
      console.error(`${file}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      for (const name of signals) process.off(name, forward);
      resolve(code ?? 128 + os.constants.signals[signal]);
    });
  });
}

/** Re-runs this process under a lease unless it already holds one; resolves to false when it did not. */
export async function leaseSelf(slots, env = process.env) {
  if (env.SLOTFATHER_LEASE || !hasSlotfather(env)) return false;
  process.exitCode = await runLeased(slots, [process.execPath, ...process.argv.slice(1)], { env });
  return true;
}
