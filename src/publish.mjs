// Publishes the released version of the repository's package to the private
// GitHub Packages registry and tags it v<version>. Run on a clean checkout whose
// HEAD is origin/main by SHA (a branch of any name, a worktree or a detached
// HEAD), after `bun run release` was pushed. GITHUB_TOKEN (or `gh auth token`)
// needs write:packages:
//
//   bun run release:publish               TLS gate, the release gate, publish, tag, notify
//   bun run release:publish -- --resume   finish a publication whose tag or tag push failed
//
// The release gate is release.gate in repo-kit.config.mjs (release-gate.mjs):
// "local" (the default) requires a passed `repo-kit release-gate` status on the
// commit; "ci" waits for the checks workflow (publish.checks) on it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { changelogIssues, changelogPackages } from "./check-changelogs.mjs";
import { notifyAll } from "./notify.mjs";
import { attestationRefusal, publishGatePlan, readAttestation, releaseGate } from "./release-gate.mjs";
import { runTlsGate } from "./tls.mjs";
import { resolveToken } from "./token.mjs";

// The release commit is identified by SHA, not by the checked-out branch's
// name: a worktree or a detached HEAD at origin/main publishes the same commit
// as the shared checkout's main, which other sessions may hold or move.
export function publishBlockers({ token, dirty, head, upstream, issues, tagExists, tag }) {
  const blockers = [];
  if (!token) blockers.push("GITHUB_TOKEN is not set and gh has no token; use GITHUB_TOKEN=$(gh auth token) with the write:packages scope");
  if (dirty) blockers.push("the working tree has uncommitted changes");
  if (head !== upstream) blockers.push(`HEAD ${head.slice(0, 12)} is not origin/main ${upstream.slice(0, 12)}; push the release commit first, or check out origin/main's SHA`);
  for (const issue of issues) blockers.push(`CHANGELOG.md: ${issue}`);
  if (tagExists) blockers.push(`${tag} already exists; this version was published (finish a partial publication with --resume)`);
  return blockers;
}

// `bun --config <file> publish` exits 0 without publishing anything; the flag
// belongs after the subcommand.
export function publishArguments(config) {
  return config ? ["publish", `--config=${config}`] : ["publish"];
}

export function registryUrl(name) {
  return `https://npm.pkg.github.com/${name.replace("/", "%2f")}`;
}

/** What --resume still has to do: "publish", "tag" or "done". */
export function resumePublication({ published, tagExists, tagMatches }) {
  if (tagExists && (!published || !tagMatches)) throw new Error("Release tag and registry do not match this release");
  return tagExists ? "done" : published ? "tag" : "publish";
}

