import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { accepts, contextPlatform, findVerified, hostPlatform, labelsAllow, parsePlans, runVerifiedTree } from "../src/verified-tree.mjs";

const REPO = "owner/library";
const TREE = "t".repeat(40);
const OTHER_TREE = "u".repeat(40);
const sha = c => c.repeat(40);

/**
 * A GitHub API fixture: commits with their tree, the branches listing them
 * newest first, and each commit's statuses and check runs.
 */
function github({ commits, branches = {}, statuses = {}, checkRuns = {}, failing = [] }) {
  const calls = [];
  const jobs = new Map();
  const jobId = run => {
    for (const [id, known] of jobs) if (known === run) return id;
    jobs.set(jobs.size + 1, run);
    return jobs.size;
  };
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer token");
    const { pathname, searchParams } = new URL(url);
    const reply = (status, body) => ({ ok: status < 300, status, statusText: String(status), json: async () => body });
    if (failing.some(part => pathname.includes(part))) return reply(500, { message: "down" });
    const prefix = `/repos/${REPO}`;
    assert.ok(pathname.startsWith(prefix), url);
    const rest = pathname.slice(prefix.length);
    let match;
    if (rest === "/commits") {
      const listed = branches[searchParams.get("sha")];
      if (!listed) return reply(404, { message: "No commit found for SHA" });
      const page = Number(searchParams.get("page") ?? 1), per = Number(searchParams.get("per_page"));
      return reply(200, listed.slice((page - 1) * per, page * per).map(id => ({ sha: id, commit: { tree: { sha: commits[id] } } })));
    }
    if ((match = rest.match(/^\/commits\/(\w+)$/))) {
      return commits[match[1]] ? reply(200, { sha: match[1], commit: { tree: { sha: commits[match[1]] } } }) : reply(422, { message: "No commit found" });
    }
    if ((match = rest.match(/^\/commits\/(\w+)\/statuses$/))) return reply(200, statuses[match[1]] ?? []);
    if ((match = rest.match(/^\/commits\/(\w+)\/check-runs$/))) {
      assert.equal(searchParams.get("filter"), "latest");
      return reply(200, { check_runs: (checkRuns[match[1]] ?? []).map(run => ({ app: { slug: "github-actions" }, ...run, id: jobId(run) })) });
    }
    // An Actions check run is a job of a workflow run: which workflow file, event and branch.
    if ((match = rest.match(/^\/actions\/jobs\/(\d+)$/))) return reply(200, { id: Number(match[1]), run_id: Number(match[1]), labels: jobs.get(Number(match[1])).labels ?? [] });
    if ((match = rest.match(/^\/actions\/runs\/(\d+)$/))) {
      const run = jobs.get(Number(match[1]));
      return reply(200, { path: ".github/workflows/check.yml", event: "push", head_branch: "main", pull_requests: [], ...run.run });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls };
}

// The workflow looking: a main push of check.yml, so verify runs with --release.
const workflow = { path: ".github/workflows/check.yml", release: true };
const plans = { verify: ["check / verify", "Library checks (local*"], browser: ["browser / browser + stories"] };
// The platform the looked-up checks run on: a result counts only from the same one.
const platform = "linux-x64";

test("plans are a JSON object of names to accepted check names or status contexts", () => {
  assert.deepEqual(parsePlans('{"verify": ["check / verify"]}'), { verify: ["check / verify"] });
  assert.throws(() => parsePlans(""), /REPO_KIT_PLANS/);
  assert.throws(() => parsePlans("[]"), /object/);
  assert.throws(() => parsePlans('{"verify": []}'), /verify/);
  assert.throws(() => parsePlans('{"verify": "check / verify"}'), /verify/);
});

test("a name is accepted exactly, or by the prefix before a trailing *", () => {
  assert.ok(accepts(["check / verify"], "check / verify"));
  assert.ok(!accepts(["check / verify"], "check / verify extra"));
  assert.ok(accepts(["Library checks (local*"], "Library checks (local, macOS)"));
  assert.ok(!accepts(["Library checks (local*"], "Library checks"));
});

