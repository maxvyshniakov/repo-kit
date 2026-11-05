// The repository's tracked Git hooks (.githooks) and their activation.
//
//   repo-kit hooks install   point core.hooksPath at .githooks (the `prepare` script, on bun install)
//   repo-kit hooks sync      write the managed hooks into .githooks
//   repo-kit hooks check     fail when a managed hook differs from what sync writes (a verify step)
//   repo-kit hooks status    fail when Git would not run every tracked hook (local diagnosis)
//
// Managed hooks: pre-push, a shim into repo-kit's pre-push command, and
// reference-transaction, a verbatim copy of Straylight's
// tools/agent-hooks/reference-transaction (one writer for main and dev). Its
// canonical home moves to lanefather; until then the copy is pinned by
// REFERENCE_TRANSACTION_SHA256. Other files in .githooks belong to the repository.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

export const REFERENCE_TRANSACTION_SHA256 = "650f3ed7c03e32630375d66a894dcca2e3fb3b3bd61e92345cea9116cbead5b0";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The pre-push shim finds repo-kit in this checkout's node_modules, or in the
// main checkout's when a linked worktree has none installed. In repo-kit's own
// repository it runs the sources.
export function prePushShim({ self = false } = {}) {
  const locate = self
    ? 'cli="$root/src/cli.mjs"'
    : `cli="$root/node_modules/@maxvyshniakov/repo-kit/src/cli.mjs"
if [ ! -f "$cli" ]; then
  common=$(cd "$root" && cd "$(git rev-parse --git-common-dir)/.." && pwd)
  cli="$common/node_modules/@maxvyshniakov/repo-kit/src/cli.mjs"
fi`;
  return `#!/bin/sh
# Managed by @maxvyshniakov/repo-kit (repo-kit hooks sync); do not edit.
# Runs \`bun run verify\` on the commits being pushed; skip once with git push --no-verify.
root=$(git rev-parse --show-toplevel)
${locate}
if [ ! -f "$cli" ]; then
  echo "pre-push: repo-kit is not installed; run bun install. Nothing was pushed." >&2
  exit 1
fi
exec node "$cli" pre-push "$@"
`;
}

/** { name: contents } of every managed hook. */
export function managedHooks({ self = false } = {}) {
  return {
    "pre-push": prePushShim({ self }),
    ...(!self ? { "reference-transaction": fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"), "utf8") } : {}),
  };
}

function isSelf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name === "@maxvyshniakov/repo-kit";
}

export function syncHooks(root) {
  const dir = path.join(root, ".githooks");
  fs.mkdirSync(dir, { recursive: true });
  const retired = path.join(dir, "reference-transaction");
  if (isSelf(root) && fs.existsSync(retired)) {
    const canonical = fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"), "utf8");
    if (fs.readFileSync(retired, "utf8") !== canonical) throw new Error("Preserve the customized reference-transaction hook before syncing repo-kit's own hooks");
    fs.unlinkSync(retired);
  }
  for (const [name, contents] of Object.entries(managedHooks({ self: isSelf(root) }))) {
    fs.writeFileSync(path.join(dir, name), contents, { mode: 0o755 });
    fs.chmodSync(path.join(dir, name), 0o755);
    console.log(`Git hooks: wrote .githooks/${name}`);
  }
}

/** Problems with the tracked managed hooks, as messages. */
export function hookIssues(root) {
  const issues = [];
  const copy = fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"));
  if (sha256(copy) !== REFERENCE_TRANSACTION_SHA256) {
    issues.push("repo-kit's hooks/reference-transaction does not match REFERENCE_TRANSACTION_SHA256");
  }
  for (const [name, contents] of Object.entries(managedHooks({ self: isSelf(root) }))) {
    const file = path.join(root, ".githooks", name);
    if (!fs.existsSync(file)) issues.push(`.githooks/${name} is missing; run repo-kit hooks sync`);
    else if (fs.readFileSync(file, "utf8") !== contents) issues.push(`.githooks/${name} differs from repo-kit's; run repo-kit hooks sync`);
    else if (!(fs.statSync(file).mode & 0o111)) issues.push(`.githooks/${name} is not executable`);
  }
  return issues;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function insideCheckout(root) {
  try {
    return git(root, "rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false; // Not a Git checkout (for example an extracted archive).
  }
}

function hooksPath(root) {
  try {
    return git(root, "config", "--get", "core.hooksPath");
  } catch {
    return "";
  }
}

// Leaves a hooksPath that someone set deliberately to something else, and does
// nothing outside a Git checkout or in CI.
export function installHooks(root, env = process.env) {
  if (env.CI || !insideCheckout(root)) return;
  const current = hooksPath(root);
  if (!current) {
    git(root, "config", "--local", "core.hooksPath", ".githooks");
    console.log("Git hooks: core.hooksPath set to .githooks (pre-push runs bun run verify).");
  } else if (current !== ".githooks") {
    console.warn(`Git hooks: core.hooksPath is ${current}; not replacing it. The pre-push gate lives in .githooks.`);
  }
}

/** Tracked hooks Git would not run as tracked, as messages; [] when all are active. */
export function hookStatus(root) {
  if (!insideCheckout(root)) return ["not a Git checkout"];
  const dir = path.join(root, ".githooks");
  const issues = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const active = path.resolve(root, git(root, "rev-parse", "--git-path", `hooks/${name}`));
    let ok = false;
    try {
      fs.accessSync(active, fs.constants.X_OK);
      ok = fs.readFileSync(active).equals(fs.readFileSync(path.join(dir, name)));
    } catch {
      // missing or not executable
    }
    if (!ok) issues.push(`${name}: ${active} is not the tracked .githooks/${name}`);
  }
  return issues;
}
