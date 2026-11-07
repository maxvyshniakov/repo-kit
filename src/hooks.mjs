// The repository's tracked Git hooks (.githooks) and their activation.
//
//   repo-kit hooks install   point core.hooksPath at .githooks (the `prepare` script, on bun install)
//   repo-kit hooks sync      write the managed hooks into .githooks
//   repo-kit hooks check     fail when a managed hook differs from what sync writes (a verify step)
//   repo-kit hooks status    fail when Git would not run every tracked hook (local diagnosis)
//
// Managed hooks: pre-push, a shim into repo-kit's pre-push command, and
// reference-transaction, a verbatim copy of Lanefather's hooks/reference-transaction
// (one writer for main and dev), pinned by REFERENCE_TRANSACTION_SHA256.
// Other files in .githooks belong to the repository.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUN_VERSION } from "./token.mjs";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

export const REFERENCE_TRANSACTION_SHA256 = "8fbd90c9562f94c4f45eb841351bc657b217160e511508367b0c8fbed29203f9";

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

// This tracked entry also works in Lanefather's dependency-free smoke checkouts.
// The installed kit is used only to lease a frozen install; verification then
// runs from the target checkout's own locked package.
export function laneCheckShim() {
  return `#!/bin/sh
# Managed by @maxvyshniakov/repo-kit (repo-kit hooks sync); do not edit.
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
cli="$root/node_modules/@maxvyshniakov/repo-kit/src/cli.mjs"
if [ ! -f "$cli" ]; then
  common=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
  cli="$common/node_modules/@maxvyshniakov/repo-kit/src/cli.mjs"
fi
if [ ! -f "$cli" ]; then
  echo "repo-kit lane: install dependencies in the main checkout with bun install first" >&2
  exit 1
fi
version=$(bun --version)
node -e 'const v=process.argv[1].split(/[.-]/).slice(0,3).map(Number), floor=${JSON.stringify(BUN_VERSION.split('.').map(Number))}; let c=0; for(let i=0;i<3;i++){if(v[i]!==floor[i]){c=v[i]-floor[i];break}} process.exit(Number.isNaN(c)||c<0?1:0)' "$version" || {
  echo "repo-kit lane: Bun ${BUN_VERSION} or newer is required before installing" >&2
  exit 1
}
if [ -z "\${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null) || GITHUB_TOKEN=""
  export GITHUB_TOKEN
fi
node "$cli" heavy 1 bun install --frozen-lockfile >&2
exec node "$root/node_modules/@maxvyshniakov/repo-kit/src/lanefather.mjs" "$@"
`;
}

/** { name: contents } of every managed hook. */
export function managedHooks({ self = false, lane = false } = {}) {
  return {
    "pre-push": prePushShim({ self }),
    ...(lane ? { "lane-check": laneCheckShim() } : {}),
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
  for (const [name, contents] of Object.entries(managedHooks({ self: isSelf(root), lane: fs.existsSync(path.join(root, ".lanefather.toml")) }))) {
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
  for (const [name, contents] of Object.entries(managedHooks({ self: isSelf(root), lane: fs.existsSync(path.join(root, ".lanefather.toml")) }))) {
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
