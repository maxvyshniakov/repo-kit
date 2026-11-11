// GITHUB_TOKEN for the GitHub Packages registry, and the Bun floor.
//
// bunfig.toml reads @maxvyshniakov packages with token = "$GITHUB_TOKEN", so
// every `bun install` needs it: read:packages to install, write:packages to
// publish. In CI the workflow token; locally `gh auth token` when unset.
import { execFileSync } from "node:child_process";

// Bun 1.3.14 trusted the compromised eMudhra chains; 1.4.4 rejects them
// (README.md#tls-gate). The workflows pin the same version.
export const BUN_VERSION = "1.4.4";

/** { token, source } with source "GITHUB_TOKEN" | "gh auth token", or { token: undefined }. */
export function resolveToken(env = process.env, ghToken = readGhToken) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  const token = ghToken();
  return token ? { token, source: "gh auth token" } : { token: undefined };
}

function readGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export const TOKEN_HINT = "export GITHUB_TOKEN=$(gh auth token) (read:packages to install, write:packages to publish)";

export function compareBunVersions(a, b) {
  const [left, right] = [a, b].map(version => version.split(/[.-]/).slice(0, 3).map(Number));
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** An error message when the local Bun is older than BUN_VERSION, else undefined. */
export function bunTooOld(version) {
  if (!version) return "bun is not on PATH";
  return compareBunVersions(version, BUN_VERSION) < 0
    ? `bun ${version} predates ${BUN_VERSION}, the first release that rejects the compromised eMudhra chains; upgrade Bun`
    : undefined;
}

export function localBunVersion() {
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
