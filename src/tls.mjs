// Runs the TLS gate (tls-gate.mjs) on the Bun runtime, whose fetch and https
// clients installs and publication use. The composite action
// actions/setup-bun runs the same file before `bun install`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TLS_GATE = fileURLToPath(new URL("./tls-gate.mjs", import.meta.url));

export function runTlsGate({ env = process.env } = {}) {
  console.log("TLS gate: the Bun runtime must trust registry.npmjs.org and reject the compromised eMudhra chains");
  const result = spawnSync("bun", [TLS_GATE], { stdio: "inherit", env });
  if (result.error) console.error(`TLS gate: ${result.error.message}`);
  return result.status === 0;
}
