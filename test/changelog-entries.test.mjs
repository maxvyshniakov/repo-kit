import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  amending,
  changelogTrailers,
  compileRules,
  cutsRelease,
  globToRegExp,
  optsOut,
  rangeIssues,
  runCheckChangelogEntries,
  shippedFiles,
  unreleasedChanged,
} from "../src/changelog-entries.mjs";
import { withDefaults } from "../src/config.mjs";
import { hookIssues, managedHooks, syncHooks } from "../src/hooks.mjs";
import { runRelease } from "../src/release.mjs";
import { changelog, isolatedGitEnv, kitRoot, pyprojectFiles, rootPackageFiles, tempRepository, workspaceFiles } from "./fixtures.mjs";

const quiet = fn => {
  const { log, error } = console;
  const lines = [];
  console.log = console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), output: lines.join("\n") };
  } finally {
    Object.assign(console, { log, error });
  }
};

const PATHS = ["src/**", "package.json", "!src/**/*.test.mjs"];
const configText = (paths = PATHS, extra = "") => `export default { changelog: { paths: ${JSON.stringify(paths)} }${extra} };\n`;
const entry = text => fs.readFileSync(text, "utf8").replace("## Unreleased\n", "## Unreleased\n\n### Added\n\n- A new export.\n");

/** A root-package repository with the guard configured, one commit in; `commit` writes files and commits them. */
function guarded(files = rootPackageFiles({ "repo-kit.config.mjs": configText(), "src/index.mjs": "export {};\n" }), paths = PATHS) {
  const repository = tempRepository(files, { git: true });
  const config = withDefaults({ changelog: { paths } });
  config.root = repository.root;
  const commit = (changes, message) => {
    for (const [relative, contents] of Object.entries(changes)) {
      const file = path.join(repository.root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof contents === "function" ? contents(file) : contents);
    }
    repository.git("add", "-A");
    repository.git("commit", "--quiet", "-m", message);
    return repository.git("rev-parse", "HEAD");
  };
  const check = (base = "HEAD~1") => quiet(() => runCheckChangelogEntries(config, [`${base}..HEAD`]));
  return { ...repository, config, commit, check };
}

test("globs: * stays in a segment, ** spans them, {a,b}, a trailing slash, and ! excludes", () => {
  assert.equal(globToRegExp("packages/sid-kit/src/**").test("packages/sid-kit/src/a/b.tsx"), true);
  assert.equal(globToRegExp("packages/sid-kit/src/**").test("packages/sid-kit/srcset.ts"), false);
  assert.equal(globToRegExp("src/**/*.css").test("src/a.css"), true);
  assert.equal(globToRegExp("src/**/*.css").test("src/a/b/c.css"), true);
  assert.equal(globToRegExp("*.py").test("lib/a.py"), false);
  assert.equal(globToRegExp("{lanefather,hooks}/**").test("hooks/reference-transaction"), true);
  assert.equal(globToRegExp("./lanefather/").test("lanefather/cli.py"), true);
  const [rule] = compileRules(PATHS, [{ path: ".", name: "x", manifestFile: "package.json" }]);
  assert.deepEqual(shippedFiles(["src/a.mjs", "src/a.test.mjs", "test/b.mjs", "package.json"], rule), ["src/a.mjs", "package.json"]);
});

test("paths belong to the only package, to the package they lie in, or to the package they are keyed by", () => {
  const sidKit = { path: "packages/sid-kit", name: "@maxvyshniakov/sid-kit", manifestFile: "package.json" };
  const grid = { path: "packages/data-grid", name: "@maxvyshniakov/data-grid", manifestFile: "package.json" };
  const rules = compileRules(["packages/sid-kit/src/**", "packages/data-grid/src/**", "!packages/data-grid/src/**/*.test.ts"], [grid, sidKit]);
  assert.deepEqual(rules.map(rule => [rule.pkg.name, rule.changelog, rule.manifest]), [
    ["@maxvyshniakov/sid-kit", "packages/sid-kit/CHANGELOG.md", "packages/sid-kit/package.json"],
    ["@maxvyshniakov/data-grid", "packages/data-grid/CHANGELOG.md", "packages/data-grid/package.json"],
  ]);
  assert.throws(() => compileRules(["src/**"], [grid, sidKit]), /lies in none of packages\/data-grid, packages\/sid-kit; key the globs/);
  const keyed = compileRules({ "sid-kit": ["shared/tokens/**"], "packages/data-grid": ["packages/data-grid/src/**"] }, [grid, sidKit]);
  assert.deepEqual(keyed.map(rule => rule.pkg.name), ["@maxvyshniakov/sid-kit", "@maxvyshniakov/data-grid"]);
  assert.throws(() => compileRules({ missing: ["x/**"] }, [grid, sidKit]), /missing is not a released package/);
  assert.throws(() => compileRules("src/**", [sidKit]), /expected an array of globs/);
  assert.deepEqual(compileRules(undefined, [sidKit]), []);
});

