// The repository's repo-kit.config.mjs and the facts every command shares:
// where the repository root is and which package it publishes.
//
//   export default {
//     verify: { steps: ({ release }) => [...], browser: () => [...], slots: 1, browserSlots: 2, workerMemory: 0.9 },
//     prePush: { slots: 3 },
//     publish: { checks: "check.yml", notify: [{ repository, workflow, ref }] },
//     changelog: { quickStart: "docs/GETTING_STARTED.md", peerScope: "@maxvyshniakov/" },
//     release: { afterCut({ root, packages }) {} },
//     packedConsumer: { ... },
//   };
import fs from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILE = "repo-kit.config.mjs";

/** The nearest directory at or above `start` that holds repo-kit.config.mjs. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No ${CONFIG_FILE} at or above ${start}`);
    dir = parent;
  }
}

// repo-kit.config.mjs may import "@maxvyshniakov/repo-kit". The pre-push shim
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
      if (specifier === "@maxvyshniakov/repo-kit" || specifier.startsWith("@maxvyshniakov/repo-kit/")) {
        return nextResolve(specifier, { ...context, parentURL: kitPackage });
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function loadConfig(root = findRoot()) {
  resolveSelf();
  const module = await import(pathToFileURL(path.join(root, CONFIG_FILE)).href);
  return { root, ...withDefaults(module.default ?? {}) };
}

export function withDefaults(config) {
  return {
    ...config,
    verify: { slots: 1, browserSlots: 2, workerMemory: 0.9, ...config.verify },
    prePush: { slots: 1, ...config.prePush },
    publish: { checks: "check.yml", notify: [], ...config.publish },
    changelog: { quickStart: "docs/GETTING_STARTED.md", peerScope: "@maxvyshniakov/", ...config.changelog },
    release: { ...config.release },
    packedConsumer: { ...config.packedConsumer },
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The packages this repository releases: each directory under packages/ with
 * a package.json (a workspace), or else the root package. `path` is relative
 * to the root ("." for the root package).
 */
export function releasedPackages(root) {
  const packagesDir = path.join(root, "packages");
  const workspace = fs.existsSync(packagesDir)
    ? fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, "package.json")))
      .map(entry => `packages/${entry.name}`)
    : [];
  return (workspace.length ? workspace : ["."]).map(relative => {
    const dir = path.join(root, relative);
    const manifest = readJson(path.join(dir, "package.json"));
    return { path: relative, dir, manifest, name: manifest.name, version: manifest.version, workspace: relative !== "." };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
