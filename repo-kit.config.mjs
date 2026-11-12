// repo-kit's own gate and release, run from its sources.
import fs from "node:fs";
import path from "node:path";

// The reusable workflows reference the composite action at the release tag,
// and the README shows callers the same tag: a release moves both to the new
// version (repo-kit check fails until they match).
const VERSIONED_FILES = [".github/workflows", "README.md", "docs/reference.md", "docs/templates"];

export default {
  prePush: { releaseBranches: [] },
  verify: {
    // Its steps take seconds; a hung one fails well inside check.yml's 15 minutes.
    stepTimeout: 5,
    steps: ({ release }) => [
      { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])] },
      { name: "kit check", command: ["run", "check"] },
      { name: "upstream hook", command: ["run", "check:upstream"] },
      { name: "tests", command: ["run", "test"] },
      { name: "packed consumer", command: ["run", "check:consumer"] },
    ],
  },
  packedConsumer: {
    // Plain JavaScript; there are no declarations to type-check.
    types: false,
    probes: [
      // The bin reached through node_modules/.bin, a symlink, must run.
      ({ consumerDir, run, ok, fail }) => {
        const result = run("node_modules/.bin/repo-kit", ["help"], { cwd: consumerDir });
        if (result.status === 0 && result.stdout.includes("Usage: repo-kit <command>")) ok("node_modules/.bin/repo-kit runs");
        else fail(`node_modules/.bin/repo-kit help exited ${result.status}:\n${result.stdout}${result.stderr}`);
        const lane = run("node_modules/.bin/repo-kit-lane", ["--help"], { cwd: consumerDir });
        if (lane.status === 0 && lane.stdout.includes("Usage: repo-kit-lane")) ok("node_modules/.bin/repo-kit-lane runs");
        else fail(`node_modules/.bin/repo-kit-lane --help exited ${lane.status}:\n${lane.stdout}${lane.stderr}`);
      },
    ],
  },
  release: {
    afterCut({ root, released: [{ previous, version }] }) {
      const files = VERSIONED_FILES.flatMap(entry => {
        const full = path.join(root, entry);
        return fs.statSync(full).isDirectory() ? fs.readdirSync(full).map(file => path.join(full, file)) : [full];
      });
      for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const moved = text.replaceAll(/(maxvyshniakov\/repo-kit\/[\w./-]+@)v\d+\.\d+\.\d+/g, `$1v${version}`)
          .replaceAll(`"@maxvyshniakov/repo-kit": "${previous}"`, `"@maxvyshniakov/repo-kit": "${version}"`);
        if (moved !== text) fs.writeFileSync(file, moved);
      }
    },
  },
};
