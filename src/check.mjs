// `repo-kit check`: the kit's own drift check, a verify step in every repository.
//   - the managed .githooks files are what `repo-kit hooks sync` writes;
//   - every maxvyshniakov/repo-kit workflow or action reference in
//     .github/workflows names v<installed repo-kit version>, so CI runs the kit
//     the lockfile pins;
//   - package.json "packageManager", when set, names the Bun the workflows run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hookIssues } from "./hooks.mjs";
import { BUN_VERSION } from "./token.mjs";

export const KIT_VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

const KIT_REFERENCE = /maxvyshniakov\/repo-kit\/([\w./-]+)@([\w.-]+)/g;

/** Every repo-kit reference in a workflow file's text: { target, ref, line }. */
export function kitReferences(text) {
  return text.split("\n").flatMap((line, index) => [...line.matchAll(KIT_REFERENCE)].map(match => ({ target: match[1], ref: match[2], line: index + 1 })));
}

export function workflowIssues(root, version = KIT_VERSION) {
  const dir = path.join(root, ".github/workflows");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).flatMap(file => {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    return kitReferences(text)
      .filter(({ ref }) => ref !== `v${version}`)
      .map(({ target, ref, line }) => `.github/workflows/${file}:${line}: ${target}@${ref}; the installed repo-kit is v${version}`);
  });
}

export function packageManagerIssues(root, bunVersion = BUN_VERSION) {
  const { packageManager } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!packageManager) return [];
  return packageManager === `bun@${bunVersion}` ? [] : [`package.json packageManager is ${packageManager}; the workflows run bun@${bunVersion}`];
}

export function kitIssues(root) {
  return [...hookIssues(root), ...workflowIssues(root), ...packageManagerIssues(root)];
}
