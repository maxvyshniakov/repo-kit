// The repository's package-kit.config.mjs and the facts every command shares:
// where the repository root is and which package it publishes.
//
//   export default {
//     verify: { steps: ({ release }) => [...], browser: () => [...], slots: 1, browserSlots: 2, workerMemory: 0.9, stepTimeout: 15 },
//     prePush: { slots: 3 },
//     publish: { checks: "check.yml", notify: [{ repository, workflow, ref }], registry: "github", access: "public" },
//     changelog: { quickStart: "docs/GETTING_STARTED.md", peerScope: "@maxvyshniakov/", paths: ["packages/sid-kit/src/**"] },
//     hooks: { managed: ["commit-msg"] },
//     release: { gate: "local", afterCut({ root, packages }) {} },
//     packedConsumer: { ... },
//     shoot: { url: "http://127.0.0.1:6010", storybookDir: "apps/storybook", slots: 1 },
//   };
//
// loadConfig rejects a key it does not know (CONFIG_KEYS, STEP_KEYS), so a typo
// or a key from another package-kit version fails instead of being ignored.
import fs from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export { releasedPackages } from "./packages.mjs";

export const CONFIG_FILE = "package-kit.config.mjs";

/** The file name before the rename to package-kit; a repository that still has it fails with LEGACY_CONFIG_MESSAGE. */
export const LEGACY_CONFIG_FILE = "repo-kit.config.mjs";
export const LEGACY_CONFIG_MESSAGE = `@maxvyshniakov/repo-kit is now @maxvyshniakov/package-kit: rename ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}, and change its imports of "@maxvyshniakov/repo-kit" to "@maxvyshniakov/package-kit" (CHANGELOG.md)`;

/** Thrown where only the pre-rename config exists; callers that fall back to the defaults without a config rethrow it. */
export class LegacyConfigError extends Error {
  constructor(dir) {
    super(`${path.join(dir, LEGACY_CONFIG_FILE)}: ${LEGACY_CONFIG_MESSAGE}`);
    this.name = "LegacyConfigError";
  }
}

/**
 * A warning for each REPO_KIT_* variable in `env`: package-kit reads PACKAGE_KIT_* instead, so
 * a pre-rename name (a .lanefather.toml slot_env = "REPO_KIT_SLOT", say) would otherwise be ignored silently.
 */
export function legacyEnvironmentWarnings(env = process.env) {
  return Object.keys(env).filter(name => name.startsWith("REPO_KIT_")).sort().map(name => {
    const renamed = name.replace(/^REPO_KIT_/, "PACKAGE_KIT_");
    const lane = name.startsWith("REPO_KIT_SLOT_") ? '; in .lanefather.toml set slot_env = "PACKAGE_KIT_SLOT"' : "";
    return `package-kit: ${name} is ignored since the rename from repo-kit; set ${renamed}${lane}`;
  });
}

function assertNotLegacy(dir) {
  if (!fs.existsSync(path.join(dir, CONFIG_FILE)) && fs.existsSync(path.join(dir, LEGACY_CONFIG_FILE))) throw new LegacyConfigError(dir);
}

// Every key package-kit reads, by section. test/config.test.mjs checks that src/
// reads no other and that each is read somewhere.
export const CONFIG_KEYS = {
  verify: ["steps", "browser", "slots", "browserSlots", "workerMemory", "stepTimeout", "inert", "runner", "canary", "smoke"],
  prePush: ["slots", "releaseBranches"],
  publish: ["checks", "notify", "registry", "access"],
  changelog: ["quickStart", "peerScope", "paths"],
  release: ["gate", "afterCut"],
  hooks: ["managed"],
  packedConsumer: ["versionSources", "dependencies", "devDependencies", "types", "probes"],
  shoot: ["url", "storybookDir", "slots"],
  fileBudget: [
    "rules", "exclude", "unit", "lines", "bytes", "max", "limit", "glob", "globs", "include",
    "allowlist", "baseline", "exemptions", "excludeLockfiles", "excludeChangelogs", "excludeBinary",
  ],
  testHygiene: [
    "baseline", "extraBaseline", "tests", "exclude", "perfSuite",
    "browserChecks", "browserExclude", "mockAdapters", "rules", "ui",
  ],
};

/** The keys of each publish.notify target. */
export const NOTIFY_KEYS = ["repository", "workflow", "ref"];

/** The registries publish.registry names: one, or a list published in order. */
export const PUBLISH_REGISTRIES = ["github", "npm"];

/** publish.access: npm's --access for the npmjs.org publication. */
export const PUBLISH_ACCESS = ["public", "restricted"];

/** The keys of a verify step (verify.steps and verify.browser), checked by normalizeSteps. */
export const STEP_KEYS = ["name", "command", "needs", "after", "always", "cheap", "smoke", "memory", "usesCores", "workers", "timeout", "slots", "inputs", "scopeArgs"];

/** Keys earlier releases read, with what to do now. */
export const REMOVED_KEYS = {
  adopt: "package-kit adopt was removed in 0.10.0; delete the adopt section",
  rust: "package-kit rust was removed in 0.10.0; delete the rust section",
  "changelog.versionSource": "pyproject.toml version sources were removed in 0.10.0; package-kit releases package.json packages only, so delete changelog.versionSource",
};

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** The candidate closest to `key`, when it is close enough to be a typo. */
export function closestKey(key, candidates) {
  let best;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : undefined;
}

