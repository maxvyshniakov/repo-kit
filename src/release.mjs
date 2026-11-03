// Cuts package releases: moves each package's "## Unreleased" entries under a
// new "## x.y.z - YYYY-MM-DD" heading and sets that version in package.json,
// in bun.lock's workspace entry and in the quick start's archive names. Publish
// the pushed release with `repo-kit publish`.
//
//   repo-kit release sid-kit:minor                 a package under packages/
//   repo-kit release minor                         the only released package
//   repo-kit release sid-kit:0.27.0 --date=2026-10-01
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { formatChangelog, nextVersion, parseChangelog, setLockfileWorkspaceVersion } from "./changelog.mjs";
import { releasedPackages } from "./config.mjs";

export function cutRelease(changelog, { version, date }) {
  const parsed = parseChangelog(changelog);
  if (parsed.errors.length) throw new Error(`changelog is malformed:\n  ${parsed.errors.join("\n  ")}`);
  if (!parsed.unreleased.trim()) throw new Error('"## Unreleased" has no entries to release');
  return formatChangelog({
    ...parsed,
    unreleased: "",
    releases: [{ version, date, body: parsed.unreleased }, ...parsed.releases],
  });
}

export function today(now = new Date()) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, "0")).join("-");
}

/** Pairs each request ("<dir>:<level>" or a bare level for the only package) with its package. */
export function releaseRequests(requests, packages) {
  return requests.map(request => {
    const [first, second] = request.split(":");
    const [directory, level] = second === undefined ? [undefined, first] : [first, second];
    const pkg = directory === undefined
      ? (packages.length === 1 ? packages[0] : undefined)
      : packages.find(candidate => candidate.path === `packages/${directory}`);
    if (!pkg || !level) {
      const names = packages.filter(candidate => candidate.workspace).map(candidate => candidate.path.slice("packages/".length));
      throw new Error(`Expected ${names.length ? `<${names.join("|")}>:<level>` : "<level>"}, got ${request}`);
    }
    return { pkg, level };
  });
}

export async function runRelease(config, args) {
  const date = args.find(arg => arg.startsWith("--date="))?.slice("--date=".length) ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  const requests = args.filter(arg => !arg.startsWith("--"));
  if (!requests.length) {
    console.error("Usage: bun run release -- [<package>:]<patch|minor|major|x.y.z> [...] [--date=YYYY-MM-DD]");
    return 1;
  }
  const { root } = config;
  // Validate every package before writing any of them.
  const planned = releaseRequests(requests, releasedPackages(root)).map(({ pkg, level }) => {
    const manifestPath = path.join(pkg.dir, "package.json");
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    const version = nextVersion(pkg.version, level);
    const changelogPath = path.join(pkg.dir, "CHANGELOG.md");
    const changelog = cutRelease(fs.readFileSync(changelogPath, "utf8"), { version, date });
    return { pkg, manifestPath, manifestText, version, changelogPath, changelog };
  });

  const lockfilePath = path.join(root, "bun.lock");
  let lockfile = fs.existsSync(lockfilePath) ? fs.readFileSync(lockfilePath, "utf8") : undefined;
  let lockfileChanged = false;
  for (const { pkg, manifestPath, manifestText, version, changelogPath, changelog } of planned) {
    fs.writeFileSync(changelogPath, changelog);
    fs.writeFileSync(manifestPath, manifestText.replace(`"version": "${pkg.version}"`, `"version": "${version}"`));
    if (pkg.workspace && lockfile !== undefined) {
      lockfile = setLockfileWorkspaceVersion(lockfile, pkg.path, version);
      lockfileChanged = true;
    }
    console.log(`${pkg.name} ${pkg.version} -> ${version} (${date})`);
  }
  if (lockfileChanged) fs.writeFileSync(lockfilePath, lockfile);
  // The quick start names each archive by version.
  const quickStartPath = config.changelog.quickStart && path.join(root, config.changelog.quickStart);
  if (quickStartPath && fs.existsSync(quickStartPath)) {
    let quickStart = fs.readFileSync(quickStartPath, "utf8");
    for (const { pkg, version } of planned) {
      const archive = pkg.name.replace("@", "").replace("/", "-");
      quickStart = quickStart.replaceAll(`${archive}-${pkg.version}.tgz`, `${archive}-${version}.tgz`);
    }
    fs.writeFileSync(quickStartPath, quickStart);
  }
  await config.release.afterCut?.({ root, released: planned.map(({ pkg, version }) => ({ ...pkg, previous: pkg.version, version })) });
  if (lockfileChanged) execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
  return 0;
}