test("an Unreleased line counts when it is new, changed or removed, not when it moved, is blank or is a heading", () => {
  const withEntry = changelog.replace("- Fixed a thing.", "- Fixed a thing.\n- Fixed another.");
  assert.equal(unreleasedChanged(changelog, withEntry), true);
  assert.equal(unreleasedChanged(changelog, changelog.replace("- Fixed a thing.", "- Fixed a thing, properly.")), true);
  assert.equal(unreleasedChanged(undefined, changelog), true);
  assert.equal(unreleasedChanged(changelog, changelog.replace("### Fixed\n", "### Fixed\n\n### Added\n")), false);
  assert.equal(unreleasedChanged(changelog, changelog.replace("- First release.", "- First release, reworded.")), false, "an old release's line");
  assert.equal(unreleasedChanged(withEntry, changelog), true, "a removed line: a revert takes its entry back out");
  assert.equal(unreleasedChanged(changelog, undefined), false);
});

test("a release cut is a newer newest release that the manifest's version names", () => {
  const cut = changelog.replace("## Unreleased\n\n### Fixed\n\n- Fixed a thing.\n\n", "## Unreleased\n\n## 0.2.1 - 2026-11-11\n\n### Fixed\n\n- Fixed a thing.\n\n");
  assert.equal(cutsRelease(changelog, cut, "0.2.1"), true);
  assert.equal(cutsRelease(changelog, cut, "0.2.0"), false, "the manifest was not moved");
  assert.equal(cutsRelease(changelog, changelog, "0.2.0"), false);
  assert.equal(cutsRelease(undefined, changelog, "0.2.0"), true, "the first release");
});

test("Changelog trailers are read as git parses trailers, with an optional reason", () => {
  const message = "Fix a test\n\nBody.\n\nChangelog: none (tests only)\nCo-Authored-By: A <a@example.invalid>\n# a comment git strips\n";
  assert.deepEqual(changelogTrailers(message), ["none (tests only)"]);
  assert.deepEqual(changelogTrailers("Changelog: none\n"), [], "a subject is not a trailer");
  assert.deepEqual(changelogTrailers("Subject\n\nchangelog:none\n"), ["none"]);
  for (const value of ["none", "none (tests only)", "None - refactor", "none: internal"]) assert.equal(optsOut(value), true, value);
  for (const value of ["nonessential", "yes", ""]) assert.equal(optsOut(value), false, value);
});

test("a shipped change without an entry fails; with an entry or the trailer it passes; elsewhere it passes", () => {
  const repo = guarded();
  try {
    repo.commit({ "src/index.mjs": "export const a = 1;\n" }, "Add a");
    const failed = repo.check();
    assert.equal(failed.result, 1);
    assert.match(failed.output, /FAIL [0-9a-f]{10} Add a\n {2}src\/index.mjs changed @maxvyshniakov\/example without a line under "## Unreleased" in CHANGELOG.md/);
    assert.match(failed.output, /1 of 1 commit checked, 0 merges exempt/);

    repo.commit({ "src/index.mjs": "export const b = 2;\n", "CHANGELOG.md": entry }, "Add b");
    assert.equal(repo.check().result, 0);

    repo.commit({ "src/index.mjs": "export const c = 3;\n" }, "Rename c\n\nChangelog: none (internal rename)\nCo-Authored-By: A <a@example.invalid>");
    assert.equal(repo.check().result, 0);

    repo.commit({ "src/index.mjs": "export const d = 4;\n" }, "Add d\n\nChangelog: maybe");
    assert.match(repo.check().output, /the trailer "Changelog: maybe" is not "Changelog: none"/);

    repo.commit({ "README.md": "# Example\n", "src/index.test.mjs": "// a test\n" }, "Document it");
    assert.equal(repo.check().result, 0);

    // The whole range: "Add a" and "Add d" fail.
    const range = rangeIssues(repo.root, ["HEAD~5..HEAD"], compileRules(PATHS, [{ path: ".", name: "@maxvyshniakov/example", manifestFile: "package.json" }]));
    assert.deepEqual(range.failures.map(failure => failure.subject), ["Add a", "Add d"]);
    assert.equal(range.checked, 5);
  } finally {
    repo.cleanup();
  }
});