test("a commit on another branch with the same tree and a passed check verifies the plan, with a link", async () => {
  // main's merge of dev: a new commit, the same tree dev passed on.
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE, [sha("c")]: OTHER_TREE },
    branches: { main: [sha("a"), sha("c")], dev: [sha("b"), sha("c")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "https://github.com/owner/library/runs/1" }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main", "dev"], token: "token", fetcher, workflow });
  assert.equal(result.tree, TREE);
  assert.deepEqual(result.plans.verify, { sha: sha("b"), check: "check / verify", url: "https://github.com/owner/library/runs/1" });
  assert.equal(result.plans.browser, null, "a plan nothing passed still runs");
});

test("the same tree with a failed, cancelled or still running check runs again", async () => {
  for (const conclusion of ["failure", "cancelled", null]) {
    const { fetcher } = github({
      commits: { [sha("a")]: TREE, [sha("b")]: TREE },
      branches: { main: [sha("a"), sha("b")] },
      checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion, html_url: "x" }] },
    });
    const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow });
    assert.equal(result.plans.verify, null, String(conclusion));
  }
});

test("a different tree never reuses, even with every check passed", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: OTHER_TREE },
    branches: { main: [sha("a"), sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "x" }, { name: "browser / browser + stories", conclusion: "success", html_url: "y" }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow });
  assert.deepEqual(result.plans, { verify: null, browser: null });
});

test("a changed plan never reuses: another check's success does not count", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a"), sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "browser / browser + stories + keyboard", conclusion: "success", html_url: "x" }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow });
  assert.equal(result.plans.browser, null);
});

test("the local release gate's newest status counts; an older success under a newer failure does not", async () => {
  const gate = (state, url) => ({ context: "Library checks (local, linux-x64)", state, target_url: url });
  const passed = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a"), sha("b")] },
    statuses: { [sha("b")]: [gate("success", "https://example.invalid/gate")] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher: passed.fetcher, workflow, platform });
  assert.deepEqual(result.plans.verify, { sha: sha("b"), check: "Library checks (local, linux-x64)", url: "https://example.invalid/gate" });

  const failedSince = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a"), sha("b")] },
    statuses: { [sha("b")]: [gate("failure"), gate("success")] },
  });
  const again = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher: failedSince.fetcher, workflow, platform });
  assert.equal(again.plans.verify, null);
});

test("a status without a link points at the commit", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a"), sha("b")] },
    statuses: { [sha("b")]: [{ context: "Library checks (local, linux-x64)", state: "success", target_url: null }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow, platform });
  assert.equal(result.plans.verify.url, `https://github.com/${REPO}/commit/${sha("b")}`);
});

test("the commit itself counts: a nightly run on an unchanged main skips what passed the night before", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE },
    branches: { main: [sha("a")] },
    checkRuns: { [sha("a")]: [{ name: "browser / browser + stories", conclusion: "success", html_url: "https://github.com/owner/library/runs/9" }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow });
  assert.equal(result.plans.browser.url, "https://github.com/owner/library/runs/9");
});

test("a pull request's head counts as a candidate, and a missing branch is skipped", async () => {
  const { fetcher } = github({
    commits: { [sha("m")]: TREE, [sha("h")]: TREE },
    branches: { main: [] },
    checkRuns: { [sha("h")]: [{ name: "check / verify", conclusion: "success", html_url: "h" }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("m"), extra: [sha("h")], plans, branches: ["main", "dev"], token: "token", fetcher, workflow });
  assert.equal(result.plans.verify.sha, sha("h"));
});

test("the lookup stops reading once every plan is verified and reads each commit's results once", async () => {
  const { fetcher, calls } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE, [sha("c")]: TREE },
    branches: { main: [sha("a"), sha("b"), sha("c")], dev: [sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "1" }, { name: "browser / browser + stories", conclusion: "success", html_url: "2" }] },
  });
  await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main", "dev"], token: "token", fetcher, workflow });
  assert.ok(!calls.some(url => url.includes(sha("c"))), calls.join("\n"));
  assert.equal(calls.filter(url => url.includes(`${sha("b")}/check-runs`)).length, 1);
});

