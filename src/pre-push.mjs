// Git pre-push hook (.githooks/pre-push, written by `repo-kit hooks sync`).
// Runs `bun run verify` on each commit being pushed, in a clean temporary
// worktree, so uncommitted files cannot make it pass. A push to main runs
// `verify --release`. Skip once with `git push --no-verify`.
//
// The hook holds one slot lease (prePush.slots) for the installs and every
// verification, including older commits whose verify has no lease of its own.
// `bun install` in the worktree reads the private registry with GITHUB_TOKEN,
// or with `gh auth token` when GITHUB_TOKEN is unset.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bunTooOld, localBunVersion, resolveToken, TOKEN_HINT } from "./token.mjs";

const ZERO = /^0+$/;
const RELEASE_REF = "refs/heads/main";

// Commits that passed, one "<sha>[ release]" per line in the common Git
// directory. Earlier copies of this hook used the other names.
export const VERIFIED_RECORD = "repo-kit-verified";
const LEGACY_RECORDS = ["sid-kit-verified", "verified-commits"];

/** Git passes "<local ref> <local sha> <remote ref> <remote sha>" per line. */
export function commitsToVerify(stdin) {
  const commits = new Map();
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleting a ref
    if (localRef.startsWith("refs/tags/") || remoteRef?.startsWith("refs/tags/")) continue;
    const release = remoteRef === RELEASE_REF;
    commits.set(localSha, (commits.get(localSha) ?? false) || release);
  }
  return [...commits].map(([sha, release]) => ({ sha, release }));
}

// Hooks run with GIT_DIR and friends pointing at this checkout; commands in
// the temporary worktree must resolve their own.
export function cleanEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH)$/.test(name)) {
      delete clean[name];
    }
  }
  return clean;
}

export function readVerified(gitDir) {
  const keys = new Set();
  for (const name of [VERIFIED_RECORD, ...LEGACY_RECORDS]) {
    const file = path.join(gitDir, name);
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line) keys.add(line);
  }
  return keys;
}

/** The command that verifies a checked-out commit, or undefined when it predates any gate. */
export function verifyCommand(worktree, release) {
  const manifest = path.join(worktree, "package.json");
  const scripts = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).scripts ?? {} : {};
  if (scripts.verify) return ["bun", ["run", "verify", ...(release ? ["--", "--release"] : [])]];
  if (fs.existsSync(path.join(worktree, "scripts/verify.mjs"))) return ["node", ["scripts/verify.mjs", ...(release ? ["--release"] : [])]];
  return undefined;
}

export function runPrePush({ stdin = fs.readFileSync(0, "utf8") } = {}) {
  const env = cleanEnvironment();
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", env }).trim();
  const commits = commitsToVerify(stdin);
  if (!commits.length) return 0;
  const tooOld = bunTooOld(localBunVersion());
  if (tooOld) {
    console.error(`pre-push: ${tooOld}; nothing was pushed.`);
    return 1;
  }
  const { token, source } = resolveToken(env);
  if (token) {
    env.GITHUB_TOKEN = token;
    if (source !== "GITHUB_TOKEN") console.log(`pre-push: GITHUB_TOKEN unset; installing with ${source}`);
  } else {
    console.log(`pre-push: warning: GITHUB_TOKEN is unset and gh has no token; installs from the private registry will fail. ${TOKEN_HINT}`);
  }
  const gitDir = path.resolve(git("rev-parse", "--git-common-dir"));
  const verified = readVerified(gitDir);
  // A signal lands while spawnSync waits for a step; the step ends (Ctrl-C
  // reaches its process group too), the temporary worktree is removed, and the
  // hook then exits with the signal's code instead of verifying further commits.
  let stopped;
  const stop = signal => { stopped = signal; };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);

  for (const { sha, release } of commits) {
    const key = `${sha}${release ? " release" : ""}`;
    const label = `bun run verify${release ? " -- --release" : ""}`;
    if (verified.has(key)) {
      console.log(`pre-push: ${sha.slice(0, 10)} already passed ${label}`);
      continue;
    }
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-pre-push-"));
    console.log(`pre-push: ${label} on ${sha.slice(0, 10)} in ${worktree}`);
    console.log("pre-push: skip once with git push --no-verify");
    let passed = false;
    try {
      git("worktree", "add", "--detach", worktree, sha);
      const command = verifyCommand(worktree, release);
      if (!command) {
        console.log(`pre-push: ${sha.slice(0, 10)} has no verify script; nothing to run`);
        passed = true;
      } else {
        const run = (file, args) => !stopped && spawnSync(file, args, { cwd: worktree, stdio: "inherit", env }).status === 0 && !stopped;
        passed = run("bun", ["install", "--frozen-lockfile"]) && run(...command);
      }
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", worktree], { env, stdio: "ignore" });
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    if (stopped) {
      console.error(`\npre-push: ${stopped}; nothing was pushed.`);
      return 128 + os.constants.signals[stopped];
    }
    if (!passed) {
      console.error(`\npre-push: ${label} failed on ${sha.slice(0, 10)}; nothing was pushed.`);
      if (!token) console.error(`pre-push: if bun install failed with 401 or 404, ${TOKEN_HINT}`);
      return 1;
    }
    fs.appendFileSync(path.join(gitDir, VERIFIED_RECORD), `${key}\n`);
  }
  return 0;
}
