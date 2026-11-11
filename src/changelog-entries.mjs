// The changelog-entry guard: a commit that changes a package's shipped paths
// (changelog.paths in repo-kit.config.mjs) adds, changes or removes a line under
// "## Unreleased" in that package's CHANGELOG.md, or carries the trailer
// "Changelog: none", optionally with a reason: "Changelog: none (tests only)".
// One such trailer covers the whole commit, every package it changes.
// Merge commits, and commits that cut the package's release (a new newest
// changelog release that the manifest's version names, as `repo-kit release`
// writes), are exempt.
//
//   repo-kit check-changelog-entries <base>..<head>   every commit of a range (verify, CI)
//   repo-kit commit-msg <message file>                the commit being made (.githooks/commit-msg)
//
// Without changelog.paths both do nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { compareVersions, parseChangelog } from "./changelog.mjs";
import { releasedPackages } from "./config.mjs";
import { readManifestText } from "./version-source.mjs";

export const TRAILER = "Changelog";
const HINT = `Add a line under "## Unreleased" in that CHANGELOG.md, or end the commit message with the trailer "${TRAILER}: none (<reason>)".`;

/**
 * A path glob as a RegExp over repository-relative paths with "/": `*` and `?`
 * stay within a path segment, `**` spans segments, `{a,b}` is either, and a
 * trailing "/" names everything below a directory.
 */
export function globToRegExp(glob) {
  let source = "";
  const pattern = glob.replace(/^\.\//, "").replace(/\/$/, "/**");
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      // "**/" at a segment's start: any directories, none included; else anything.
      const atSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (atSegmentStart && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" || char === "]") {
      throw new Error(`changelog.paths: "${glob}": character classes ([...]) are not supported; use {a,b}`);
    } else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end === -1) throw new Error(`changelog.paths: "${glob}": unclosed "{"`);
      const body = pattern.slice(index + 1, end);
      if (body.includes("{")) throw new Error(`changelog.paths: "${glob}": nested {} is not supported`);
      if (body.includes("**")) throw new Error(`changelog.paths: "${glob}": "**" inside {} is not supported; list the globs separately`);
      // Alternatives match literally, or with * and ? within a segment.
      source += `(?:${body.split(",").map(part => escape(part).replaceAll("\\*", "[^/]*").replaceAll("\\?", "[^/]")).join("|")})`;
      index = end;
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * changelog.paths as one rule per package: { pkg, changelog, include, exclude }.
 * An array belongs to the only released package; with several, each glob to the
 * package whose directory it lies in. An object keys globs by package directory
 * ("packages/sid-kit", or "." for the root package) or by its name under packages/.
 * A glob starting with "!" excludes what the others include.
 */
export function compileRules(paths, packages) {
  if (paths === undefined || paths === null) return [];
  const byPackage = new Map();
  const add = (pkg, glob) => byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), glob]);
  if (Array.isArray(paths)) {
    for (const glob of paths) {
      if (typeof glob !== "string") throw new Error(`changelog.paths: expected glob strings, got ${JSON.stringify(glob)}`);
      const plain = glob.replace(/^!/, "").replace(/^\.\//, "");
      const pkg = packages.length === 1
        ? packages[0]
        : packages.find(candidate => candidate.path !== "." && plain.startsWith(`${candidate.path}/`));
      if (!pkg) {
        throw new Error(`changelog.paths: ${glob} lies in none of ${packages.map(candidate => candidate.path).join(", ")}; key the globs by package directory`);
      }
      add(pkg, glob);
    }
  } else if (typeof paths === "object") {
    for (const [key, globs] of Object.entries(paths)) {
      const pkg = packages.find(candidate => candidate.path === key || candidate.path === `packages/${key}`);
      if (!pkg) throw new Error(`changelog.paths: ${key} is not a released package (${packages.map(candidate => candidate.path).join(", ")})`);
      if (!Array.isArray(globs) || globs.some(glob => typeof glob !== "string")) {
        throw new Error(`changelog.paths["${key}"]: expected an array of globs`);
      }
      for (const glob of globs) add(pkg, glob);
    }
  } else {
    throw new Error("changelog.paths: expected an array of globs or { <package directory>: [globs] }");
  }
  return [...byPackage].map(([pkg, globs]) => {
    const includes = globs.filter(glob => !glob.startsWith("!"));
    return {
      pkg,
      changelog: path.posix.join(pkg.path, "CHANGELOG.md"),
      manifest: path.posix.join(pkg.path, pkg.manifestFile ?? "package.json"),
      includes,
      include: includes.map(globToRegExp),
      exclude: globs.filter(glob => glob.startsWith("!")).map(glob => globToRegExp(glob.slice(1))),
    };
  });
}

