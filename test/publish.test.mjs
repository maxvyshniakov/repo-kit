import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatchUrl, notify, notifyAll } from "../src/notify.mjs";
import {
  checksState,
  githubRepository,
  noreplyEmail,
  publishArguments,
  publishBlockers,
  registryUrl,
  resumePublication,
  tagEnvironment,
  tagPushRecovery,
} from "../src/publish.mjs";

const ready = { token: "t", dirty: false, head: "a".repeat(40), upstream: "a".repeat(40), issues: [], tagExists: false, tag: "v0.2.0" };

const quietly = async fn => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn });
  }
};

test("publishing requires a token, a clean HEAD at origin/main, a released changelog and a new tag", () => {
  assert.deepEqual(publishBlockers(ready), []);
  assert.match(publishBlockers({ ...ready, token: undefined }).join("\n"), /GITHUB_TOKEN is not set/);
  assert.match(publishBlockers({ ...ready, dirty: true }).join("\n"), /uncommitted changes/);
  assert.match(publishBlockers({ ...ready, upstream: "b".repeat(40) }).join("\n"), /HEAD aaaaaaaaaaaa is not origin\/main bbbbbbbbbbbb; push the release commit first/);
  assert.match(publishBlockers({ ...ready, issues: ['"## Unreleased" has entries'] }).join("\n"), /CHANGELOG.md: "## Unreleased" has entries/);
  assert.match(publishBlockers({ ...ready, tagExists: true }).join("\n"), /v0.2.0 already exists; .*--resume/);
});

test("a worktree branch or a detached HEAD at origin/main's SHA may publish, as Inline Measure and Text Truncate could not", () => {
  // The branch name is not an input: only SHA equality with origin/main counts.
  assert.deepEqual(publishBlockers({ ...ready, branch: "chore/release" }), []);
  assert.deepEqual(publishBlockers({ ...ready, branch: "" }), []);
  assert.notDeepEqual(publishBlockers({ ...ready, branch: "main", head: "d".repeat(40) }), []);
});

test("bun publish gets the root bunfig.toml after the subcommand", () => {
  // `bun --config <file> publish` exits 0 without publishing anything.
  assert.deepEqual(publishArguments("/repo/bunfig.toml"), ["publish", "--config=/repo/bunfig.toml"]);
  assert.deepEqual(publishArguments(undefined), ["publish"]);
});

test("the registry check reads the scoped package from GitHub Packages", () => {
  assert.equal(registryUrl("@maxvyshniakov/sid-kit"), "https://npm.pkg.github.com/@maxvyshniakov%2fsid-kit");
});

test("publication follows the newest checks run on the release commit", () => {
  assert.equal(checksState([]), "missing");
  assert.equal(checksState([{ status: "in_progress", conclusion: null }]), "running");
  assert.equal(checksState([{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }]), "failed");
  assert.equal(checksState([{ status: "completed", conclusion: "cancelled" }]), "failed");
  assert.equal(checksState([{ status: "completed", conclusion: "success" }]), "passed");
});

test("the GitHub repository comes from the origin URL", () => {
  assert.equal(githubRepository("https://github.com/maxvyshniakov/sid-kit.git"), "maxvyshniakov/sid-kit");
  assert.equal(githubRepository("git@github.com:maxvyshniakov/sid-kit.git"), "maxvyshniakov/sid-kit");
  assert.equal(githubRepository("https://github.com/maxvyshniakov/sid-kit"), "maxvyshniakov/sid-kit");
  assert.throws(() => githubRepository("https://gitlab.com/maxvyshniakov/sid-kit.git"), /not a GitHub repository/);
});

test("--resume publishes, tags or only pushes the tag, and refuses a tag that is not this release's", () => {
  assert.equal(resumePublication({ published: false, tagExists: false, tagMatches: true }), "publish");
  assert.equal(resumePublication({ published: true, tagExists: false, tagMatches: true }), "tag");
  assert.equal(resumePublication({ published: true, tagExists: true, tagMatches: true }), "done");
  assert.throws(() => resumePublication({ published: false, tagExists: true, tagMatches: true }), /do not match/);
  assert.throws(() => resumePublication({ published: true, tagExists: true, tagMatches: false }), /do not match/);
});