// Tag only what the registry actually serves.
async function registryHasVersion(name, version, token) {
  const response = await fetch(registryUrl(name), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return false;
  const metadata = await response.json();
  return Boolean(metadata.versions?.[version]);
}

// With "Block command line pushes that expose my email" on, GitHub declines
// (GH007) an annotated tag whose tagger is an address the account keeps
// private. The tag takes git's own identity unless RELEASE_TAGGER_EMAIL names
// another address; git config stays as is.
export function tagEnvironment(env) {
  return env.RELEASE_TAGGER_EMAIL ? { ...env, GIT_COMMITTER_EMAIL: env.RELEASE_TAGGER_EMAIL } : env;
}

export function noreplyEmail({ id, login }) {
  return `${id}+${login}@users.noreply.github.com`;
}

// The package is already published when the tag push fails, so the script
// cannot simply be run again.
export function tagPushRecovery(tag, message, email) {
  return [
    `git tag --delete ${tag}`,
    `GIT_COMMITTER_EMAIL=${email} git tag --annotate ${tag} --message "${message}"`,
    `git push origin ${tag}`,
  ];
}

async function githubUser(token) {
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub user lookup failed: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * The commit that introduced the current version into the package's
 * package.json: the release commit, even when later commits touched the file
 * (a root package's dependencies or scripts).
 */
export function releaseCommitOf(git, pkg) {
  const commits = git("log", "--reverse", "--format=%H", "-S", `"version": "${pkg.version}"`, "--", path.join(pkg.path, "package.json"));
  const [first] = commits.split("\n").filter(Boolean);
  if (!first) throw new Error(`no commit sets "version": "${pkg.version}" in ${path.join(pkg.path, "package.json")}`);
  return first;
}

export function githubRepository(remoteUrl) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!match) throw new Error(`origin is not a GitHub repository: ${remoteUrl}`);
  return match[1];
}

// The browser and story checks run in the checks workflow, not in the pre-push
// hook, so a release waits for that workflow on its commit. The API lists the
// newest run first; a rerun updates that run in place.
export function checksState(runs) {
  const [latest] = runs;
  if (!latest) return "missing";
  if (latest.status !== "completed") return "running";
  return latest.conclusion === "success" ? "passed" : "failed";
}

async function waitForChecks(repository, workflow, sha, token) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=5`;
  const started = Date.now();
  for (;;) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`${workflow} lookup failed: ${response.status} ${response.statusText}`);
    const runs = (await response.json()).workflow_runs;
    const state = checksState(runs);
    const waited = Date.now() - started;
    // A push starts the run within seconds; a run lasts well under an hour.
    if (state === "passed" || state === "failed" || (state === "missing" && waited > 5 * 60_000) || waited > 60 * 60_000) {
      return { state, url: runs[0]?.html_url };
    }
    console.log(`${workflow} on ${sha.slice(0, 7)}: ${state}; checking again in 30 s.`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}

export async function runPublish(config, { resume = false } = {}) {
  const { root } = config;
  const workflow = config.publish.checks;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const fail = (lines) => {
    for (const line of lines) console.error(line);
    return 1;
  };
  const [pkg, ...others] = changelogPackages(root, { quickStart: config.changelog.quickStart });
  if (!pkg || others.length) return fail(["Not publishing: expected exactly one released package (the root package or one under packages/)."]);
  const tag = `v${pkg.version}`;
  const gate = releaseGate(config);
  // Before the token reaches any request.
  if (!runTlsGate()) return fail([`Not publishing ${pkg.name}@${pkg.version}: the TLS gate failed (README.md#tls-gate).`]);
  const { token, source } = resolveToken();
  if (token && source !== "GITHUB_TOKEN") console.log(`GITHUB_TOKEN unset; publishing with ${source}.`);
  git("fetch", "--quiet", "--tags", "origin", "main");
  const head = git("rev-parse", "HEAD");
  const tagExists = Boolean(git("tag", "--list", tag));
  const blockers = publishBlockers({
    token,
    dirty: Boolean(git("status", "--porcelain")),
    head,
    upstream: git("rev-parse", "origin/main"),
    issues: changelogIssues(pkg, { release: true, quickStart: config.changelog.quickStart }),
    tagExists: tagExists && !resume,
    tag,
  });
  if (blockers.length) return fail([`Not publishing ${pkg.name}@${pkg.version}:`, ...blockers.map(blocker => `  ${blocker}`)]);

  let action = "publish";
  if (resume) {
    const taggedCommit = tagExists ? git("rev-list", "-n", "1", tag) : undefined;
    const releaseCommit = releaseCommitOf(git, pkg);
    action = resumePublication({
      published: await registryHasVersion(pkg.name, pkg.version, token),
      tagExists,
      tagMatches: !tagExists || (git("merge-base", taggedCommit, "HEAD") === taggedCommit
        && git("merge-base", releaseCommit, taggedCommit) === releaseCommit),
    });
  }
  // An annotated tag's tagger is git's committer identity. Resolve it before
  // publishing, so a missing identity leaves nothing half done.
  const tagEnv = tagEnvironment(process.env);
  const tagger = /<([^>]*)>/.exec(execFileSync("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: root, encoding: "utf8", env: tagEnv }))[1];
  const message = `${pkg.name} ${pkg.version}`;
  // The package is published by the time the tag is pushed: a declined push
  // prints the recovery, and the follow-up workflows run only after the tag is out.
  const pushTag = async () => {
    try {
      git("push", "origin", tag);
    } catch {
      const user = await githubUser(token).catch(() => null);
      return fail([
        `Published ${pkg.name}@${pkg.version}, but pushing ${tag} (tagger ${tagger}) failed.`,
        "If GitHub declined it for email privacy (GH007), tag it as the account's noreply address:",
        ...tagPushRecovery(tag, message, user ? noreplyEmail(user) : "<id>+<login>@users.noreply.github.com").map(line => `  ${line}`),
        ...(config.publish.notify.length ? ["Then request the follow-up workflows: bun run repo-kit notify"] : []),
      ]);
    }
    console.log(`Published ${pkg.name}@${pkg.version} and pushed ${tag}, tagged as ${tagger}.`);
    // A failed request only warns; each target's own schedule is the fallback.
    await notifyAll(config.publish.notify, token);
    return 0;
  };
  if (action === "done") {
    if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
      console.log(`${pkg.name}@${pkg.version} is already published and tagged.`);
      return 0;
    }
    // A local retry can have a tag whose first push failed.
    return pushTag();
  }
  // In Actions, a publication inside the checks workflow runs after its check
  // jobs; waiting for that run to finish would never end. Under either gate the
  // calling workflow's own jobs gate it (Data Grid's automated catalog release).
  // publish.checks: false is for a repository whose checks cannot run yet (no
  // runner); under gate ci its pre-push gate is then the only gate, and publish
  // says so.
  const plan = action === "publish" ? publishGatePlan({ gate, checks: workflow, inActions: Boolean(process.env.GITHUB_ACTIONS) }) : "none";
  if (plan === "attestation") {
    const attestation = await readAttestation(githubRepository(git("remote", "get-url", "origin")), head, token);
    if (attestation.state !== "passed") return fail([`Not publishing ${pkg.name}@${pkg.version}: ${attestationRefusal(attestation, head)[0]}`, ...attestationRefusal(attestation, head).slice(1)]);
    console.log(`${attestation.status.context} passed on ${head.slice(0, 7)}: ${attestation.status.description}`);
  } else if (plan === "actions" && gate === "local") {
    console.log(`Inside GitHub Actions: the calling workflow's jobs gate ${head.slice(0, 7)}; release.gate "local" applies to publications from a machine.`);
  } else if (plan === "unchecked") {
    console.warn(`publish.checks is false: publishing ${head.slice(0, 7)} without waiting for a checks workflow; the pre-push gate was the only gate.`);
  } else if (plan === "workflow") {
    const checks = await waitForChecks(githubRepository(git("remote", "get-url", "origin")), workflow, head, token);
    if (checks.state !== "passed") {
      return fail([
        `Not publishing ${pkg.name}@${pkg.version}: ${workflow} ${checks.state} on ${head.slice(0, 7)}${checks.url ? ` (${checks.url})` : ""}.`,
        ...(checks.state === "missing" ? [`  Start them with: gh workflow run ${workflow} --ref main`] : []),
      ]);
    }
    console.log(`${workflow} passed on ${head.slice(0, 7)}: ${checks.url}`);
  }
  if (action === "publish") {
    // prepack builds dist; the root bunfig.toml supplies the registry and token.
    const bunfig = path.join(root, "bunfig.toml");
    execFileSync("bun", publishArguments(fs.existsSync(bunfig) ? bunfig : undefined), { cwd: pkg.dir, stdio: "inherit", env: { ...process.env, GITHUB_TOKEN: token } });
  }
  if (!(await registryHasVersion(pkg.name, pkg.version, token))) {
    return fail([`bun publish exited cleanly, but ${registryUrl(pkg.name)} does not serve ${pkg.version}; not tagging.`]);
  }
  execFileSync("git", ["tag", "--annotate", tag, "--message", message], { cwd: root, env: tagEnv });
  return pushTag();
}
