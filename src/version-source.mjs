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
// are never read or written. A line counts as a table header or a key only at the
// top level: outside multi-line strings ("""...""", '''...''') and arrays or
// inline tables that span lines.
const PROJECT_HEADER = /^\s*\[\s*project\s*\]\s*(?:#.*)?$/;
const KEY = /^\s*(name|version)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;

/** Each line with whether it starts at the top level, outside strings and brackets. */
function topLevelLines(text) {
  const lines = text.split("\n");
  let multiline = null; // the open """ or '''
  let depth = 0;
  return lines.map(line => {
    const topLevel = multiline === null && depth === 0;
    for (let index = 0; index < line.length; index++) {
      if (multiline) {
        if (multiline === '"""' && line[index] === "\\") index++;
        else if (line.startsWith(multiline, index)) {
          index += 2;
          multiline = null;
        }
        continue;
      }
      const char = line[index];
      if (char === "#") break;
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        multiline = line.slice(index, index + 3);
        index += 2;
      } else if (char === '"' || char === "'") {
        // A one-line string: skip to its end (basic strings have escapes).
        for (index++; index < line.length && line[index] !== char; index++) if (char === '"' && line[index] === "\\") index++;
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    }
    return { line, topLevel };
  });
}

/** { name, version, versionLine } of pyproject.toml's [project] table. */
export function pyprojectProject(text) {
  const found = {};
  let inProject = false;
  let sawProject = false;
  for (const [index, { line, topLevel }] of topLevelLines(text).entries()) {
    if (!topLevel) continue;
    if (/^\s*\[/.test(line)) {
      inProject = PROJECT_HEADER.test(line);
      sawProject ||= inProject;
      continue;
    }
    const match = inProject && KEY.exec(line);
    if (!match) continue;
    if (match[1] === "version" && found.versionLine !== undefined) {
      throw new Error(`pyproject.toml [project] sets version twice (lines ${found.versionLine + 1} and ${index + 1})`);
    }
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
