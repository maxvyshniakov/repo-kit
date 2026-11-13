import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  lockfileWorkspaceVersion,
  nextVersion,
  parseChangelog,
  satisfiesCaret,
  setLockfileWorkspaceVersion,
} from "../src/changelog.mjs";
import { changelogIssues, changelogPackages, peerIssues, runCheckChangelogs } from "../src/check-changelogs.mjs";
import { withDefaults } from "../src/config.mjs";
import { releasedPackages } from "../src/config.mjs";
import { cutRelease, releaseRequests, runRelease } from "../src/release.mjs";
import { chooseVersionSource, pyprojectProject, setPyprojectVersion } from "../src/version-source.mjs";
import { changelog, kitRoot, pyproject, pyprojectFiles, rootPackageFiles, tempRepository, workspaceFiles } from "./fixtures.mjs";

const lockfile = `{
  "workspaces": {
    "packages/example": {
      "name": "@maxvyshniakov/example",
      "version": "0.2.0",
      "dependencies": {},
    },
  },
}
`;

const quiet = fn => {
  const { log, error } = console;
  const restore = () => Object.assign(console, { log, error });
  console.log = console.error = () => {};
  let result;
  try {
    result = fn();
  } catch (thrown) {
    restore();
    throw thrown;
  }
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
};

test("repo-kit's own changelog matches its package.json", () => {
  for (const pkg of changelogPackages(kitRoot)) assert.deepEqual(changelogIssues(pkg), [], pkg.name);
});

test("satisfiesCaret follows npm caret ranges, including below 1.0.0", () => {
  assert.equal(satisfiesCaret("^0.26.1", "0.26.1"), true);
  assert.equal(satisfiesCaret("^0.26.1", "0.26.9"), true);
  assert.equal(satisfiesCaret("^0.26.1", "0.26.0"), false);
  assert.equal(satisfiesCaret("^0.26.1", "0.27.0"), false);
  assert.equal(satisfiesCaret("^0.0.3", "0.0.3"), true);
  assert.equal(satisfiesCaret("^0.0.3", "0.0.4"), false);
  assert.equal(satisfiesCaret("^1.2.3", "1.9.0"), true);
  assert.equal(satisfiesCaret("^1.2.3", "2.0.0"), false);
  assert.throws(() => satisfiesCaret(">=0.26.1", "0.26.1"), /\^x\.y\.z/);
});

test("a peer range that excludes a workspace package's version fails", () => {
  const sidKit = { name: "@maxvyshniakov/sid-kit", version: "0.27.0" };
  const grid = { name: "@maxvyshniakov/data-grid", peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.1", react: "^19.2.8" } };
  assert.match(peerIssues(grid, [sidKit, grid]).join("\n"), /peer range \^0.26.1 for @maxvyshniakov\/sid-kit excludes its version 0.27.0/);
  assert.deepEqual(peerIssues(grid, [{ ...sidKit, version: "0.26.4" }, grid]), []);
  const loose = { ...grid, peerDependencies: { "@maxvyshniakov/sid-kit": "*" } };
  assert.match(peerIssues(loose, [sidKit, loose]).join("\n"), /use a \^x\.y\.z range/);
});

test("a peer range must include the exact devDependency the package is tested against", () => {
  const grid = {
    name: "@maxvyshniakov/data-grid",
    peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.1", react: "^19.2.8" },
    devDependencies: { "@maxvyshniakov/sid-kit": "0.27.0", react: "19.2.8" },
  };
  assert.match(peerIssues(grid, [grid]).join("\n"), /peer range \^0.26.1 for @maxvyshniakov\/sid-kit excludes its version 0.27.0/);
  assert.deepEqual(peerIssues({ ...grid, devDependencies: { "@maxvyshniakov/sid-kit": "0.26.2" } }, [grid]), []);
  // A ranged devDependency names no single tested version, so it is not compared.
  assert.deepEqual(peerIssues({ ...grid, devDependencies: { "@maxvyshniakov/sid-kit": "^0.27.0" } }, [grid]), []);
  // Peers outside the scope (react here) are not compared.
  assert.deepEqual(peerIssues({ ...grid, peerDependencies: { react: "^18.0.0" } }, [grid]), []);
  assert.match(peerIssues({ ...grid, peerDependencies: { react: "^18.0.0" } }, [grid], { scope: "" }).join("\n"), /react excludes its version 19.2.8/);
});

test("nextVersion follows the requested level", () => {
  assert.equal(nextVersion("0.22.4", "patch"), "0.22.5");
  assert.equal(nextVersion("0.22.4", "minor"), "0.23.0");
  assert.equal(nextVersion("0.22.4", "major"), "1.0.0");
  assert.equal(nextVersion("0.22.4", "0.30.0"), "0.30.0");
  assert.throws(() => nextVersion("0.22.4", "0.22.4"), /not above/);
  assert.throws(() => nextVersion("0.22.4", "big"), /Unknown release level/);
});

test("cutRelease moves Unreleased entries under the new version", () => {
  const parsed = parseChangelog(cutRelease(changelog, { version: "0.2.1", date: "2026-10-01" }));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.unreleased, "");
  assert.deepEqual(parsed.releases.map(release => release.version), ["0.2.1", "0.2.0", "0.1.0"]);
  assert.match(parsed.releases[0].body, /Fixed a thing/);
  assert.throws(() => cutRelease(cutRelease(changelog, { version: "0.2.1", date: "2026-10-01" }), { version: "0.2.2", date: "2026-10-02" }), /no entries to release/);
});