test("depth bounds how many commits of each branch are compared", async () => {
  const listed = [sha("a"), ...Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(40, "0"))];
  const commits = Object.fromEntries(listed.map(id => [id, OTHER_TREE]));
  commits[sha("a")] = TREE;
  const { fetcher, calls } = github({ commits, branches: { main: listed } });
  await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], depth: 120, token: "token", fetcher, workflow });
  assert.deepEqual(calls.filter(url => url.includes("/commits?")).map(url => new URL(url).searchParams.get("page")), ["1", "2"]);
});

test("a tree is verified only for the platform it was checked on: a Mac result never stands for Linux", async () => {
  const lookup = async (context, asking) => {
    const { fetcher } = github({
      commits: { [sha("a")]: TREE, [sha("b")]: TREE },
      branches: { main: [sha("a"), sha("b")] },
      statuses: { [sha("b")]: [{ context, state: "success", target_url: "gate" }] },
    });
    const accepting = { verify: ["Library checks (local*", "verified-tree/*"] };
    return (await findVerified({ repository: REPO, sha: sha("a"), plans: accepting, branches: ["main"], token: "token", fetcher, workflow, platform: asking })).plans.verify;
  };
  const rows = [
    // [status context, platform asking, reused]
    ["Library checks (local, darwin-arm64)", "darwin-arm64", true],  // same platform: the second run is skipped
    ["Library checks (local, darwin-arm64)", "linux-x64", false],    // the Mac gate does not excuse the Linux run
    ["Library checks (local, linux-arm64)", "linux-x64", false],     // nor does another architecture
    ["Library checks (local, linux-x64)", "linux-x64", true],
    ["verified-tree/linux-x64", "linux-x64", true],
    ["verified-tree/linux-x64", "darwin-arm64", false],
    // The deprecated context of repo-kit 0.6.0 and older (the gate still writes it beside the new one until the
    // next batched minor) names the OS only: it counts for that OS on any architecture.
    ["Library checks (local, macOS)", "darwin-arm64", true],
    ["Library checks (local, macOS)", "darwin-x64", true],
    ["Library checks (local, macOS)", "linux-x64", false],
    ["Library checks (local, Linux)", "linux-x64", true],
    ["Library checks (local, Linux)", "darwin-arm64", false],
    ["Library checks (local, Plan9)", "linux-x64", false],
  ];
  for (const [context, asking, reused] of rows) assert.equal(Boolean(await lookup(context, asking)), reused, `${context} asked from ${asking}`);
});

test("a 0.6.1 gate writes both contexts: the old one then counts only where the new one names no platform", async () => {
  const lookup = async (contexts, asking) => {
    const { fetcher } = github({
      commits: { [sha("a")]: TREE, [sha("b")]: TREE },
      branches: { main: [sha("a"), sha("b")] },
      statuses: { [sha("b")]: contexts.map(context => ({ context, state: "success", target_url: context })) },
    });
    const accepting = { verify: ["Library checks (local*"] };
    return (await findVerified({ repository: REPO, sha: sha("a"), plans: accepting, branches: ["main"], token: "token", fetcher, workflow, platform: asking })).plans.verify;
  };
  const intel = ["Library checks (local, darwin-x64)", "Library checks (local, macOS)"];
  assert.equal(await lookup(intel, "darwin-arm64"), null, "an Intel Mac's gate does not stand for Apple silicon");
  assert.equal((await lookup(intel, "darwin-x64")).check, "Library checks (local, darwin-x64)");
  assert.equal(await lookup(["Library checks (local, linux-arm64)", "Library checks (local, Linux)"], "linux-x64"), null);
  // A 0.6.0 gate wrote the old context alone.
  assert.equal((await lookup(["Library checks (local, macOS)"], "darwin-arm64")).check, "Library checks (local, macOS)");
});

