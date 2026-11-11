// Where a released package keeps its name and version: package.json ("version")
// or pyproject.toml ([project] version). `changelog.versionSource` in
// repo-kit.config.mjs chooses one; without it a repository with a root
// package.json uses package.json, and one without uses pyproject.toml.
import fs from "node:fs";
import path from "node:path";

export const VERSION_SOURCES = ["package.json", "pyproject.toml"];

export function chooseVersionSource(root, configured) {
  if (configured !== undefined) {
    if (!VERSION_SOURCES.includes(configured)) {
      throw new Error(`changelog.versionSource must be ${VERSION_SOURCES.join(" or ")}, got ${configured}`);
    }
    return configured;
  }
  return fs.existsSync(path.join(root, "package.json")) ? "package.json" : "pyproject.toml";
}

// Only what releases need of TOML: the [project] table's static `name` and
// `version` strings, each on one line. Other tables (a [tool.poetry] version, say)
// are never read or written.
const HEADER = /^\s*\[/;
const PROJECT_HEADER = /^\s*\[\s*project\s*\]\s*(?:#.*)?$/;
const KEY = /^\s*(name|version)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;

/** { name, version, versionLine } of pyproject.toml's [project] table. */
export function pyprojectProject(text) {
  const lines = text.split("\n");
  const found = {};
  let inProject = false;
  let sawProject = false;
  for (const [index, line] of lines.entries()) {
    if (HEADER.test(line)) {
      inProject = PROJECT_HEADER.test(line);
      sawProject ||= inProject;
      continue;
    }
    const match = inProject && KEY.exec(line);
    if (!match) continue;
    found[match[1]] = match[2] ?? match[3];
    if (match[1] === "version") found.versionLine = index;
  }
  if (!sawProject) throw new Error("pyproject.toml has no [project] table");
  if (found.version === undefined) {
    throw new Error('pyproject.toml [project] has no static version = "x.y.z" (a dynamic version is not supported)');
  }
  return found;
}

export function setPyprojectVersion(text, version) {
  const { versionLine } = pyprojectProject(text);
  const lines = text.split("\n");
  lines[versionLine] = lines[versionLine].replace(/(=\s*)(["'])[^"']*\2/, `$1$2${version}$2`);
  return lines.join("\n");
}

/** The name and version a manifest's text records, by its file name. */
export function readManifestText(source, text) {
  if (source === "pyproject.toml") {
    const { name, version } = pyprojectProject(text);
    return { manifest: {}, name, version };
  }
  const manifest = JSON.parse(text);
  return { manifest, name: manifest.name, version: manifest.version };
}

/** The manifest text with its version set. */
export function setManifestVersion(source, text, { from, to }) {
  if (source === "pyproject.toml") return setPyprojectVersion(text, to);
  return text.replace(`"version": "${from}"`, `"version": "${to}"`);
}