test("merge commits and release commits are exempt; a bare version bump is not", async () => {
  const repo = guarded();
  try {
    const base = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "--quiet", "-b", "topic");
    repo.commit({ "src/index.mjs": "export const topic = 1;\n" }, "Topic\n\nChangelog: none (fixture)");
    repo.git("checkout", "--quiet", "dev");
    repo.commit({ "README.md": "# Example\n" }, "Readme");
    repo.git("merge", "--quiet", "--no-ff", "-m", "Merge topic", "topic");
    const merged = repo.check(base);
    assert.equal(merged.result, 0, merged.output);
    assert.match(merged.output, /2 commits checked, 1 merge exempt/);

    // `repo-kit release` moves Unreleased under 0.3.0 and sets package.json (a shipped path).
    await quiet(() => runRelease(repo.config, ["minor", "--date=2026-11-11"])).result;
    repo.commit({}, "Release 0.3.0");
    assert.equal(repo.check().result, 0, repo.check().output);

    repo.commit({ "package.json": text => fs.readFileSync(text, "utf8").replace('"0.3.0"', '"0.3.1"') }, "Bump without a release");
    assert.equal(repo.check().result, 1);
  } finally {
    repo.cleanup();
  }
});

test("the guard applies to a workspace package's and a Python package's CHANGELOG.md", () => {
  const workspace = guarded(workspaceFiles({
    "repo-kit.config.mjs": configText(["packages/example/src/**"]),
    "packages/example/src/index.mjs": "export {};\n",
  }), ["packages/example/src/**"]);
  const python = guarded(pyprojectFiles({ "repo-kit.config.mjs": configText(["example/**", "pyproject.toml"]), "example/__init__.py": "" }), ["example/**", "pyproject.toml"]);
  try {
    workspace.commit({ "packages/example/src/index.mjs": "export const a = 1;\n", "CHANGELOG.md": "# Not the package's\n" }, "Wrong changelog");
    assert.match(workspace.check().output, /without a line under "## Unreleased" in packages\/example\/CHANGELOG.md/);
    workspace.commit({ "packages/example/src/index.mjs": "export const b = 1;\n", "packages/example/CHANGELOG.md": entry }, "Right changelog");
    assert.equal(workspace.check().result, 0);

    python.commit({ "example/__init__.py": "VALUE = 1\n" }, "Value");
    assert.match(python.check().output, /example\/__init__.py changed example without a line/);
    // A release cut that moves pyproject.toml's version is exempt.
    python.commit({
      "CHANGELOG.md": text => fs.readFileSync(text, "utf8").replace("## Unreleased\n", "## Unreleased\n\n## 0.3.0 - 2026-11-11\n"),
      "pyproject.toml": text => fs.readFileSync(text, "utf8").replace('version = "0.2.0"', 'version = "0.3.0"'),
    }, "Release 0.3.0");
    assert.equal(python.check().result, 0, python.check().output);
  } finally {
    workspace.cleanup();
    python.cleanup();
  }
});

test("without changelog.paths the check is off, and a range outside the checkout fails", () => {
  const repository = tempRepository(rootPackageFiles({ "src/index.mjs": "export {};\n" }), { git: true });
  const repo = guarded();
  try {
    const config = withDefaults({});
    config.root = repository.root;
    assert.match(quiet(() => runCheckChangelogEntries(config, ["HEAD~1..HEAD"])).output, /changelog.paths is not configured; nothing to check/);
    assert.equal(quiet(() => runCheckChangelogEntries(repo.config, [])).result, 2);
    assert.throws(() => runCheckChangelogEntries(repo.config, ["origin/main..HEAD"]), /is not a range of this checkout .*fetch-depth: 0/);
  } finally {
    repository.cleanup();
    repo.cleanup();
  }
});