test("a status context names its platform at its end, after a slash or in the gate's parentheses", () => {
  assert.equal(contextPlatform("Library checks (local, darwin-arm64)"), "darwin-arm64");
  assert.equal(contextPlatform("verified-tree/linux-x64"), "linux-x64");
  assert.equal(contextPlatform("Library checks (local, macOS)"), "darwin-*");
  assert.equal(contextPlatform("Library checks (local, Linux)"), "linux-*");
  assert.equal(contextPlatform("Library checks (local, Windows)"), "win32-*");
  assert.equal(contextPlatform("verified-tree (macOS)"), null);
  assert.equal(contextPlatform("check / verify"), null);
  assert.equal(contextPlatform("deploy"), null);
  assert.equal(contextPlatform("Library checks (local, linux-x64"), null);
  assert.equal(contextPlatform("verified-tree/linux-x64)"), null);
  assert.equal(contextPlatform("lint, linux-x64"), null);
});

test("a check run counts only when its job's runner labels do not name another platform", async () => {
  const table = [
    // [labels, platform asking, allowed]
    [[], "linux-x64", true],
    [["self-hosted", "homelab"], "linux-x64", true],          // the same workflow file at the same tree: its runner
    [["ubuntu-latest"], "linux-x64", true],
    [["ubuntu-latest"], "darwin-arm64", false],
    [["ubuntu-latest"], "linux-arm64", false],                // GitHub's hosted images imply their architecture
    [["macos-15"], "darwin-arm64", true],
    [["macos-13"], "darwin-arm64", false],
    [["macos-15-intel"], "darwin-x64", true],
    [["macos-15-large"], "darwin-arm64", false],
    [["windows-latest"], "win32-arm64", false],
    [["windows-11-arm"], "win32-arm64", true],
    [["ubuntu-24.04-arm"], "linux-x64", false],
    [["ubuntu-24.04-arm"], "linux-arm64", true],
    [["macos-15"], "linux-x64", false],
    [["self-hosted", "Linux", "X64"], "linux-x64", true],
    [["self-hosted", "macOS", "ARM64"], "linux-x64", false],
    [["self-hosted", "Linux", "ARM64"], "linux-x64", false],
    [["windows-latest"], "win32-x64", true],
  ];
  for (const [labels, asking, allowed] of table) assert.equal(labelsAllow(labels, asking), allowed, `${labels} for ${asking}`);
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a"), sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "x", labels: ["macos-15"] }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow, platform });
  assert.equal(result.plans.verify, null);
  // Without the caller's workflow (no GITHUB_WORKFLOW_REF) the labels still decide.
  const unknown = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, platform });
  assert.equal(unknown.plans.verify, null);
});

test("the host platform is Node's <os>-<arch>", () => {
  assert.equal(hostPlatform(), `${process.platform}-${process.arch}`);
});