/** The message for an unknown key at `path` (e.g. "verify.cheapp"), with a suggestion and the known keys. */
export function unknownKeyMessage(path, known, { also = {} } = {}) {
  if (Object.hasOwn(REMOVED_KEYS, path)) return `${path}: ${REMOVED_KEYS[path]}`;
  const key = path.slice(path.lastIndexOf(".") + 1);
  const near = closestKey(key, known);
  // A key that belongs one level down, as a step key set on verify itself.
  const elsewhere = Object.entries(also).map(([where, keys]) => [where, closestKey(key, keys)]).find(([, match]) => match);
  let hint = "";
  if (near) hint = `; did you mean ${path.slice(0, path.length - key.length)}${near}?`;
  else if (elsewhere) hint = `; did you mean ${elsewhere[1]}? It is a key of ${elsewhere[0]}`;
  return `unknown key ${path}${hint} (known: ${known.join(", ")})`;
}

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Each problem with a raw config's keys: unknown or removed keys and sections that are not objects. */
export function configIssues(raw) {
  if (!isPlainObject(raw)) return [`${CONFIG_FILE} must export an object, got ${raw === null ? "null" : typeof raw}`];
  const sections = Object.keys(CONFIG_KEYS);
  const issues = [];
  for (const [section, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CONFIG_KEYS, section)) {
      issues.push(unknownKeyMessage(section, sections));
      continue;
    }
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      issues.push(`${section} must be an object, got ${Array.isArray(value) ? "an array" : typeof value}`);
      continue;
    }
    const known = CONFIG_KEYS[section];
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        issues.push(unknownKeyMessage(`${section}.${key}`, known, section === "verify" ? { also: { "each verify step": STEP_KEYS } } : {}));
      }
    }
  }
  const notify = raw.publish?.notify;
  if (notify !== undefined) {
    if (!Array.isArray(notify)) issues.push("publish.notify must be an array of { repository, workflow, ref }");
    else {
      notify.forEach((target, index) => {
        if (!isPlainObject(target)) return issues.push(`publish.notify[${index}] must be an object { repository, workflow, ref }`);
        for (const key of Object.keys(target)) {
          if (!NOTIFY_KEYS.includes(key)) issues.push(unknownKeyMessage(`publish.notify[${index}].${key}`, NOTIFY_KEYS));
        }
      });
    }
  }
  issues.push(...publishValueIssues(raw.publish));
  return issues;
}

function publishValueIssues(publish) {
  if (!isPlainObject(publish)) return [];
  const issues = [];
  const { registry, access } = publish;
  if (registry !== undefined) {
    const list = Array.isArray(registry) ? registry : [registry];
    const unknown = list.filter(name => !PUBLISH_REGISTRIES.includes(name));
    if (!list.length || unknown.length || new Set(list).size !== list.length) {
      issues.push(`publish.registry must be "github", "npm" or a list of both without repeats, got ${JSON.stringify(registry)}`);
    }
  }
  if (access !== undefined && !PUBLISH_ACCESS.includes(access)) {
    issues.push(`publish.access must be "public" or "restricted", got ${JSON.stringify(access)}`);
  }
  return issues;
}

/** Throws one error naming every problem configIssues finds; returns `raw`. */
export function validateConfig(raw) {
  const issues = configIssues(raw);
  if (issues.length) throw new Error(`${CONFIG_FILE}:\n  ${issues.join("\n  ")}`);
  return raw;
}

/** The nearest directory at or above `start` that holds package-kit.config.mjs. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    assertNotLegacy(dir);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No ${CONFIG_FILE} at or above ${start}`);
    dir = parent;
  }
}

// package-kit.config.mjs may import "@maxvyshniakov/package-kit". The pre-push shim
// can run this copy from the main checkout for a linked worktree that has no
// node_modules, where Node would not find the package from the config's
// directory; resolve the package to this copy, as a self-reference.
const kitPackage = new URL("../package.json", import.meta.url).href;
let resolvingSelf = false;
function resolveSelf() {
  if (resolvingSelf || !nodeModule.registerHooks) return;
  resolvingSelf = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@maxvyshniakov/package-kit" || specifier.startsWith("@maxvyshniakov/package-kit/")) {
        return nextResolve(specifier, { ...context, parentURL: kitPackage });
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function loadConfig(root = findRoot()) {
  assertNotLegacy(root);
  resolveSelf();
  const module = await import(pathToFileURL(path.join(root, CONFIG_FILE)).href);
  return { root, ...withDefaults(validateConfig(module.default ?? {})) };
}

export function withDefaults(config) {
  return {
    ...config,
    verify: { slots: 1, browserSlots: 2, workerMemory: 0.9, stepTimeout: 15, ...config.verify },
    prePush: { slots: 1, ...config.prePush },
    // registry: "github" (GitHub Packages, the default), "npm" (npmjs.org) or both, in publish order.
    // access: npm's --access on npmjs.org; "public" unless set.
    publish: { checks: "check.yml", notify: [], registry: "github", access: "public", ...config.publish },
    changelog: { quickStart: "docs/GETTING_STARTED.md", peerScope: "@maxvyshniakov/", ...config.changelog },
    // gate: "local" (package-kit release-gate's attestation) or "ci" (the checks workflow); README.md#release-gate.
    release: { gate: "local", ...config.release },
    // managed: the managed hooks `hooks sync` writes and `hooks check` expects; default every one that applies.
    hooks: { ...config.hooks },
    packedConsumer: { ...config.packedConsumer },
    // package-kit shoot: the Storybook it reads by default, the Storybook app whose
    // story files a failed index names, and the slots it leases.
    shoot: { url: "http://127.0.0.1:6010", storybookDir: "apps/storybook", slots: 1, ...config.shoot },
    // package-kit check file-budget / package-kit file-budget: per-glob line or byte budgets and a shrink-only allowlist.
    fileBudget: { ...config.fileBudget },
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