/** A warning for each include glob that matches none of `tracked`, with "dir/**" suggested for a bare directory. */
export function unmatchedGlobWarnings(rules, tracked) {
  const warnings = [];
  for (const rule of rules) {
    for (const [index, glob] of rule.includes.entries()) {
      if (tracked.some(file => rule.include[index].test(file))) continue;
      const plain = glob.replace(/^\.\//, "");
      const directory = !/[*?{]/.test(plain) && tracked.some(file => file.startsWith(`${plain}/`));
      warnings.push(`changelog.paths "${glob}" matches no tracked file${directory ? `; for everything below a directory write "${plain}/**"` : ""}`);
    }
  }
  return warnings;
}

export function shippedFiles(files, rule) {
  return files.filter(file => rule.include.some(re => re.test(file)) && !rule.exclude.some(re => re.test(file)));
}

const entryLines = text => (text === undefined ? [] : parseChangelog(text).unreleased.split("\n"))
  .map(line => line.trimEnd())
  .filter(line => line.trim() && !/^#{1,6} /.test(line));

/**
 * Whether the lines under "## Unreleased" differ, ignoring order, blank lines and
 * headings: an entry added, changed or removed (a revert takes its entry back out).
 */
export function unreleasedChanged(before, after) {
  if (after === undefined) return false; // a deleted changelog is no entry
  const counts = new Map();
  for (const line of entryLines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of entryLines(after)) counts.set(line, (counts.get(line) ?? 0) - 1);
  return [...counts.values()].some(count => count !== 0);
}

/** Whether the change cuts a release: a newer newest release, the version the manifest now records. */
export function cutsRelease(before, after, version) {
  const newest = text => (text === undefined ? undefined : parseChangelog(text).releases[0]?.version);
  const [previous, current] = [newest(before), newest(after)];
  return current !== undefined && current === version && (previous === undefined || compareVersions(current, previous) > 0);
}

/** The Changelog trailers' values, as git parses the message's trailers. */
export function changelogTrailers(message, { cwd } = {}) {
  const result = spawnSync("git", ["interpret-trailers", "--parse"], { cwd, input: message, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git interpret-trailers failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n")
    .map(line => new RegExp(`^${TRAILER}\\s*:\\s*(.*)$`, "i").exec(line))
    .filter(Boolean)
    .map(match => match[1].trim());
}

export const optsOut = value => /^none(?:$|[\s(:,;-])/i.test(value);

/**
 * Problems with one change, as messages. `change` is { files, before(file), after(file), message }:
 * the changed paths and readers of a file's text before and after it (undefined when absent).
 */
export function changeIssues(change, rules, { cwd } = {}) {
  const missing = [];
  for (const rule of rules) {
    const shipped = shippedFiles(change.files, rule);
    if (!shipped.length) continue;
    const [before, after] = [change.before(rule.changelog), change.after(rule.changelog)];
    if (unreleasedChanged(before, after)) continue;
    const manifest = change.after(rule.manifest);
    const version = manifest === undefined ? undefined : manifestVersion(rule.pkg.manifestFile ?? "package.json", manifest);
    if (cutsRelease(before, after, version)) continue;
    missing.push({ rule, shipped });
  }
  if (!missing.length) return [];
  const trailers = changelogTrailers(change.message, { cwd });
  if (trailers.some(optsOut)) return [];
  const issues = missing.map(({ rule, shipped }) => {
    const more = shipped.length > 1 ? ` and ${shipped.length - 1} more` : "";
    return `${shipped[0]}${more} changed ${rule.pkg.name} without a line under "## Unreleased" in ${rule.changelog}`;
  });
  for (const value of trailers) issues.push(`the trailer "${TRAILER}: ${value}" is not "${TRAILER}: none"`);
  return issues;
}

function manifestVersion(source, text) {
  try {
    return readManifestText(source, text).version;
  } catch {
    return undefined;
  }
}

/** The rules of the repository's config; [] when changelog.paths is unset. */
export function configuredRules(config) {
  const { paths, versionSource } = config.changelog;
  if (paths === undefined || paths === null) return [];
  return compileRules(paths, releasedPackages(config.root, { versionSource }));
}

function git(cwd, args, { input, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result;
}

function reader(cwd, revision) {
  return file => {
    if (revision === undefined) return undefined;
    const result = git(cwd, ["cat-file", "blob", `${revision}:${file}`], { allowFailure: true });
    return result.status === 0 ? result.stdout : undefined;
  };
}

const nulList = text => text.split("\0").filter(Boolean);

/** { sha, subject, issues } of every non-merge commit in `range` that fails; { checked, exempt } counts. */
export function rangeIssues(root, range, rules) {
  const listed = git(root, ["rev-list", "--reverse", "--parents", ...range, "--"], { allowFailure: true });
  if (listed.status !== 0) {
    throw new Error(`${range.join(" ")} is not a range of this checkout (${listed.stderr.trim().split("\n")[0]}); fetch its base first (CI: actions/checkout with fetch-depth: 0)`);
  }
  const failures = [];
  let checked = 0;
  let merges = 0;
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [sha, ...parents] = line.split(" ");
    if (parents.length > 1) {
      merges++;
      continue;
    }
    checked++;
    const files = nulList(git(root, ["diff-tree", "--no-commit-id", "--root", "-r", "-z", "--name-only", "--no-renames", sha]).stdout);
    const message = git(root, ["log", "-1", "--format=%B", sha]).stdout;
    const issues = changeIssues({ files, before: reader(root, parents[0]), after: reader(root, sha), message }, rules, { cwd: root });
    if (issues.length) failures.push({ sha, subject: message.split("\n")[0], issues });
  }
  return { failures, checked, merges };
}

export function runCheckChangelogEntries(config, args) {
  const range = args.filter(arg => arg !== "--");
  if (!range.length) {
    console.error("Usage: repo-kit check-changelog-entries <base>..<head>");
    return 2;
  }
  const rules = configuredRules(config);
  if (!rules.length) {
    console.log("changelog entries: changelog.paths is not configured; nothing to check");
    return 0;
  }
  const tracked = nulList(git(config.root, ["ls-files", "-z"]).stdout);
  for (const warning of unmatchedGlobWarnings(rules, tracked)) console.error(`changelog entries: warning: ${warning}`);
  const { failures, checked, merges } = rangeIssues(config.root, range, rules);
  for (const { sha, subject, issues } of failures) {
    console.error(`FAIL ${sha.slice(0, 10)} ${subject}`);
    for (const issue of issues) console.error(`  ${issue}`);
  }
  const summary = `${checked} commit${checked === 1 ? "" : "s"} checked, ${merges} merge${merges === 1 ? "" : "s"} exempt`;
  if (failures.length) {
    console.error(`\nchangelog entries: ${failures.length} of ${summary}. ${HINT}`);
    return 1;
  }
  console.log(`changelog entries: ok (${summary})`);
  return 0;
}

/**
 * Whether the running `git commit` amends: its command line has --amend. Git
 * runs the hook directly, so the hook's parent is that git process. An alias
 * that hides --amend is not seen; the commit is then checked as a new one.
 */
export function amending(parentArgs = parentCommandLine()) {
  const words = parentArgs.trim().split(/\s+/);
  // "-m --amend" is a message, not the option.
  return words.some((word, index) => word === "--amend" && !TAKES_VALUE.has(words[index - 1]));
}

const TAKES_VALUE = new Set(["-m", "--message", "-F", "--file", "-c", "-C", "--reuse-message", "--reedit-message",
  "--author", "--date", "--trailer", "-t", "--template", "--cleanup", "--fixup", "--squash"]);

const SCISSORS = /^. -+ >8 -+$/m;

/** The message as Git will record it: up to a scissors line, comments and surplus blank lines stripped. */
export function cleanMessage(message, { cwd } = {}) {
  const cut = SCISSORS.exec(message);
  const text = cut ? message.slice(0, cut.index) : message;
  const result = spawnSync("git", ["stripspace", "--strip-comments"], { cwd, input: text, encoding: "utf8" });
  return result.status === 0 ? result.stdout : text;
}

function parentCommandLine() {
  const result = spawnSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

/**
 * Problems with the commit being made: the index against HEAD, or against HEAD's
 * parent when amending. An amend the command line does not show (an alias, a
 * hook manager, a GUI) usually keeps HEAD's message: a commit with HEAD's message
 * that fails against HEAD is checked against HEAD's parent too, so the entry the
 * amended commit already has counts. fixup! and squash! commits pass: they are
 * folded into another commit, and the range check sees the result.
 */
export function stagedIssues(root, message, rules, { amend = amending() } = {}) {
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true }).stdout.trim() || undefined;
  const mergeHead = git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).stdout.trim();
  if (fs.existsSync(path.resolve(root, mergeHead))) return [];
  const cleaned = cleanMessage(message, { cwd: root });
  if (/^(?:fixup|squash|amend)! /.test(cleaned)) return [];
  const headParents = () => git(root, ["rev-list", "--parents", "-n", "1", head]).stdout.trim().split(" ").slice(1);
  const against = base => {
    const emptyTree = git(root, ["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
    const files = nulList(git(root, ["diff", "--cached", "-z", "--name-only", "--no-renames", base ?? emptyTree]).stdout);
    const after = file => {
      const result = git(root, ["cat-file", "blob", `:${file}`], { allowFailure: true });
      return result.status === 0 ? result.stdout : undefined;
    };
    return changeIssues({ files, before: reader(root, base), after, message: cleaned }, rules, { cwd: root });
  };
  if (amend && head) {
    const parents = headParents();
    return parents.length > 1 ? [] : against(parents[0]); // amending a merge is exempt
  }
  const issues = against(head);
  if (!issues.length || !head) return issues;
  const headMessage = cleanMessage(git(root, ["log", "-1", "--format=%B", head]).stdout, { cwd: root });
  if (headMessage.trim() !== cleaned.trim()) return issues;
  const parents = headParents();
  if (parents.length > 1 || !against(parents[0]).length) return [];
  return issues;
}

export function runCommitMsg(config, [messageFile] = []) {
  if (!messageFile) {
    console.error("Usage: repo-kit commit-msg <message file>");
    return 2;
  }
  const rules = configuredRules(config);
  if (!rules.length) return 0;
  const issues = stagedIssues(config.root, fs.readFileSync(path.resolve(messageFile), "utf8"), rules);
  if (!issues.length) return 0;
  console.error("commit-msg: changelog entry missing:");
  for (const issue of issues) console.error(`  ${issue}`);
  console.error(`commit-msg: ${HINT} An amend the hook could not see as one is checked as a new commit; add the trailer if the amended commit's entry covers it.`);
  console.error("commit-msg: Nothing was committed; skip once with git commit --no-verify.");
  return 1;
}