test("a manifest, lockfile or quick-start version that disagrees with the changelog fails", () => {
  const pkg = { name: "@maxvyshniakov/example", version: "0.2.0", changelog, lockedVersion: "0.2.0", archiveVersions: ["0.2.0"] };
  assert.deepEqual(changelogIssues(pkg), []);
  assert.match(changelogIssues({ ...pkg, version: "0.2.1" }).join("\n"), /package.json version 0.2.1 does not match the newest changelog release 0.2.0/);
  assert.match(changelogIssues({ ...pkg, lockedVersion: "0.1.0" }).join("\n"), /bun.lock records 0.1.0/);
  assert.match(changelogIssues({ ...pkg, archiveVersions: ["0.1.0"] }).join("\n"), /GETTING_STARTED.md names the 0.1.0 archive/);
  assert.match(changelogIssues({ ...pkg, changelog: undefined }).join("\n"), /missing CHANGELOG.md/);
  assert.match(changelogIssues({ ...pkg, name: "@maxvyshniakov/other" }).join("\n"), /title must be "# @maxvyshniakov\/other Changelog"/);
});

test("an Unreleased Breaking entry must say why no transition period was possible", () => {
  const pkg = { name: "@maxvyshniakov/example", version: "0.2.0" };
  const withBreaking = entries => changelog.replace("## Unreleased\n", `## Unreleased\n\n### Breaking\n\n${entries}\n`);
  const bare = changelogIssues({ ...pkg, changelog: withBreaking("- Removed the `size` prop.") });
  assert.match(bare.join("\n"), /line 9: a Breaking entry needs a line "No transition period: <why>"/);
  assert.deepEqual(changelogIssues({ ...pkg, changelog: withBreaking("- Removed the `size` prop.\n  No transition period: the prop crashes every caller that sets it.") }), []);
  // Each entry needs its own reason; an empty one does not count.
  const second = changelogIssues({ ...pkg, changelog: withBreaking("- One.\n  No transition period: a reason.\n- Two.\n  No transition period:") });
  assert.equal(second.length, 1);
  assert.match(second[0], /line 11: .*"- Two\."/);
  // Released sections keep their history; only Unreleased is checked.
  assert.deepEqual(changelogIssues({ ...pkg, changelog }), []);
  assert.match(changelog, /## 0\.2\.0[^]*### Breaking/);
});

test("the release gate requires an empty Unreleased section", () => {
  const pkg = { name: "@maxvyshniakov/example", version: "0.2.0", changelog };
  assert.match(changelogIssues(pkg, { release: true }).join("\n"), /"## Unreleased" has entries/);
  const released = cutRelease(changelog, { version: "0.2.1", date: "2026-09-25" });
  assert.deepEqual(changelogIssues({ ...pkg, version: "0.2.1", changelog: released }, { release: true }), []);
});

test("the pre-2026-09-25 layout, two titles and two Unreleased sections, fails", () => {
  const legacy = `# Changelog

## Unreleased

- New entry.

# @maxvyshniakov/example Changelog

## Unreleased

### Changed

- Older entry.

## 0.1.0 - 2026-09-01

- First release.
`;
  const issues = changelogIssues({ name: "@maxvyshniakov/example", version: "0.2.0", changelog: legacy }).join("\n");
  assert.match(issues, /expected one "# " title, found 2/);
  assert.match(issues, /duplicate "## Unreleased"/);
  assert.match(issues, /package.json version 0.2.0 does not match the newest changelog release 0.1.0/);
});

test("release order, dates, headings and sections are checked", () => {
  const disorder = changelog.replace("## 0.1.0 - 2026-09-01", "## 0.3.0 - 2026-09-01");
  assert.match(parseChangelog(disorder).errors.join("\n"), /0.3.0 must be older than 0.2.0/);
  const dated = changelog.replace("## 0.1.0 - 2026-09-01", "## 0.1.0 - 2026-09-30");
  assert.match(parseChangelog(dated).errors.join("\n"), /0.2.0 is dated before 0.1.0/);
  const heading = changelog.replace("## 0.1.0 - 2026-09-01", "## 0.1.0");
  assert.match(parseChangelog(heading).errors.join("\n"), /expected "## Unreleased" or "## x.y.z - YYYY-MM-DD"/);
  const section = changelog.replace("### Fixed", "### Improvements");
  assert.match(parseChangelog(section).errors.join("\n"), /unknown section "Improvements"/);
  const late = changelog.replace("## Unreleased\n", "").replace("## 0.1.0", "## Unreleased\n\n## 0.1.0");
  assert.match(parseChangelog(late).errors.join("\n"), /must be the first section/);
});

test("bun.lock workspace versions are read and replaced in place", () => {
  assert.equal(lockfileWorkspaceVersion(lockfile, "packages/example"), "0.2.0");
  const updated = setLockfileWorkspaceVersion(lockfile, "packages/example", "0.3.0");
  assert.equal(lockfileWorkspaceVersion(updated, "packages/example"), "0.3.0");
  assert.equal(updated.replace("0.3.0", "0.2.0"), lockfile);
  assert.throws(() => setLockfileWorkspaceVersion(lockfile, "packages/missing", "1.0.0"), /no workspace entry/);
});

test("release requests name a package under packages/, or only a level for the only package", () => {
  const sidKit = { path: "packages/sid-kit", workspace: true };
  const grid = { path: "packages/data-grid", workspace: true };
  const root = { path: ".", workspace: false };
  assert.deepEqual(releaseRequests(["sid-kit:minor"], [grid, sidKit]), [{ pkg: sidKit, level: "minor" }]);
  assert.deepEqual(releaseRequests(["minor"], [root]), [{ pkg: root, level: "minor" }]);
  assert.deepEqual(releaseRequests(["patch"], [sidKit]), [{ pkg: sidKit, level: "patch" }]);
  assert.throws(() => releaseRequests(["minor"], [grid, sidKit]), /Expected <data-grid\|sid-kit>:<level>, got minor/);
  assert.throws(() => releaseRequests(["missing:minor"], [grid, sidKit]), /got missing:minor/);
});

for (const [kind, files, changelogPath, manifestPath] of [
  ["a root package", rootPackageFiles(), "CHANGELOG.md", "package.json"],
  ["a workspace package", workspaceFiles(), "packages/example/CHANGELOG.md", "packages/example/package.json"],
]) {
  test(`check-changelogs and release work for ${kind}`, async () => {
    const repository = tempRepository(files);
    try {
      const config = withDefaults({});
      config.root = repository.root;
      assert.equal(quiet(() => runCheckChangelogs(config)), true);
      assert.equal(quiet(() => runCheckChangelogs(config, { release: true })), false);
      const request = kind === "a root package" ? "minor" : "example:minor";
      // bun install would need a real workspace; the lockfile text is what the release changes.
      const lockfileBefore = fs.existsSync(path.join(repository.root, "bun.lock"));
      if (lockfileBefore) config.release = { afterCut() { throw Object.assign(new Error("stop before bun install"), { stop: true }); } };
      await quiet(() => runRelease(config, [request, "--date=2026-11-03"])).catch(error => {
        if (!error.stop) throw error;
      });
      assert.equal(JSON.parse(fs.readFileSync(path.join(repository.root, manifestPath), "utf8")).version, "0.3.0");
      assert.match(fs.readFileSync(path.join(repository.root, changelogPath), "utf8"), /## Unreleased\n\n## 0.3.0 - 2026-11-03\n\n### Fixed/);
      if (lockfileBefore) {
        assert.equal(lockfileWorkspaceVersion(fs.readFileSync(path.join(repository.root, "bun.lock"), "utf8"), "packages/example"), "0.3.0");
        assert.match(fs.readFileSync(path.join(repository.root, "docs/GETTING_STARTED.md"), "utf8"), /maxvyshniakov-example-0.3.0.tgz/);
      }
      assert.equal(quiet(() => runCheckChangelogs(config, { release: true })), true);
    } finally {
      repository.cleanup();
    }
  });
}

test("a workspace missing from bun.lock fails the release before any file is written", async () => {
  const repository = tempRepository(workspaceFiles({ "bun.lock": "{\n  \"workspaces\": {}\n}\n" }));
  try {
    const config = withDefaults({});
    config.root = repository.root;
    const before = fs.readFileSync(path.join(repository.root, "packages/example/CHANGELOG.md"), "utf8");
    await assert.rejects(quiet(() => runRelease(config, ["example:minor"])), /no workspace entry for packages\/example/);
    assert.equal(fs.readFileSync(path.join(repository.root, "packages/example/CHANGELOG.md"), "utf8"), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repository.root, "packages/example/package.json"), "utf8")).version, "0.2.0");
  } finally {
    repository.cleanup();
  }
});

