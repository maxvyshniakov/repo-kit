// Runs the TLS gate (tls-gate.mjs) on the Bun runtime, whose fetch and https
// clients installs and publication use. The composite action
// actions/setup-bun runs the same file before `bun install`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TLS_GATE = fileURLToPath(new URL("./tls-gate.mjs", import.meta.url));

/** `requireRegistry` (publish): registry.npmjs.org must answer; elsewhere its failure only warns. */
export function runTlsGate({ env = process.env, requireRegistry = false, args = [] } = {}) {
  console.log("TLS gate: the Bun runtime must not trust the compromised eMudhra chains (README.md#tls-gate)");
  const result = spawnSync("bun", [TLS_GATE, ...(requireRegistry ? ["--require-registry"] : []), ...args], { stdio: "inherit", env });
  if (result.error) console.error(`TLS gate: ${result.error.message}`);
  return result.status === 0;
}
