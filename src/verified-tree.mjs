// `repo-kit verified-tree`, and the actions/verified-tree step: has this tree
// already passed these checks anywhere? A check result belongs to a tree and a
// plan, not to a branch or a commit. The tree is `git rev-parse <sha>^{tree}`:
// it holds the workflow files, the kit's configuration and the lockfile, so
// two commits with one tree run the same checks the same way. The plan is the
// set of check names or commit-status contexts a caller accepts as the same
// checks; a different set (a new check, a renamed job) never matches.
//
// The lookup compares the tree of the workflow's commit with the commits of a
// few branches (default main and dev, newest `depth` of each), the commit
// itself and a pull request's head, then reads each matching commit's commit
// statuses (the local release gate's "Library checks (local, ...)") and check
// runs (the jobs of earlier workflow runs). A success whose name a plan
// accepts verifies that plan; its link goes to the output.
//
// A check run counts only when GitHub Actions ran it from the caller's own
// workflow file in the same release mode (verify.yml adds --release on main
// and on pull requests into main): a job of the same name elsewhere, or a
// pull request into dev, checked something else.
//
// The platform is part of the plan (owner decision 2026-11-13): a tree counts
// as verified only for the OS and architecture it was checked on, so a green
// local gate on the Mac never skips the Linux run, while a second run on the
// same platform is skipped. The platform is `<os>-<arch>` in Node's names
// (darwin-arm64, linux-x64): REPO_KIT_PLATFORM, or the lookup runner's own. A
// commit status counts only when its context ends with that platform, after a
// slash (`verified-tree/linux-x64`) or in the local gate's parentheses
// (`Library checks (local, linux-x64)`); a context naming none (the gate of
// repo-kit 0.6.0 and older wrote `(local, macOS)`) counts for no platform. A
// check run of the caller's own workflow at the same tree ran on the runner
// that workflow names; it counts unless its job's runner labels name another
// OS or architecture.
//
// It runs with Node alone, so the action needs neither a checkout nor an
// install: it reads GitHub's API with the workflow token (contents, checks,
// statuses and actions: read). When GitHub cannot answer, every plan runs;
// REPO_KIT_FORCE=true runs every plan without asking.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const PLATFORM = /^[a-z0-9]+-[a-z0-9_]+$/;

/** This host's platform, `<os>-<arch>` in Node's names: darwin-arm64, linux-x64. */
export function hostPlatform() {
  return `${process.platform}-${process.arch}`;
}

/** The platform a status context names at its end (`.../linux-x64` or `(..., linux-x64)`), or null. */
export function contextPlatform(context) {
  const match = /(?:\/|, )([a-z0-9]+-[a-z0-9_]+)\)?$/.exec(context ?? "");
  return match ? match[1] : null;
}

const LABEL_OS = [[/^(ubuntu|linux)/i, "linux"], [/^macos/i, "darwin"], [/^windows/i, "win32"]];
const LABEL_ARCH = [[/^(arm64|aarch64)$|-arm(64)?$/i, "arm64"], [/^(x64|amd64|x86_64)$/i, "x64"]];

/**
 * Whether a job's runner labels allow the platform: false when a label names
 * another OS (ubuntu-*, macos-*, windows-*, or a self-hosted runner's Linux,
 * macOS, Windows) or another architecture (X64, ARM64, ubuntu-24.04-arm).
 * Labels naming neither (self-hosted, homelab) allow it.
 */
export function labelsAllow(labels = [], platform) {
  const [os, arch] = platform.split("-");
  for (const label of labels) {
    const named = LABEL_OS.find(([pattern]) => pattern.test(label));
    if (named && named[1] !== os) return false;
    const width = LABEL_ARCH.find(([pattern]) => pattern.test(label));
    if (width && width[1] !== arch) return false;
  }
  return true;
}