test("pyproject.toml's [project] version is read and set in place, other tables untouched", () => {
  assert.deepEqual(pyprojectProject(pyproject), { name: "example", version: "0.2.0", versionLine: 6 });
  const updated = setPyprojectVersion(pyproject, "0.3.0");
  assert.equal(updated, pyproject.replace('version = "0.2.0"  # repo-kit', 'version = "0.3.0"  # repo-kit'));
  assert.match(updated, /\[tool\.poetry\]\nversion = "9\.9\.9"/);
  assert.equal(pyprojectProject("[project]\nname = 'single'\nversion = '1.2.3'\n").version, "1.2.3");
  assert.equal(setPyprojectVersion("[project]\nversion = '1.2.3'\n", "1.3.0"), "[project]\nversion = '1.3.0'\n");
  assert.throws(() => pyprojectProject('[project]\nname = "x"\ndynamic = ["version"]\n'), /no static version/);
  assert.throws(() => pyprojectProject('[tool.ruff]\nline-length = 120\n'), /no \[project\] table/);
});

test("the version source is configured, or pyproject.toml when there is no package.json", () => {
  const python = tempRepository(pyprojectFiles());
  const both = tempRepository(rootPackageFiles({ "pyproject.toml": pyproject }));
  try {
    assert.equal(chooseVersionSource(python.root), "pyproject.toml");
    assert.equal(chooseVersionSource(both.root), "package.json");
    assert.equal(chooseVersionSource(both.root, "pyproject.toml"), "pyproject.toml");
    assert.throws(() => chooseVersionSource(both.root, "setup.cfg"), /must be package.json or pyproject.toml/);
    assert.deepEqual(releasedPackages(python.root).map(({ name, version, manifestFile, path }) => ({ name, version, manifestFile, path })),
      [{ name: "example", version: "0.2.0", manifestFile: "pyproject.toml", path: "." }]);
    assert.throws(() => releasedPackages(tempRepository({}).root), /pyproject.toml not found; set changelog.versionSource/);
  } finally {
    python.cleanup();
    both.cleanup();
  }
});