test("hooks sync writes commit-msg with changelog.paths, hooks.managed narrows the set, and a repository's own commit-msg stays", () => {
  assert.equal(managedHooks()["commit-msg"], undefined);
  assert.match(managedHooks({ commitMsg: true })["commit-msg"], /exec node "\$cli" commit-msg "\$@"/);
  assert.match(managedHooks({ commitMsg: true })["commit-msg"], /command -v repo-kit/);
  assert.deepEqual(Object.keys(managedHooks({ commitMsg: true, only: ["commit-msg"] })), ["commit-msg"]);
  assert.throws(() => managedHooks({ only: ["pre-commit"] }), /hooks.managed: expected a list of/);

  const python = tempRepository(pyprojectFiles());
  try {
    const config = withDefaults({ changelog: { paths: ["example/**"] }, hooks: { managed: ["commit-msg"] } });
    assert.match(hookIssues(python.root, config).join("\n"), /\.githooks\/commit-msg is missing/);
    quiet(() => syncHooks(python.root, config));
    assert.deepEqual(fs.readdirSync(path.join(python.root, ".githooks")), ["commit-msg"]);
    assert.deepEqual(hookIssues(python.root, config), []);
    fs.writeFileSync(path.join(python.root, ".githooks/commit-msg"), "#!/bin/sh\nexit 0\n");
    assert.throws(() => syncHooks(python.root, config), /commit-msg is the repository's own/);
  } finally {
    python.cleanup();
  }
});

test("the commit-msg hook checks the commit being made, including -a, amends and merges", () => {
  // Only commit-msg: the managed reference-transaction would refuse commits on dev.
  const repo = guarded(rootPackageFiles({ "repo-kit.config.mjs": configText(PATHS, ', hooks: { managed: ["commit-msg"] }'), "src/index.mjs": "export {};\n" }));
  try {
    quiet(() => syncHooks(repo.root, { ...repo.config, hooks: { managed: ["commit-msg"] } }));
    fs.mkdirSync(path.join(repo.root, "node_modules/@maxvyshniakov"), { recursive: true });
    fs.symlinkSync(kitRoot, path.join(repo.root, "node_modules/@maxvyshniakov/repo-kit"));
    fs.writeFileSync(path.join(repo.root, ".gitignore"), "node_modules/\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "--no-verify", "-m", "Hooks");
    repo.git("config", "core.hooksPath", ".githooks");
    const write = (relative, contents) => fs.writeFileSync(path.join(repo.root, relative), contents);
    const commit = (...args) => spawnSync("git", ["commit", "--quiet", ...args], { cwd: repo.root, env: repo.env, encoding: "utf8" });

    write("src/index.mjs", "export const a = 1;\n");
    const refused = commit("-a", "-m", "Add a");
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /commit-msg: changelog entry missing:\n {2}src\/index.mjs changed @maxvyshniakov\/example/);
    assert.match(refused.stderr, /Nothing was committed; skip once with git commit --no-verify/);

    const optedOut = commit("-a", "-m", "Add a", "-m", "Changelog: none (fixture)");
    assert.equal(optedOut.status, 0, optedOut.stderr);
    write("src/index.mjs", "export const b = 2;\n");
    write("CHANGELOG.md", entry(path.join(repo.root, "CHANGELOG.md")));
    assert.equal(commit("-a", "-m", "Add b").status, 0);

    // Amending "Add b" with another source change: its entry still counts.
    write("src/index.mjs", "export const b = 3;\n");
    const amended = commit("-a", "--amend", "--no-edit");
    assert.equal(amended.status, 0, amended.stderr);

    // A merge commit is exempt.
    repo.git("checkout", "--quiet", "-b", "topic");
    write("src/other.mjs", "export {};\n");
    repo.git("add", "src/other.mjs");
    assert.equal(commit("-m", "Other", "-m", "Changelog: none (fixture)").status, 0);
    repo.git("checkout", "--quiet", "dev");
    write("README.md", "# Example\n");
    repo.git("add", "README.md");
    assert.equal(commit("-m", "Readme").status, 0);
    const merge = spawnSync("git", ["merge", "--quiet", "--no-ff", "-m", "Merge topic", "topic"], { cwd: repo.root, env: repo.env, encoding: "utf8" });
    assert.equal(merge.status, 0, merge.stderr);
    assert.equal(repo.git("rev-list", "--count", "--merges", "HEAD"), "1");
  } finally {
    repo.cleanup();
  }
});

test("in a repository without node_modules the commit-msg hook runs the repo-kit on PATH", () => {
  const python = guarded(pyprojectFiles({
    "repo-kit.config.mjs": configText(["example/**"], ', hooks: { managed: ["commit-msg"] }'),
    "example/__init__.py": "",
  }), ["example/**"]);
  try {
    quiet(() => syncHooks(python.root, { ...python.config, hooks: { managed: ["commit-msg"] } }));
    python.git("config", "core.hooksPath", ".githooks");
    const bin = path.join(python.root, ".bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(kitRoot, "src/cli.mjs"), path.join(bin, "repo-kit"));
    fs.writeFileSync(path.join(python.root, ".gitignore"), ".bin/\n");
    fs.writeFileSync(path.join(python.root, "example/__init__.py"), "VALUE = 1\n");
    python.git("add", "-A");
    const commit = env => spawnSync("git", ["commit", "--quiet", "-m", "Value"], { cwd: python.root, env, encoding: "utf8" });
    // Without a kit to run, the hook warns and lets the commit through; CI's range check still runs.
    const missing = commit({ ...python.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stderr, /commit-msg: warning: repo-kit is not installed; run bun install, or put repo-kit on PATH\. The changelog-entry check did not run/);
    python.git("reset", "--quiet", "--soft", "HEAD~1");
    const refused = commit({ ...python.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /example\/__init__.py changed example without a line under "## Unreleased" in CHANGELOG.md/);
  } finally {
    python.cleanup();
  }
});

/** A guarded root package with the commit-msg hook active and the kit linked into node_modules. */
function hooked(kit = kitRoot) {
  const repo = guarded(rootPackageFiles({ "repo-kit.config.mjs": configText(PATHS, ', hooks: { managed: ["commit-msg"] }'), "src/index.mjs": "export {};\n" }));
  quiet(() => syncHooks(repo.root, { ...repo.config, hooks: { managed: ["commit-msg"] } }));
  fs.mkdirSync(path.join(repo.root, "node_modules/@maxvyshniakov"), { recursive: true });
  fs.symlinkSync(kit, path.join(repo.root, "node_modules/@maxvyshniakov/repo-kit"));
  fs.writeFileSync(path.join(repo.root, ".gitignore"), "node_modules/\n.bin/\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "--no-verify", "-m", "Hooks");
  repo.git("config", "core.hooksPath", ".githooks");
  const write = (relative, contents) => fs.writeFileSync(path.join(repo.root, relative), contents);
  const run = (args, env = repo.env) => spawnSync("git", args, { cwd: repo.root, env, encoding: "utf8" });
  return { ...repo, write, run, commit: (...args) => run(["commit", "--quiet", ...args]) };
}

test("the commit-msg hook fails open, with a warning, when node is missing or the kit has no commit-msg", () => {
  const repo = hooked();
  const old = tempRepository({ "src/cli.mjs": "console.log('Usage: repo-kit <command>\\n  verify');\nprocess.exitCode = 1;\n" });
  const oldRepo = hooked(old.root);
  try {
    // A GUI client's PATH without node: only git and the system tools.
    const bin = path.join(repo.root, ".bin");
    fs.mkdirSync(bin);
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(gitPath, path.join(bin, "git"));
    repo.write("src/index.mjs", "export const a = 1;\n");
    const noNode = repo.run(["commit", "--quiet", "-a", "-m", "Add a"], { ...repo.env, PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.match(noNode.stderr, /commit-msg: warning: node is not on PATH; install Node\.js 22 or newer, or add it to the PATH Git hooks run with\./);

    oldRepo.write("src/index.mjs", "export const a = 1;\n");
    const outdated = oldRepo.commit("-a", "-m", "Add a");
    assert.equal(outdated.status, 0, outdated.stderr);
    assert.match(outdated.stderr, /commit-msg: warning: this repo-kit has no commit-msg command; install repo-kit 0\.5\.0 or newer\./);
  } finally {
    repo.cleanup();
    oldRepo.cleanup();
    old.cleanup();
  }
});

test("--amend is read from the command line, not from a message that says it", () => {
  assert.equal(amending("git commit --amend --no-edit"), true);
  assert.equal(amending("git -C /x commit -a --amend"), true);
  assert.equal(amending("git commit -m --amend"), false);
  assert.equal(amending("git commit --message --amend"), false);
  assert.equal(amending("git commit -a -m Fix"), false);
});

test("an amend the command line hides is recognised by its unchanged message, and the failure says so", () => {
  const repo = hooked();
  try {
    repo.git("config", "alias.fix", "commit --amend --no-edit");
    repo.write("src/index.mjs", "export const b = 2;\n");
    repo.write("CHANGELOG.md", entry(path.join(repo.root, "CHANGELOG.md")));
    assert.equal(repo.commit("-a", "-m", "Add b").status, 0);
    repo.write("src/index.mjs", "export const b = 3;\n");
    const aliased = repo.run(["fix", "--quiet", "-a"]);
    assert.equal(aliased.status, 0, aliased.stderr);

    repo.write("src/index.mjs", "export const c = 4;\n");
    const refused = repo.commit("-a", "-m", "Add c");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /An amend the hook could not see as one is checked as a new commit; add the trailer if the amended commit's entry covers it\./);
  } finally {
    repo.cleanup();
  }
});

test("fixup! and squash! commits pass the hook; the range check still covers them", () => {
  const repo = hooked();
  try {
    repo.write("src/index.mjs", "export const b = 2;\n");
    repo.write("CHANGELOG.md", entry(path.join(repo.root, "CHANGELOG.md")));
    assert.equal(repo.commit("-a", "-m", "Add b").status, 0);
    for (const kind of ["fixup", "squash"]) {
      repo.write("src/index.mjs", `export const b = "${kind}";\n`);
      const result = repo.commit("-a", `--${kind}=HEAD`, ...(kind === "squash" ? ["--no-edit"] : []));
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    }
    assert.match(repo.check("HEAD~2").output, /FAIL [0-9a-f]{10} fixup! Add b/);
  } finally {
    repo.cleanup();
  }
});

test("a revert passes: removing an Unreleased line is an entry change", () => {
  const repo = guarded();
  try {
    repo.commit({ "src/index.mjs": "export const b = 2;\n", "CHANGELOG.md": entry }, "Add b");
    repo.git("revert", "--no-edit", "HEAD");
    assert.equal(repo.check().result, 0, repo.check().output);
  } finally {
    repo.cleanup();
  }
});

test("character classes and ** inside braces are configuration errors", () => {
  assert.throws(() => globToRegExp("src/[ab].ts"), /changelog\.paths: "src\/\[ab\]\.ts": character classes \(\[\.\.\.\]\) are not supported/);
  assert.throws(() => globToRegExp("{src/**,lib}/x"), /changelog\.paths: "\{src\/\*\*,lib\}\/x": "\*\*" inside \{\} is not supported/);
  assert.throws(() => globToRegExp("{a,{b,c}}"), /nested \{\} is not supported/);
});

test("check-changelog-entries warns about a glob that matches no tracked file", () => {
  const repo = guarded(rootPackageFiles({ "repo-kit.config.mjs": configText(["src", "lib/**"]), "src/index.mjs": "export {};\n" }), ["src", "lib/**"]);
  try {
    repo.commit({ "README.md": "# Example\n" }, "Readme");
    const { result, output } = repo.check();
    assert.equal(result, 0);
    assert.match(output, /changelog entries: warning: changelog\.paths "src" matches no tracked file; for everything below a directory write "src\/\*\*"/);
    assert.match(output, /changelog entries: warning: changelog\.paths "lib\/\*\*" matches no tracked file/);
  } finally {
    repo.cleanup();
  }
});

test("one Changelog: none trailer exempts every package a commit changes", () => {
  const files = workspaceFiles({ "repo-kit.config.mjs": configText(["packages/a/src/**", "packages/b/src/**"]) });
  delete files["packages/example/package.json"];
  delete files["packages/example/CHANGELOG.md"];
  for (const name of ["a", "b"]) {
    files[`packages/${name}/package.json`] = { name: `@maxvyshniakov/${name}`, version: "0.2.0" };
    files[`packages/${name}/CHANGELOG.md`] = changelog.replace("example", name);
    files[`packages/${name}/src/index.mjs`] = "export {};\n";
  }
  const repo = guarded(files, ["packages/a/src/**", "packages/b/src/**"]);
  try {
    repo.commit({ "packages/a/src/index.mjs": "export const a = 1;\n", "packages/b/src/index.mjs": "export const b = 1;\n" }, "Both");
    assert.match(repo.check().output, /packages\/a\/CHANGELOG.md[\s\S]*packages\/b\/CHANGELOG.md/);
    repo.commit({ "packages/a/src/index.mjs": "export const a = 2;\n", "packages/b/src/index.mjs": "export const b = 2;\n" }, "Both again\n\nChangelog: none (fixture)");
    assert.equal(repo.check().result, 0);
  } finally {
    repo.cleanup();
  }
});