/** REPO_KIT_PLANS: { name: [accepted check name or status context, ...] }; a trailing * accepts a prefix. */
export function parsePlans(text) {
  if (!text) throw new Error('REPO_KIT_PLANS is empty: set it to a JSON object such as {"verify": ["check / verify"]}');
  let plans;
  try {
    plans = JSON.parse(text);
  } catch {
    throw new Error(`REPO_KIT_PLANS is not JSON: ${text}`);
  }
  if (!plans || typeof plans !== "object" || Array.isArray(plans)) throw new Error("REPO_KIT_PLANS must be an object of plan names to lists of accepted checks");
  for (const [name, accepted] of Object.entries(plans)) {
    if (!Array.isArray(accepted) || !accepted.length || accepted.some(item => typeof item !== "string" || !item)) {
      throw new Error(`plan ${name} needs a non-empty list of check names or status contexts`);
    }
  }
  if (!Object.keys(plans).length) throw new Error("REPO_KIT_PLANS names no plan");
  return plans;
}

export function accepts(patterns, name) {
  return patterns.some(pattern => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

function client(repository, token, fetcher) {
  return async (suffix, { missing } = {}) => {
    const response = await fetcher(`${API}/repos/${repository}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (missing && (response.status === 404 || response.status === 422)) return missing;
    if (!response.ok) throw new Error(`GET ${suffix}: ${response.status} ${response.statusText}`);
    return response.json();
  };
}

/**
 * Whether a workflow run checked what this run checks: verify.yml adds
 * --release on main and on pull requests into main, so a result counts only
 * from a run in the same mode, and only from the same workflow file.
 */
export function releaseMode({ event, head_branch: branch, pull_requests: pulls = [] }) {
  if (event === "pull_request" || event === "pull_request_target") return pulls.some(pull => pull.base?.ref === "main");
  return branch === "main";
}

async function sameWorkflow(get, run, workflow, platform) {
  if (run.app?.slug !== "github-actions") return false;
  if (!workflow) return true;
  const job = await get(`/actions/jobs/${run.id}`, { missing: {} });
  if (!job.run_id || !labelsAllow(job.labels, platform)) return false;
  const workflowRun = await get(`/actions/runs/${job.run_id}`, { missing: {} });
  return workflowRun.path === workflow.path && releaseMode(workflowRun) === workflow.release;
}

/** A commit's passed results on the platform: the newest status per context and the latest check run per name. */
async function passedResults(get, repository, sha, accepted, workflow, platform) {
  const [statuses, { check_runs: runs = [] }] = await Promise.all([
    get(`/commits/${sha}/statuses?per_page=100`),
    get(`/commits/${sha}/check-runs?filter=latest&per_page=100`),
  ]);
  const passed = [];
  const seen = new Set();
  for (const status of statuses) {
    // The API lists a commit's statuses newest first: the first per context is current.
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    if (status.state === "success" && contextPlatform(status.context) === platform) passed.push({ name: status.context, url: status.target_url || `https://github.com/${repository}/commit/${sha}` });
  }
  for (const run of runs) {
    // Only runs some plan accepts cost the two lookups of their workflow run.
    if (run.conclusion === "success" && accepted(run.name) && (await sameWorkflow(get, run, workflow, platform))) passed.push({ name: run.name, url: run.html_url });
  }
  return passed;
}

/**
 * For each plan, the first commit with `sha`'s tree that passed a check the plan
 * accepts on `platform` (this host's by default): { sha, check, url }, or null
 * when the plan has to run.
 */
export async function findVerified({ repository, sha, extra = [], plans, branches = ["main", "dev"], depth = 100, workflow, platform = hostPlatform(), token, fetcher = fetch }) {
  const get = client(repository, token, fetcher);
  const treeOf = async id => (await get(`/commits/${id}`, { missing: {} })).commit?.tree?.sha;
  const tree = await treeOf(sha);
  if (!tree) throw new Error(`GitHub does not know commit ${sha}`);

  const candidates = [sha];
  for (const id of extra) if (id && !candidates.includes(id) && (await treeOf(id)) === tree) candidates.push(id);
  const perPage = Math.min(100, depth);
  for (const branch of branches) {
    for (let page = 1, read = 0; read < depth; page++) {
      const listed = await get(`/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`, { missing: [] });
      for (const commit of listed.slice(0, depth - read)) {
        if (commit.commit?.tree?.sha === tree && !candidates.includes(commit.sha)) candidates.push(commit.sha);
      }
      read += listed.length;
      if (listed.length < perPage) break;
    }
  }

  const found = Object.fromEntries(Object.keys(plans).map(name => [name, null]));
  for (const candidate of candidates) {
    if (Object.values(found).every(Boolean)) break;
    const open = Object.entries(plans).filter(([name]) => !found[name]).flatMap(([, accepted]) => accepted);
    const passed = await passedResults(get, repository, candidate, name => accepts(open, name), workflow, platform);
    for (const [name, accepted] of Object.entries(plans)) {
      if (found[name]) continue;
      const match = passed.find(result => accepts(accepted, result.name));
      if (match) found[name] = { sha: candidate, check: match.name, url: match.url };
    }
  }
  return { tree, plans: found };
}

function append(file, text) {
  if (file) fs.appendFileSync(file, text);
}

/** The workflow step: writes `urls` (plan name to link, "" to run), `tree` and `platform` to GITHUB_OUTPUT. */
export async function runVerifiedTree(env = process.env, fetcher = fetch) {
  let plans, branches;
  const platform = env.REPO_KIT_PLATFORM || hostPlatform();
  try {
    if (!PLATFORM.test(platform)) throw new Error(`REPO_KIT_PLATFORM must be <os>-<arch> in Node's names, such as linux-x64: ${platform}`);
    plans = parsePlans(env.REPO_KIT_PLANS);
    branches = env.REPO_KIT_BRANCHES ? JSON.parse(env.REPO_KIT_BRANCHES) : ["main", "dev"];
    if (!Array.isArray(branches)) throw new Error(`REPO_KIT_BRANCHES must be a JSON list: ${env.REPO_KIT_BRANCHES}`);
  } catch (error) {
    console.error(`verified-tree: ${error.message}`);
    return 1;
  }
  const urls = Object.fromEntries(Object.keys(plans).map(name => [name, ""]));
  const lines = [];
  let tree = "";
  // The caller's workflow file, from owner/repo/<path>@<ref>.
  const workflowPath = env.GITHUB_WORKFLOW_REF?.replace(/^[^/]+\/[^/]+\//, "").replace(/@.*$/, "");
  const workflow = workflowPath ? { path: workflowPath, release: env.GITHUB_REF === "refs/heads/main" || env.GITHUB_BASE_REF === "main" } : undefined;
  if (env.REPO_KIT_FORCE === "true") {
    lines.push("- forced: every plan runs");
  } else try {
    const result = await findVerified({
      repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, extra: [env.REPO_KIT_HEAD_SHA],
      plans, branches, depth: Number(env.REPO_KIT_DEPTH) || 100, workflow, platform, token: env.GITHUB_TOKEN, fetcher,
    });
    tree = result.tree;
    for (const [name, hit] of Object.entries(result.plans)) {
      if (hit) urls[name] = hit.url;
      lines.push(hit ? `- ${name}: reused: \`${hit.check}\` passed on ${hit.sha.slice(0, 7)} with the same tree, for ${platform}: ${hit.url}` : `- ${name}: runs: no passed result for tree ${tree.slice(0, 7)} for ${platform}`);
    }
  } catch (error) {
    console.log(`::warning title=verified-tree::${error.message}`);
    lines.push(`- lookup failed (${error.message}): every plan runs`);
  }
  console.log(lines.join("\n"));
  append(env.GITHUB_STEP_SUMMARY, `### Verified tree\n\n${lines.join("\n")}\n`);
  append(env.GITHUB_OUTPUT, `urls=${JSON.stringify(urls)}\ntree=${tree}\nplatform=${platform}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runVerifiedTree();
}
