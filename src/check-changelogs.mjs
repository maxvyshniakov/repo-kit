// Checks every released package's CHANGELOG.md against the changelog policy.
//
//   repo-kit check-changelogs            format; package.json or pyproject.toml version = newest release;
//                                        for a workspace package, bun.lock's entry;
//                                        quick start archive names; peer ranges
//   repo-kit check-changelogs --release  also require an empty "## Unreleased"
//
// CI runs the --release form: a change reaches main only after its entries
// were cut into a version with `repo-kit release`.
import fs from "node:fs";
import path from "node:path";

import { lockfileWorkspaceVersion, parseChangelog, satisfiesCaret } from "./changelog.mjs";
import { releasedPackages } from "./config.mjs";

export function changelogIssues({ name, version, changelog, lockedVersion, archiveVersions = [], manifestFile = "package.json" }, { release = false, quickStart = "docs/GETTING_STARTED.md" } = {}) {
  if (changelog === undefined) return ["missing CHANGELOG.md"];
  const parsed = parseChangelog(changelog);
  const issues = [...parsed.errors];
  if (parsed.title && parsed.title !== `${name} Changelog`) {
    issues.push(`title must be "# ${name} Changelog"`);
  }
  const newest = parsed.releases[0];
  if (!newest) issues.push("no released version");
  else if (newest.version !== version) {
    issues.push(`${manifestFile} version ${version} does not match the newest changelog release ${newest.version}`);
  }
  if (lockedVersion !== undefined && lockedVersion !== version) {
    issues.push(`bun.lock records ${lockedVersion} for this workspace; ${manifestFile} says ${version}`);
  }
  for (const archiveVersion of archiveVersions) {
    if (archiveVersion !== version) {
      issues.push(`${quickStart} names the ${archiveVersion} archive; ${manifestFile} says ${version}`);
    }
  }
  if (release && parsed.unreleased.trim()) {
    issues.push('"## Unreleased" has entries; cut them into a version with `bun run release`');
  }
  return issues;
}

// A peer range must include the version the package is built and tested
// against: another workspace package's current version, or an exact
// devDependency pin. Moving that version past the range fails until the range
// is widened and this package is released too. Only peers in `scope` count.
export function peerIssues({ peerDependencies = {}, devDependencies = {} }, packages, { scope = "@maxvyshniakov/" } = {}) {
  const issues = [];
  for (const [name, range] of Object.entries(peerDependencies)) {
    const pinned = /^\d+\.\d+\.\d+$/.test(devDependencies[name] ?? "") ? devDependencies[name] : undefined;
    const version = packages.find(pkg => pkg.name === name)?.version ?? pinned;
    if (!version || !name.startsWith(scope)) continue;
    if (!/^\^\d+\.\d+\.\d+$/.test(range)) {
      issues.push(`peer range ${range} for ${name}: use a ^x.y.z range`);
    } else if (!satisfiesCaret(range, version)) {
      issues.push(`peer range ${range} for ${name} excludes its version ${version}; widen it and release this package too`);
    }
  }
  return issues;
}

/** releasedPackages with what changelogIssues and peerIssues read. */
export function changelogPackages(root, { quickStart = "docs/GETTING_STARTED.md", versionSource } = {}) {
  const lockfilePath = path.join(root, "bun.lock");
  const lockfile = fs.existsSync(lockfilePath) ? fs.readFileSync(lockfilePath, "utf8") : "";
  const quickStartPath = quickStart && path.join(root, quickStart);
  const quickStartText = quickStartPath && fs.existsSync(quickStartPath) ? fs.readFileSync(quickStartPath, "utf8") : "";
  return releasedPackages(root, { versionSource }).map(pkg => {
    const changelogPath = path.join(pkg.dir, "CHANGELOG.md");
    const archive = new RegExp(`${pkg.name.replace("@", "").replace("/", "-")}-(\\d+\\.\\d+\\.\\d+)\\.tgz`, "g");
    return {
      ...pkg,
      peerDependencies: pkg.manifest.peerDependencies,
      devDependencies: pkg.manifest.devDependencies,
      changelog: fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : undefined,
      // bun.lock and the quick start's archives name npm packages only.
      lockedVersion: pkg.workspace && pkg.manifestFile === "package.json" ? lockfileWorkspaceVersion(lockfile, pkg.path) : undefined,
      archiveVersions: pkg.manifestFile === "package.json" ? [...quickStartText.matchAll(archive)].map(match => match[1]) : [],
    };
  });
}

/** Prints each package's result; resolves to whether all passed. */
export function runCheckChangelogs(config, { release = false } = {}) {
  const { quickStart, peerScope, versionSource } = config.changelog;
  const packages = changelogPackages(config.root, { quickStart, versionSource });
  let failed = false;
  for (const pkg of packages) {
    const issues = [...changelogIssues(pkg, { release, quickStart }), ...peerIssues(pkg, packages, { scope: peerScope })];
    const label = `${pkg.name}@${pkg.version}`;
    if (issues.length) {
      failed = true;
      console.error(`FAIL ${label}`);
      for (const issue of issues) console.error(`  ${issue}`);
    } else {
      console.log(`ok   ${label}`);
    }
  }
  if (failed) console.error("\nSee docs/VERSIONING.md.");
  return !failed;
}