function outputs(env) {
  return Object.fromEntries(fs.readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
}

function actionEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-tree-"));
  return {
    GITHUB_OUTPUT: path.join(dir, "output"), GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
    GITHUB_REPOSITORY: REPO, GITHUB_SHA: sha("a"), GITHUB_TOKEN: "token",
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/check.yml@refs/heads/main`, GITHUB_REF: "refs/heads/main",
    REPO_KIT_PLANS: JSON.stringify(plans), REPO_KIT_BRANCHES: '["main", "dev"]', ...extra,
  };
}

test("in a workflow it writes the urls output and a summary line per plan", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a")], dev: [sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "https://github.com/owner/library/runs/1" }] },
  });
  const env = actionEnv();
  assert.equal(await runVerifiedTree(env, fetcher), 0);
  assert.deepEqual(JSON.parse(outputs(env).urls), { verify: "https://github.com/owner/library/runs/1", browser: "" });
  assert.equal(outputs(env).tree, TREE);
  assert.equal(outputs(env).platform, hostPlatform());
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, new RegExp(`for ${hostPlatform()}`));
  assert.match(summary, /verify: reused: .*check \/ verify.*bbbbbbb.*runs\/1/);
  assert.match(summary, /browser: runs: no passed result/);
});

test("when GitHub cannot answer, every plan runs: the lookup never fails a workflow", async () => {
  const { fetcher } = github({ commits: { [sha("a")]: TREE }, failing: ["/commits"] });
  const env = actionEnv();
  assert.equal(await runVerifiedTree(env, fetcher), 0);
  assert.deepEqual(JSON.parse(outputs(env).urls), { verify: "", browser: "" });
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /lookup failed.*every plan runs/);
});

test("bad plans fail the step: a typo must not silently run or skip", async () => {
  const env = actionEnv({ REPO_KIT_PLANS: "{" });
  assert.equal(await runVerifiedTree(env, async () => assert.fail("no request")), 1);
});

test("a check run counts only from the same workflow file, by GitHub Actions, in the same release mode", async () => {
  const lookup = runs => {
    const { fetcher } = github({
      commits: { [sha("a")]: TREE, [sha("b")]: TREE },
      branches: { main: [sha("a"), sha("b")] },
      checkRuns: { [sha("b")]: runs.map(extra => ({ name: "check / verify", conclusion: "success", html_url: "x", ...extra })) },
    });
    return findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["main"], token: "token", fetcher, workflow }).then(result => result.plans.verify);
  };
  // Another workflow with a job of the same name ran something else.
  assert.equal(await lookup([{ run: { path: ".github/workflows/light.yml" } }]), null);
  // Another app reported a check of that name.
  assert.equal(await lookup([{ app: { slug: "some-app" } }]), null);
  // A pull request into dev ran verify without --release; main needs it.
  assert.equal(await lookup([{ run: { event: "pull_request", head_branch: "feature", pull_requests: [{ base: { ref: "dev" } }] } }]), null);
  // A pull request into main ran it with --release.
  assert.ok(await lookup([{ run: { event: "pull_request", head_branch: "feature", pull_requests: [{ base: { ref: "main" } }] } }]));
  // A nightly or manual run on main did too.
  assert.ok(await lookup([{ run: { event: "schedule" } }]));
  // A tag push did not.
  assert.equal(await lookup([{ run: { event: "push", head_branch: "v1.0.0" } }]), null);
});

test("outside a release-mode run, only results without --release count", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { dev: [sha("a"), sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "x", run: { event: "pull_request", head_branch: "f", pull_requests: [{ base: { ref: "dev" } }] } }] },
  });
  const result = await findVerified({ repository: REPO, sha: sha("a"), plans, branches: ["dev"], token: "token", fetcher, workflow: { ...workflow, release: false } });
  assert.ok(result.plans.verify);
});

test("REPO_KIT_PLATFORM names the platform the checks run on, and a malformed one fails the step", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a")], dev: [sha("b")] },
    statuses: { [sha("b")]: [{ context: "Library checks (local, darwin-arm64)", state: "success", target_url: "gate" }] },
  });
  const linux = actionEnv({ REPO_KIT_PLATFORM: "linux-x64" });
  assert.equal(await runVerifiedTree(linux, fetcher), 0);
  assert.deepEqual(JSON.parse(outputs(linux).urls), { verify: "", browser: "" });
  assert.equal(outputs(linux).platform, "linux-x64");
  const mac = actionEnv({ REPO_KIT_PLATFORM: "darwin-arm64" });
  assert.equal(await runVerifiedTree(mac, fetcher), 0);
  assert.equal(JSON.parse(outputs(mac).urls).verify, "gate");
  assert.equal(await runVerifiedTree(actionEnv({ REPO_KIT_PLATFORM: "Linux" }), async () => assert.fail("no request")), 1);
});

test("force runs every plan without asking GitHub", async () => {
  const env = actionEnv({ REPO_KIT_FORCE: "true" });
  assert.equal(await runVerifiedTree(env, async () => assert.fail("no request")), 0);
  assert.deepEqual(JSON.parse(outputs(env).urls), { verify: "", browser: "" });
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /forced: every plan runs/);
});

test("the workflow's own file and release mode come from the Actions environment", async () => {
  const { fetcher } = github({
    commits: { [sha("a")]: TREE, [sha("b")]: TREE },
    branches: { main: [sha("a")], dev: [sha("b")] },
    checkRuns: { [sha("b")]: [{ name: "check / verify", conclusion: "success", html_url: "u", run: { path: ".github/workflows/other.yml" } }] },
  });
  const env = actionEnv({ GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/other.yml@refs/heads/main`, GITHUB_REF: "refs/heads/main" });
  assert.equal(await runVerifiedTree(env, fetcher), 0);
  assert.equal(JSON.parse(outputs(env).urls).verify, "u");
});