test("the tag takes git's identity unless RELEASE_TAGGER_EMAIL names another address", () => {
  const env = { PATH: "/bin" };
  assert.equal(tagEnvironment(env), env);
  assert.deepEqual(tagEnvironment({ ...env, RELEASE_TAGGER_EMAIL: "release@example.com" }), {
    PATH: "/bin",
    RELEASE_TAGGER_EMAIL: "release@example.com",
    GIT_COMMITTER_EMAIL: "release@example.com",
  });
});

test("a declined tag push names the commands that retag as the account's noreply address", () => {
  // GitHub declined Sid-Kit's v0.34.5 with GH007 while the account blocked pushes exposing its private emails.
  const noreply = noreplyEmail({ id: 136558382, login: "maxvyshniakov" });
  assert.equal(noreply, "136558382+maxvyshniakov@users.noreply.github.com");
  assert.deepEqual(tagPushRecovery("v0.2.0", "@maxvyshniakov/sid-kit 0.2.0", noreply), [
    "git tag --delete v0.2.0",
    'GIT_COMMITTER_EMAIL=136558382+maxvyshniakov@users.noreply.github.com git tag --annotate v0.2.0 --message "@maxvyshniakov/sid-kit 0.2.0"',
    "git push origin v0.2.0",
  ]);
});

test("GIT_COMMITTER_EMAIL sets an annotated tag's tagger without touching git config", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "repo-kit-tagger-"));
  try {
    const git = (args, env = {}) => execFileSync("git", args, { cwd: repository, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...env } }).trim();
    git(["init", "--quiet"]);
    git(["config", "user.name", "Release"]);
    git(["config", "user.email", "private@example.com"]);
    git(["commit", "--quiet", "--allow-empty", "--message", "release"]);
    git(["tag", "--annotate", "v1.0.0", "--message", "v1.0.0"], { GIT_COMMITTER_EMAIL: "1+someone@users.noreply.github.com" });
    assert.equal(git(["for-each-ref", "--format=%(taggeremail)", "refs/tags/v1.0.0"]), "<1+someone@users.noreply.github.com>");
    assert.equal(git(["config", "user.email"]), "private@example.com");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("publish runs the TLS gate before the token reaches any request, and notifies only after tagging", () => {
  const source = readFileSync(new URL("../src/publish.mjs", import.meta.url), "utf8");
  const gate = source.indexOf("runTlsGate()");
  assert.ok(gate > 0 && gate < source.indexOf("resolveToken()"), "the gate runs before the token is read");
  const tagPush = source.indexOf('git("push", "origin", tag);\n  } catch');
  const notifyCall = source.indexOf("await notifyAll(config.publish.notify, token)");
  assert.ok(tagPush > 0 && notifyCall > tagPush, "notifications follow the tag push");
});

const dataGrid = { repository: "maxvyshniakov/data-grid", workflow: "update-catalog-dependencies.yml", ref: "main" };

test("publication requests each configured workflow, and a failed request is recoverable", async () => {
  let request;
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async (url, options) => {
    request = { url, options };
    return { ok: true };
  })), true);
  assert.equal(request.url, "https://api.github.com/repos/maxvyshniakov/data-grid/actions/workflows/update-catalog-dependencies.yml/dispatches");
  assert.equal(dispatchUrl(dataGrid), request.url);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(request.options.body), { ref: "main" });
  // The package is already published and tagged: a failed request only warns.
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async () => ({ ok: false, status: 403 }))), false);
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async () => { throw new Error("network down"); })), false);
  assert.equal(await quietly(() => notify(dataGrid, undefined, async () => assert.fail("no request without a token"))), false);
  const requested = [];
  assert.equal(await quietly(() => notifyAll([dataGrid, { ...dataGrid, repository: "maxvyshniakov/other" }], "t", async url => {
    requested.push(url);
    return { ok: !url.includes("data-grid") };
  })), false);
  assert.equal(requested.length, 2, "a failed request does not stop the next one");
});