for (const [kind, files, versionSource] of [
  ["a Python package without package.json", pyprojectFiles(), undefined],
  ["pyproject.toml chosen beside a tooling package.json", pyprojectFiles({ "package.json": { name: "tooling", private: true } }), "pyproject.toml"],
]) {
  test(`check-changelogs and release work for ${kind}`, async () => {
    const repository = tempRepository(files);
    try {
      const config = withDefaults({ changelog: { versionSource } });
      config.root = repository.root;
      assert.equal(quiet(() => runCheckChangelogs(config)), true);
      assert.equal(quiet(() => runCheckChangelogs(config, { release: true })), false);
      await quiet(() => runRelease(config, ["minor", "--date=2026-11-11"]));
      const text = fs.readFileSync(path.join(repository.root, "pyproject.toml"), "utf8");
      assert.equal(pyprojectProject(text).version, "0.3.0");
      assert.match(text, /\[tool\.poetry\]\nversion = "9\.9\.9"/);
      if (files["package.json"]) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repository.root, "package.json"), "utf8")), { name: "tooling", private: true });
      assert.match(fs.readFileSync(path.join(repository.root, "CHANGELOG.md"), "utf8"), /## Unreleased\n\n## 0.3.0 - 2026-11-11\n\n### Fixed/);
      assert.equal(quiet(() => runCheckChangelogs(config, { release: true })), true);
      // A version that disagrees names pyproject.toml.
      fs.writeFileSync(path.join(repository.root, "pyproject.toml"), setPyprojectVersion(text, "0.3.1"));
      const [pkg] = changelogPackages(repository.root, { versionSource });
      assert.match(changelogIssues(pkg).join("\n"), /pyproject.toml version 0.3.1 does not match the newest changelog release 0.3.0/);
    } finally {
      repository.cleanup();
    }
  });
}

test("the pyproject parser skips multi-line strings and arrays, and refuses a second [project] version", () => {
  const tricky = `[project]
name = "example"
description = """
An example.
version = "9.9.9"
[not.a.table]
"""
readme = \'\'\'
version = '8.8.8'
\'\'\'
dependencies = [
  [
    "nested",
  ],
  "x",
]
version = "0.2.0"

[tool.other]
version = "7.7.7"
`;
  assert.equal(pyprojectProject(tricky).version, "0.2.0");
  assert.equal(pyprojectProject(tricky).versionLine, 16);
  assert.equal(pyprojectProject(setPyprojectVersion(tricky, "0.3.0")).version, "0.3.0");
  assert.match(setPyprojectVersion(tricky, "0.3.0"), /version = "9\.9\.9"\n\[not\.a\.table\]/);
  assert.throws(() => pyprojectProject('[project]\nversion = "1.0.0"\nversion = "1.0.1"\n'), /\[project\] sets version twice \(lines 2 and 3\)/);
});
