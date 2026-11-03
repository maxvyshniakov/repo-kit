// Package changelog format shared by `bun run release` and `check:changelogs`.
// The policy lives in docs/VERSIONING.md.
//
//   # @maxvyshniakov/<package> Changelog
//
//   <optional intro paragraph>
//
//   ## Unreleased
//
//   ## 1.2.3 - 2026-09-25
//
//   ### Breaking | Added | Changed | Deprecated | Removed | Fixed | Security
//
//   - Entry ...

export const SECTION_NAMES = ["Breaking", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_HEADING = /^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/;

export function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Not a release version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// npm caret semantics: the leftmost non-zero part is fixed, so ^0.26.1 means
// >=0.26.1 <0.27.0. Peer ranges between workspace packages use only this form.
export function satisfiesCaret(range, version) {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (!match) throw new Error(`Expected a ^x.y.z range, got ${range}`);
  const floor = parseVersion(match[1]);
  const fixed = floor.findIndex(part => part !== 0);
  const candidate = parseVersion(version);
  const fixedParts = fixed === -1 ? 3 : fixed + 1;
  return compareVersions(version, match[1]) >= 0
    && candidate.slice(0, fixedParts).every((part, index) => part === floor[index]);
}

// `level` is patch, minor, major or an explicit x.y.z above the current one.
export function nextVersion(current, level) {
  if (VERSION.test(level)) {
    if (compareVersions(level, current) <= 0) throw new Error(`${level} is not above ${current}`);
    return level;
  }
  const [major, minor, patch] = parseVersion(current);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown release level: ${level} (use patch, minor, major or x.y.z)`);
}

/**
 * Splits a changelog into title, intro, the Unreleased body and releases.
 * Structural problems are collected in `errors` instead of thrown, so the
 * checker can report every one of them.
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const errors = [];
  const titles = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("# "));
  if (titles.length !== 1) errors.push(`expected one "# " title, found ${titles.length}`);
  const title = titles[0]?.line.slice(2) ?? "";
  if (titles[0] && lines.slice(0, titles[0].index).some(line => line.trim())) {
    errors.push("text before the title");
  }

  const sections = [];
  let intro = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (titles[0] && index <= titles[0].index) continue;
    if (line.startsWith("## ")) {
      current = { heading: line, line: index + 1, body: [] };
      sections.push(current);
      continue;
    }
    if (/^#### |^##### /.test(line)) errors.push(`line ${index + 1}: use "###" section headings only`);
    const section = /^### (.+)$/.exec(line);
    if (section && !SECTION_NAMES.includes(section[1])) {
      errors.push(`line ${index + 1}: unknown section "${section[1]}" (use ${SECTION_NAMES.join(", ")})`);
    }
    (current ? current.body : intro).push(line);
  }

  let unreleased = null;
  const releases = [];
  for (const [position, section] of sections.entries()) {
    if (section.heading === "## Unreleased") {
      if (position !== 0) errors.push(`line ${section.line}: "## Unreleased" must be the first section`);
      if (unreleased !== null) errors.push(`line ${section.line}: duplicate "## Unreleased"`);
      unreleased = trimBlank(section.body).join("\n");
      continue;
    }
    const release = RELEASE_HEADING.exec(section.heading);
    if (!release) {
      errors.push(`line ${section.line}: expected "## Unreleased" or "## x.y.z - YYYY-MM-DD", found "${section.heading}"`);
      continue;
    }
    releases.push({ version: release[1], date: release[2], line: section.line, body: trimBlank(section.body).join("\n") });
  }
  if (unreleased === null) errors.push('missing "## Unreleased"');

  for (let index = 1; index < releases.length; index++) {
    const [newer, older] = [releases[index - 1], releases[index]];
    if (compareVersions(newer.version, older.version) <= 0) {
      errors.push(`line ${older.line}: ${older.version} must be older than ${newer.version} above it`);
    }
    if (newer.date < older.date) errors.push(`line ${newer.line}: ${newer.version} is dated before ${older.version}`);
  }

  return { title, intro: trimBlank(intro).join("\n"), unreleased: unreleased ?? "", releases, errors };
}

export function formatChangelog({ title, intro, unreleased, releases }) {
  const parts = [`# ${title}`];
  if (intro) parts.push(intro);
  parts.push(unreleased ? `## Unreleased\n\n${unreleased}` : "## Unreleased");
  for (const release of releases) {
    parts.push(release.body ? `## ${release.version} - ${release.date}\n\n${release.body}` : `## ${release.version} - ${release.date}`);
  }
  return `${parts.join("\n\n")}\n`;
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

// bun.lock records each workspace package's version, but `bun install` leaves
// it stale when only package.json "version" changes, so releases set it here.
export function lockfileWorkspaceVersion(lockfile, workspacePath) {
  const block = new RegExp(`\\n    "${escapeRegExp(workspacePath)}": \\{\\n      "name": "[^"]+",\\n      "version": "([^"]+)",`);
  return block.exec(lockfile)?.[1];
}

export function setLockfileWorkspaceVersion(lockfile, workspacePath, version) {
  const block = new RegExp(`(\\n    "${escapeRegExp(workspacePath)}": \\{\\n      "name": "[^"]+",\\n      "version": ")[^"]+(",)`);
  if (!block.test(lockfile)) throw new Error(`bun.lock has no workspace entry for ${workspacePath}`);
  return lockfile.replace(block, `$1${version}$2`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
