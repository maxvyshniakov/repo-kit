# Repo-Kit reference

[Overview and quick start](../README.md)

Configuration, command details and integration contracts for the shared toolkit. Examples use the package's
own GitHub scope and some existing consumers; replace consumer repositories, endpoints and runner choices with
your project's values. The [README](../README.md) explains fit, requirements and the minimal setup.

## Install

```sh
export GITHUB_TOKEN=$(gh auth token)   # read:packages; see "GITHUB_TOKEN" below
bun add --dev --exact @maxvyshniakov/repo-kit
```

The repository's `bunfig.toml` maps the scope to the registry:

```toml
[install.scopes]
maxvyshniakov = { url = "https://npm.pkg.github.com/", token = "$GITHUB_TOKEN" }
```

Pin the exact version. Each commit is verified by the kit its lockfile records, so the pre-push hook
checks an older commit with that commit's kit.

## package.json

The command names stay as they were, so instructions and skills that name them keep working:

```json
{
  "scripts": {
    "prepare": "repo-kit hooks install",
    "verify": "repo-kit verify",
    "verify:browser": "repo-kit verify --browser",
    "check:kit": "repo-kit check",
    "check:changelogs": "repo-kit check-changelogs",
    "check:consumer": "repo-kit packed-consumer",
    "release": "repo-kit release",
    "release:publish": "repo-kit publish",
    "security:tls": "repo-kit tls",
    "shoot:stories": "repo-kit shoot"
  }
}
```

`repo-kit verify` and `repo-kit pre-push` take their own slotfather lease (`verify.slots`, `verify.browserSlots`,
`prePush.slots`). Other heavy scripts wrap themselves: `"check:stories": "repo-kit heavy 2 bun scripts/run-story-checks.mjs"`.
Slotfather priority defaults to `normal`; ticket is optional. For tagged ad-hoc
runs, use `slotfather run -n K --priority interactive --ticket ID -- repo-kit ...`.
The kit detects the inherited lease and does not acquire a second one. Lane
registration and integration belong to the project's orchestration contract;
repo-kit owns verification execution rather than lane lifecycle.

`REPO_KIT_SLOT_WAIT=<seconds>` makes every lease give up after that long (slotfather exits 75), so a CI job fails with
that reason instead of reaching its time limit while queued.

The memory a run may use is the leased slots times slotfather's `gib_per_slot` (for example, 5 GiB per slot), capped
by the job's cgroup limit and Linux's MemAvailable; without a lease, MemAvailable on Linux and all memory elsewhere.
On hosts without a per-slot memory budget, cores decide. `REPO_KIT_VERIFY_MEMORY_GIB` and `REPO_KIT_VERIFY_CORES`
override the figures.

## repo-kit.config.mjs

At the repository root. Every field is optional except the steps `verify` runs.

```js
import { chain } from "@maxvyshniakov/repo-kit";

export default {
  verify: {
    // bun arguments; a step starts once every step in `needs` has passed and its
    // memory (GiB at its peak, as the summary measures it) fits beside the running steps.
    steps: ({ release }) => [
      { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])], memory: 0.1 },
      { name: "kit", command: ["run", "check:kit"], memory: 0.1 },
      { name: "lint", command: ["run", "lint"], memory: 0.3 },
      // VITEST_MAX_WORKERS and REPO_KIT_WORKERS from the run's cores and memory;
      // memory here is what it holds besides its workers (default 0.25).
      { name: "unit tests", command: ["run", "test"], usesCores: true },
      { name: "build", command: ["run", "build"], memory: 0.4 },
      { name: "storybook tests", command: ["run", "test:storybook"], needs: ["build"], workers: 2, memory: 1.1 },
      { name: "packed consumer", command: ["run", "check:consumer"], needs: ["build"], memory: 1.3 },
      { name: "typecheck", command: ["run", "typecheck"], needs: ["build"], memory: 0.7 },
    ],
    browser: chain([["build", ["run", "build"]], ["stories", ["run", "check:stories"]]]),
    slots: 1,          // default 1
    browserSlots: 2,   // default 2
    workerMemory: 0.9, // GiB one usesCores worker holds; default 0.9
    stepTimeout: 15,   // minutes a step may run (a step's own `timeout` wins); default 15, 0: no limit
  },
  prePush: { slots: 3 },   // default 1; covers installs and every pushed commit
  publish: {
    checks: "check.yml",   // the workflow publish waits for on the release commit; false: none can run yet
    notify: [{ repository: "maxvyshniakov/data-grid", workflow: "update-catalog-dependencies.yml", ref: "main" }],
  },
  changelog: {
    quickStart: "docs/GETTING_STARTED.md", // archive names checked and moved by release, when the file exists
    peerScope: "@maxvyshniakov/",          // peer ranges checked against workspace versions and exact devDependency pins
    versionSource: "package.json",         // or "pyproject.toml"; default package.json, pyproject.toml without a root package.json
    paths: ["packages/sid-kit/src/**"],    // shipped paths: the changelog-entry guard (Changelog entries); default none, off
  },
  hooks: {
    managed: ["pre-push", "commit-msg"],   // the managed hooks sync writes and check expects; default every one that applies
  },
  release: {
    gate: "local",  // what publish requires: "local" (default), a passed `repo-kit release-gate`; "ci", the checks workflow
    afterCut({ root, released }) {}, // runs after the version is cut, before bun install
  },
  packedConsumer: {
    versionSources: ["packages/sid-kit/package.json", "package.json"], // exact pins for consumer packages
    dependencies: ["vite"],
    probes: [async ({ consumerDir, run, ok, fail, writeFile, pinned }) => {}],
  },
};
```

The released package is the one directory under `packages/` with a `package.json`, or the root package when there is
no `packages/`. `release` and `check-changelogs` handle several workspace packages; `publish` expects exactly one.

`changelog.versionSource: "pyproject.toml"` reads each package's name and version from `pyproject.toml`'s `[project]`
table instead (`name = "..."`, `version = "x.y.z"`, each on one line; a `dynamic` version is not supported), with the
same layout rule: each directory under `packages/` holding a `pyproject.toml`, else the root. A repository without a
root `package.json` uses it without the setting. `release` then sets that `version` line and nothing else in the file;
`bun.lock` and quick-start archives are npm-only and not touched. `publish` refuses such a package, and
`packed-consumer` is npm-only.

### Steps side by side

`chain([...])` runs its entries one after another. An entry that is itself a list of steps is a group: they all
start after the entry before it, and the entry after the group waits for all of them. A step's third element holds
its options:

```js
browser: chain([
  ["build", ["run", "build"]],
  ["storybook", ["run", "storybook:build"]],
  [["browser checks", ["run", "check:browser", "--", "--no-build"], { slots: 1 }],
   ["story checks", ["run", "check:stories", "--", "--no-build"], { slots: 1 }],
   ["control checks", ["run", "check:controls"], { slots: 1 }]],
]),
```

`slots` is how many of the run's leased slots (`SLOTFATHER_COUNT`) a step holds while it runs: steps taking slots run
side by side only as far as the lease goes, so the group above runs one check at a time under a one-slot lease and
two under a two-slot one; outside a lease (a CI runner without slotfather) one at a time. A step asking more than
the lease holds runs once no other slot-taking step does, and later slot-taking steps wait behind it. Steps without
`slots` are limited by memory alone, as before. The step sees its share as
`REPO_KIT_STEP_SLOTS`, for a check that sizes its own browser pool.

### Step memory

verify plans its steps by the memory each declares, so declare it: a step left at 0 never waits for room, and on a
small runner (for example two 5 GiB slots, a 10 GiB cap) steps that all read 0 start together and run it out of memory.

1. Run verify where memory is budgeted (CI, or under a lease on Linux) and read the summary:

   ```text
   verify: 6 cores, 10.0 GiB, 4 workers for the steps that use them
   Step peaks, measured/declared GiB: unit tests 3.3/3.0, storybook build 2.1/1.7, packed consumer 2.0/1.3, ...
   Job cgroup peak 7.4 GiB (memory.peak of /ci.slice/..., page cache included)
   ```

   A step's peak is its whole process tree, browsers in sessions of their own included.
2. Set each step's `memory` to its highest measured peak over a few runs, rounded up by about a tenth.
3. For a `usesCores` step, `memory` is what it holds besides its workers (default 0.25), and verify plans it at
   `workers × verify.workerMemory + memory`. From a peak `P` at `W` workers (the summary's first line), set
   `verify.workerMemory` to about `(P − 0.25) / W`. Data Grid: 2.5 GiB at 2 workers gives 1.15.
4. Check the sum: the steps that run side by side should fit in the run's memory. The job cgroup's peak, which also
   holds page cache and the runner itself, shows how close the job came to the cap.

Re-measure after a change that adds tests or stories; a peak above its declared figure shows as `3.3/3.0`.

## Commands

| Command | Does |
|---|---|
| `verify [--release] [--browser]` | Runs the config's steps side by side, within the run's memory. Output streams with a step prefix. The first failure stops the rest and prints that step's last 80 lines; a step past its timeout fails and its whole process tree is stopped; a signal stops every step, and a reaper stops them when verify is killed outright. The summary shows the peak RSS and each step's measured peak beside its declared `memory`: the resident memory of the step's whole process tree, browsers in sessions of their own included, and on Linux the job cgroup's peak. |
| `pre-push` | Runs from `.githooks/pre-push`. Verifies each pushed commit in a clean temporary worktree (`--release` for `main`), once per commit. Refuses Bun older than 1.4.4. Skip once with `git push --no-verify`. |
| `hooks install` | `prepare`: points `core.hooksPath` at `.githooks`, unless someone set another path or `CI` is set. |
| `hooks sync` | Writes the managed hooks into `.githooks`: a `pre-push` shim and `reference-transaction`; `lane-check` with a `.lanefather.toml`; `commit-msg` with `changelog.paths`. `hooks.managed` keeps only the named ones. Other hooks there are the repository's own, and an existing `commit-msg` of its own is never replaced. |
| `hooks check` / `hooks status` | The tracked managed hooks match the kit / Git would run every tracked hook. |
| `check` | `hooks check`. Every `maxvyshniakov/repo-kit/...@` reference in `.github/workflows` names the installed version. `packageManager` names `bun@1.4.4`. |
| `check-changelogs [--release]` | Changelog format, version agreement (`package.json` or `pyproject.toml`, the newest release, `bun.lock`, quick start archives) and peer ranges. `--release`: no unreleased entries. |
| `check-changelog-entries <base>..<head>` | The [changelog-entry guard](#changelog-entries) on every commit of the range. Without `changelog.paths`, nothing. |
| `commit-msg <message file>` | Runs from `.githooks/commit-msg`: the same guard on the commit being made. Skip once with `git commit --no-verify`. |
| `release [<package>:]<patch\|minor\|major\|x.y.z> [--date=]` | Cuts `## Unreleased` into a version; sets `package.json` (or `pyproject.toml`), `bun.lock` and the quick start. |
| `release-gate [<ref>] [--rerun] [--no-attest]` | The local [release gate](#release-gate) on a commit (default `HEAD`): a clean worktree, frozen install, `verify --release`, `verify --browser` with Chromium in software compositing, the TLS gate; records the commit status `Library checks (local, <platform>)`. `--mode` prints `release.gate`. |
| `ci-gate` | In a workflow job that needs the checks (`deploy-storybook.yml`): writes `run=true` under gate `local`, or under gate `ci` when every job in `REPO_KIT_NEEDS` (the caller's `toJSON(needs)`) passed. |
| `publish [--resume]` | TLS gate; HEAD must be `origin/main` by SHA (any branch, worktree or detached HEAD); the [release gate](#release-gate) on that commit: a passed `release-gate` status (gate `local`) or the checks workflow (gate `ci`), not inside Actions; publishes, checks the registry serves the version, tags `v<version>` (GH007 recovery printed when the tag push is declined), then requests `publish.notify`. `--resume` finishes a partial publication. |
| `notify` | Requests `publish.notify`'s workflows again. |
| `heavy <slots\|all> <command...>` | Runs a command under `slotfather run -n <slots>` when slotfather is on PATH and no lease is held; otherwise directly. |
| `tls` | The TLS gate (below). |
| `packed-consumer [--keep]` | Packs, installs into a temporary consumer, imports every entrypoint in plain Node, type-checks under `nodenext` without `skipLibCheck`, then runs the probes. Optional peers are not installed. |
| `shoot <story id filter...> [<url>\|--url=] [--theme=] [--width=] [--browser=] [--out=] [--viewport]` | [Story screenshots](#story-screenshots) from a running Storybook, under a lease of `shoot.slots`. |
| `test-hygiene [--init\|--update]` | [Shrink-only test rules](#test-hygiene): fixed sleeps, timing assertions outside the perf suite and, opt-in, class-name and CSS-text assertions. Runs without `repo-kit.config.mjs` too. |
| `verified-tree` | In a workflow: links each `REPO_KIT_PLANS` plan to a passed result of the same tree ([skipping a verified tree](#skipping-a-verified-tree)). |

## Test hygiene

`repo-kit test-hygiene` scans the test files Git tracks (or would track) and counts, per rule and file:

| Rule | Finds | Allowed |
|---|---|---|
| `fixed-sleep` | `waitForTimeout(...)` and Python's `wait_for_timeout(...)` whatever the argument; a `new Promise(resolve => setTimeout(resolve, <n or NAME>))`, `sleep(<n>)`, `delay(<n>)` and `Bun.sleep(<n>)` of 50 ms or more; Python `time.sleep(<n>)`/`asyncio.sleep(<n>)` of 0.2 s or more; `Thread.sleep`, `Task.sleep`, a bare `sleep`/`usleep`, `runMain(for:)`, `thread::sleep` | a `sleep-ok: <reason>` comment on the line or right above it |
| `timing-assert` | an assertion bounding a measured duration from above: `assert.ok(Date.now() - started < 2000)`, `expect(elapsed).toBeLessThan(100)` (or chai's `below`, `lessThan`, `most`), `self.assertLess(elapsed, 0.2)` (ported from Straylight's `tools/perf-budget-check.py`; also Swift and Rust) | a budget through `perfBudget` / `perf_budget`; a deadline with a literal bound of at least 30 s, or a tighter one with a `load-tolerant: <why>` comment |
| `ui-assertion` (opt-in) | `toHaveClass(...)`, an asserted `.className` or `classList`, a string holding a CSS declaration (`"color: var(--x);"`) in an assertion | roles, states and data attributes |

Only the helper exempts an assertion, in the perf suite as anywhere. Each file calling it must match `perfSuite`, or its
budgets never hold: that fails outright. The perf suite is the repository's own command: it runs those files alone,
with `REPO_KIT_PERF_BUDGETS=enforce`, and the ordinary test command leaves them out.

The counts live in a baseline (`test-hygiene-baseline.json`) and only shrink:

- `repo-kit test-hygiene --init` writes today's counts; it never overwrites a baseline.
- The check fails when a file gains a finding or a new file has one, naming each line.
- It fails when a count went down and the baseline still holds the old one: `--update` lowers it (and never raises).
- Compared with the baseline of the base commit, no entry may rise: `REPO_KIT_HYGIENE_BASE`, else where `HEAD` left
  `origin/HEAD` or `origin/main`, else `HEAD`'s parent on that branch itself. An entry may move with its file: the
  entries of files that no longer exist can be given to new paths.
- Counts are per file, so one wait can replace another in the same file; the lines are printed when a count grows.

```js
// repo-kit.config.mjs, all optional
testHygiene: {
  baseline: "test-hygiene-baseline.json",
  tests: ["**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx,mts,cts}", "test/**/*.{js,mjs,cjs,ts,tsx,py}", "tests/**/*.{js,mjs,cjs,ts,tsx,py,rs,swift}", /* ... */],
  exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
  perfSuite: ["**/*.perf.{js,mjs,ts,tsx}", "**/perf/**", "**/test_perf_*.py", "**/*perf*.test.*"],
  ui: true,                                  // adds ui-assertion (unit tests: keep end-to-end tests out of `tests`)
  // rules: ["fixed-sleep", "timing-assert", "ui-assertion"],  // or name them
},
```

`perfBudget(holds, message)` from `@maxvyshniakov/repo-kit/perf-budget` states a budget: under
`REPO_KIT_PERF_BUDGETS=enforce`, which the perf suite sets when it runs alone on a quiet machine, a missed budget
fails; elsewhere it is reported and the test goes on. A Python or Swift repository defines `perf_budget` /
`perfBudget` beside its tests with the same contract.

### Adopting it

Nothing runs until a repository adds the step, so a release of the kit turns no gate red. Run
`repo-kit test-hygiene --init`, commit the baseline, then add the check to the gate:

- **Sid-Kit and Data Grid:** a verify step `{ name: "test hygiene", command: ["run", "repo-kit", "test-hygiene"] }`
  (or a `check:hygiene` script) and `testHygiene: { ui: true }`. Measured on 2026-11-12: Sid-Kit 2 fixed sleeps,
  2 timing assertions and 757 UI assertions in 239 test files; Data Grid 0, 0 and 87 in 229. Their perf scripts
  (`perf:*`, run under a whole-machine lease) belong in `perfSuite`.
- **fathers** (Python, no `repo-kit.config.mjs`): `bunx @maxvyshniakov/repo-kit test-hygiene` from the repository
  root in `tools/check.py`, or a CI step. Measured: 23 fixed sleeps and 9 timing assertions in 85 test files,
  among them godfather's four `assertLess(time.monotonic() - started, ...)`.
- A scan of a few hundred test files takes 0.1–0.5 s.

## Changelog entries

A package's changelog misses changes when nothing asks for an entry. The guard asks, deterministically, from Git alone:
a commit that changes a package's shipped paths adds, changes or removes a line under `## Unreleased` in that package's
`CHANGELOG.md`, or ends its message with the trailer `Changelog: none` and an optional reason.

```js
// repo-kit.config.mjs
export default {
  changelog: {
    // One package (or globs inside packages/<name>/ when there are several):
    paths: ["packages/sid-kit/src/**", "packages/sid-kit/package.json", "!packages/sid-kit/src/**/*.test.tsx"],
    // Or keyed by package directory, for globs outside it:
    // paths: { "packages/sid-kit": ["packages/sid-kit/src/**", "tokens/**"] },
  },
};
```

Globs are repository-relative: `*` and `?` stay within a path segment, `**` spans segments, `{a,b}` is either, a
trailing `/` means everything below a directory, and a leading `!` excludes what the others include. Character
classes (`[...]`), nested braces and `**` inside braces are configuration errors. A bare directory such as `src`
matches only a file of that name: write `src/**`. `check-changelog-entries` warns about every include glob that
matches no tracked file. With no `changelog.paths` the guard is off.

| A commit | Result |
|---|---|
| changes no shipped path | passes |
| changes one and adds, changes or removes a non-blank, non-heading line under `## Unreleased` of that package's changelog (a revert takes its entry back out) | passes |
| changes one and carries `Changelog: none` or `Changelog: none (<reason>)` as a trailer | passes |
| is a merge commit (more than one parent) | exempt |
| cuts that package's release: its newest changelog release is newer and is the version the manifest now records, as after `repo-kit release` | exempt |
| anything else, including only reordering lines or editing older releases' lines | fails, naming the files and the changelog |

The trailer is read as `git interpret-trailers` parses trailers: it belongs to the message's last paragraph, beside
`Co-Authored-By:` for example, not on the subject line. A `Changelog:` trailer with any other value fails and says so.
One `Changelog: none` covers the whole commit: in a repository with several packages it exempts every package the
commit changes. Split a commit that changes one package visibly and another invisibly, so the trailer cannot
cover a missing entry.

### Where it runs

- **commit-msg hook.** `repo-kit hooks sync` writes `.githooks/commit-msg` when `changelog.paths` is set; `repo-kit hooks
  install` (the `prepare` script) activates `.githooks`. It checks the index against `HEAD`, and against `HEAD`'s
  parent for `git commit --amend`, read from the `git` command line. An amend that line does not show (an alias, a
  hook manager, a GUI) usually keeps `HEAD`'s message: a commit with `HEAD`'s message that fails against `HEAD` is
  checked against its parent too, so the amended commit's entry counts. It skips merges in progress and `fixup!`,
  `squash!` and `amend!` commits, which the range check sees after they are folded in. It runs the installed kit,
  the main checkout's in a linked worktree, or a `repo-kit` on `PATH` for a repository without `node_modules`. When
  it cannot run the kit (none installed, no `node` on the `PATH` Git hooks get, a kit without `commit-msg`) it prints
  one warning naming the fix and lets the commit through: the range check in verify or CI is the backstop.
  `git commit --no-verify` skips it once.
- **verify step.** `{ name: "changelog entries", command: ["run", "check:changelog-entries"] }` with
  `"check:changelog-entries": "repo-kit check-changelog-entries origin/main..HEAD"` (the branch commits integrate into).
  The base must be in the checkout: in CI call `verify.yml` with `fetch-depth: 0`. A range Git cannot resolve fails.
- **CI on its own.** On a pull request: `repo-kit check-changelog-entries ${{ github.event.pull_request.base.sha }}..${{ github.sha }}`
  after a checkout with `fetch-depth: 0`.

The range form checks every commit of the range against the current checkout's `changelog.paths`: adopt it in a
commit of its own, or with a base past the commits from before.

### For an AGENTS.md

A repository's agent instructions can link here and carry this paragraph:

> A commit that changes a shipped path (`changelog.paths` in `repo-kit.config.mjs`) adds or changes a line under
> `## Unreleased` in that package's `CHANGELOG.md`, in the same commit. When the change is invisible to the package's
> users (tests, internal refactoring, tooling), end the message with the trailer `Changelog: none (<reason>)` instead.
> The commit-msg hook and `repo-kit check-changelog-entries` enforce it; merges and release cuts are exempt, and one
> trailer covers every package the commit changes.

## Working with Lanefather

Repo-Kit does not orchestrate parallel work; the maintainer's agents follow their own orchestration process.
[Lanefather](https://github.com/maxvyshniakov/fathers/tree/main/lanefather) supplies lanes, path claims, integration, independent
review and protected-branch promotion for projects that configure it. repo-kit supplies verification and package
release/publish commands. Slotfather leases the machine while those commands execute; an active lane itself holds
no machine slots.

A consumer adopting parallel lanes keeps its check-contract adapter and project seams in `.lanefather.toml`.
Follow that project's orchestration instructions and configured command (`lanefather`, or a project wrapper):

| Phase | Owner and evidence |
|---|---|
| Implement and check a lane | Lanefather registers the lane and its claims. Its `check` calls the project's adapter and records a receipt for the committed inputs. repo-kit's verification steps run where the adapter/config selects them. |
| Integrate and review | Lanefather `land` merges onto the integration branch, runs the configured post-merge smoke and starts the independent review. Findings receive the project's fix round before promotion. |
| Publish a batch | Lanefather `promote <sha>` takes the landing lock and pushes an explicit commit. A project with a verified-tree contract gets its configured batch gate. A library without that contract relies on repo-kit's mandatory clean-worktree pre-push gate. |
| Release a package | Follow the consumer's publishing contract for its release commit and branches, then run the release gate and publish. Registry publication and consumer adoption remain separate steps. |

A consumer using Lanefather's `dev`/`main` branch policy can use its protected-branch promotion without adopting
parallel lanes first:

```sh
lanefather promote COMMIT_SHA                # dev
lanefather promote RELEASE_COMMIT_SHA --ship  # dev and main, for an authorized release
```

Keep the consumer's `.githooks/pre-push` active. It verifies the exact pushed commit with the kit pinned by that
commit and records its own passed result. A lane receipt or smoke is separate evidence. Let the configured
promotion/pre-push path run the full gate; running `bun run verify` manually immediately before it duplicates
work. Projects sharing batch-gate evidence with a hook must provide that explicit contract.

### Lane verification adapter

`repo-kit-lane` implements [Lanefather's check contract](https://github.com/maxvyshniakov/fathers/tree/main/lanefather#the-check-contract)
from the consumer's existing `verify.steps` and optional `verify.browser`. It selects all declared checks for each
change. Check IDs are the suite (`verify` or `browser`), a colon and the URL-encoded step name. Requested checks
include their dependencies; when both suites run, browser work waits for normal verification. Names and commands
come entirely from `repo-kit.config.mjs`.

A parallel-work consumer tracks `.lanefather.toml` with its own project facts and:

```toml
[checks]
verify = ".githooks/lane-check"
slot_env = "REPO_KIT_SLOT"
```

Run `repo-kit hooks sync` and commit the managed `.githooks/lane-check`. It works in a fresh linked checkout:
using the installed kit in this or the main checkout to lease a frozen dependency install, then executing the
adapter from the target checkout's locked package. Install the main checkout's dependencies once before starting
lanes. Keep the registry credentials available as for pre-push; the entry also resolves `gh auth token`.

The managed entry prepares dependencies under a one-slot lease even for planning. Direct `repo-kit-lane
--changed --base REF --plan --json` reads configuration and Git without running checks. Execution uses Repo-Kit's
existing scheduler, cancellation and timeouts. It leases the slots Lanefather gives it with `--jobs` (its check
contract: verify queues for its own `--jobs`-slot lease), no more than the selected suites' configured `slots` /
`browserSlots`, and the configured ones without `--jobs`. Where slotfather gives a slot memory (`gib_per_slot`), the
lease never holds less than the largest selected step's declared `memory`, which can exceed `--jobs`; a smaller lease
also means a smaller memory budget for side-by-side steps. `REPO_KIT_VERIFY_SLOTS` still overrides it.
`--jobs` also caps automatically sized worker parallelism. Leases are labelled by lane and phase (`REPO_KIT_SLOT_LABEL`
plus the phase from `REPO_KIT_SLOT_META`, for example `lane-sk-api-surfaces check`), and elsewhere by project and
command (`sid-kit verify`, `sid-kit release-gate`, `sid-kit check:stories`), never by a bare directory name.
Steps that take `slots` share that lease (below). Explicit per-step worker counts remain project configuration. `REPO_KIT_SLOT_LABEL`, `_PRIORITY`, `_TICKET`, `_META` and `_YIELDABLE` carry Lanefather's
execution context. The adapter honors `--keep-going` to collect independent results; ordinary `repo-kit verify`
retains its fail-fast behavior. Reports and step logs live under the checkout's Git metadata, not in tracked source.

A run prints `Verification report: <path>` to a version-1 JSON report with the original commit/tree, each check's
status, log and blocking dependencies. Cancellation, failed setup or changed committed inputs cannot yield green
verification evidence. Lanefather remains responsible for receipts, review, landing and cleanup. The adapter
creates neither a verified-tree stamp nor a pre-push/release attestation. Those existing gates keep their own
contracts and still run when publishing.

Adding this adapter does not reconcile a previously published lane that never went through `land`. Keep that
historical completion separate; changing a published task's metadata does not manufacture its missing evidence.

Repo-kit's own repository has no lane adapter and uses one active `main` branch. Its task-worktree process is in
[orchestration](agents/orchestration.md); the explicit-SHA push, pre-push gate and CI procedure is in
[publishing](agents/publishing.md).

## Story screenshots

```sh
bun run shoot:stories -- button--default
bun run shoot:stories -- field --theme=light,dark --width=1280,375 --out=/tmp/shots
bun run shoot:stories -- showcase --browser=chromium,firefox,webkit,safari
bun run shoot:stories -- http://127.0.0.1:6020 badge --viewport     # no full page
```

`repo-kit shoot` screenshots every story whose id contains one of the filters, in each theme (the `theme` global),
width (900 px high) and browser, and prints each file: `<out>/<story-id>-<theme>-<width>.png`, with `-<browser>`
appended for every browser but Chromium. The defaults are `--theme=light --width=1280 --browser=chromium`, full-page
pictures, and `--out` `<tmpdir>/<repository folder>-shots`. A full page taller than 16384 px is cut to its top 16384 px
with a warning: Firefox refuses a picture over 65535 px, and Chromium writes one nothing opens (Data Grid's showcase
is 390104 px tall).

The Storybook is the first bare `http(s)` argument or `--url=`, else `SID_KIT_STORYBOOK_URL`, `STORYBOOK_URL`, then
`shoot.url` (default `http://127.0.0.1:6010`, `bun run storybook`). It also works against a static build served by
the repository's own server.

Before each picture it waits, in order, for Storybook's rendered mark (`sb-show-main` on `body`, or the error
display), a 1.2 s settle for mounted content, then every image in the viewport `complete` with a `naturalWidth`
(up to 15 s, then a warning), each loaded one `decode()`d (up to 5 s more). Safari paints lazy, async-decoded images late, and a wait over an
empty list of images passes before the content mounts, so the settle comes first. A dev server keeps a failed story
index until the broken file changes again: shoot touches the file the error names (under `shoot.storybookDir`, default
`apps/storybook`) and retries, and reloads a story that shows the Vite error overlay, up to 6 times. A story the
overlay never leaves, or one on Storybook's error display, gets no picture: the run goes on with the others and
then fails naming them.

| `--browser=` | Engine |
|---|---|
| `chromium` | Playwright's Chromium, the `chromium` channel (not the headless shell). |
| `firefox` | The installed `/Applications/Firefox.app` over WebDriver BiDi (Playwright's `moz-firefox` channel). Playwright's own patched Firefox does not start on macOS 27 ("Could not find profile folder"), and it is not the Firefox users run. |
| `webkit` | Playwright's WebKit. It renders like Safari but has none of Safari's scrolling or settings: static layout only. |
| `safari` | Safari Technology Preview over its own `safaridriver`. Viewport pictures only (WebDriver), `fullPage` is ignored. |

Playwright stays the repository's own pinned devDependency (1.57 or later, the first that launches the
`moz-firefox` channel): repo-kit declares it as an optional peer and loads it from
the repository root, and `safari` needs none. `firefox` needs Firefox installed.

Safari itself refuses WebDriver while the user has it open, so `safari` drives Safari Technology Preview, which runs
beside it. One-time setup: `brew install --cask safari-technology-preview` (the installer asks for an
administrator password), then in its own Settings, Advanced → "Show features for web developers" and Developer →
"Allow remote automation". safaridriver brings the window to the front; shoot hands focus straight back to the app
that had it, and the window keeps drawing behind the user's apps. When the run ends, shoot quits the automation window
it started (SIGTERM: in automation mode it ignores a quit request and window close). Do not hide or minimise it: WebKit then marks the
page hidden, stops drawing frames and cannot screenshot. A run that ended without closing its session (killed, or its
safaridriver gone) leaves Safari Technology Preview "already paired with another WebDriver session"; when no other
live safaridriver of it runs (one a repo-kit run started, recorded with its start time in the temporary directory,
whose run was killed is orphaned to launchd, ppid 1, and is stopped; any other driver counts as live), shoot quits
that automation window (`--automation`, never the user's own) and starts again, and when one runs, it fails naming
that driver. SIGTERM and SIGHUP close the browser before the run exits. A run quits only the automation window its
own session started, so two runs starting together never quit each other's; an automation window a session
attaches to without starting it (one an earlier quit left behind) stays open until a restart quits it. Safari keeps a minimum window size: a
`--width` narrower than the viewport it gives fails the run instead of saving a wider picture under that name; a
height the display cannot fit warns.

```js
// repo-kit.config.mjs; every field is optional
export default {
  shoot: { url: "http://127.0.0.1:6010", storybookDir: "apps/storybook", slots: 1 },
};
```

The module is exported as `@maxvyshniakov/repo-kit/shoot` (`parseShootArgs`, `launchBrowser`, `shootStories`) for a
check that needs the same engines.

## Release gate

`publish` publishes a commit only after the release gate passed on it. `repo-kit.config.mjs` chooses the gate with one
line:

```js
export default {
  release: { gate: "local" }, // the default: a local run of repo-kit release-gate
  // release: { gate: "ci" }, // the configured remote checks workflow
};
```

Gate `local` is the default. It verifies a release revision on the invoking machine and records its result.
Its browser checks use software compositing where configured. Choose `ci` when publication must depend on the
configured remote workflow results rather than a local gate.

### Gate `local`

```sh
git fetch origin && bun run repo-kit release-gate origin/main   # after the release commit is pushed
bun run release:publish
```

`repo-kit release-gate [<ref>]` (default `HEAD`) runs under one slotfather lease (the larger of `verify.slots` and
`verify.browserSlots`):

1. the TLS gate, the Bun floor and the token, before any install;
2. a clean temporary worktree of the exact commit and `bun install --frozen-lockfile`;
3. when the commit has Playwright: `bunx playwright install --no-shell chromium` (as `browser.yml` does), then a mirror
   of Playwright's browsers directory in which every Chromium executable starts the real one with `--disable-gpu`.
   Every check that starts Playwright's Chromium (Playwright's `launch`, agent-browser behind a repository's wrapper,
   a check's own `chromium.launch`) runs through it, because the gate points `PLAYWRIGHT_BROWSERS_PATH` at the mirror.
   Before the checks, the gate asks the wrapped Chromium (DevTools `SystemInfo.getInfo`) and stops unless it reports
   `gpu_compositing: disabled_software`; on a Mac the same Chromium reports `enabled` (Metal) without the switch.
   `REPO_KIT_CHROMIUM_SWITCHES` names the switches for a runner that starts a browser of its own;
4. `bun run verify -- --release`;
5. `bun run verify -- --browser` when the commit's config declares `verify.browser`. The gate fails if that starts no
   Chromium through the mirror, and fails if the commit declares browser checks but has no Playwright.

On a pass it records the commit status `Library checks (local, macOS)` with a summary: host, duration, kit version,
the number of software-compositing Chromium launches, and the local log, `.git/repo-kit-gate/<sha>.log`. A failure
records `failure`. Without a token with `repo` scope it refuses to start.

A commit that passed is listed in `.git/repo-kit-gate/passed` and is not run again: a commit GitHub did not have yet
passes, and the run after the push only records its status. `--rerun` runs it again; `--no-attest` records nothing on
GitHub.

`publish` reads the commit's newest `Library checks (local, …)` status and refuses unless it is `success`: missing,
pending and failed statuses each name the command to run. Inside GitHub Actions, as in Data Grid's automated catalog
release, the calling workflow's jobs gate the publication under either gate; publish says so.

Measured on a consumer: a scroll-fade check broken by a rounded-clip defect passed on a Mac's GPU path and failed
through the mirror with the Linux CI failure's assertion; after the fix it passed through the mirror.

### Gate `ci`

`release: { gate: "ci" }` restores the behaviour from before `release.gate` existed: `publish` waits for `publish.checks`
(`check.yml`) on the commit and refuses when it failed, was cancelled or never started; `publish.checks: false` skips
the wait with a warning. `release-gate` still runs, and its status is for information only.

### The workflows under each gate

The reusable workflows remain available in both modes and use the runner configured by each consumer. Under gate `local` they are advisory:
nothing waits for them.

| Job | Gate `local` | Gate `ci` |
|---|---|---|
| `check.yml`: `verify.yml`, `browser.yml` | advisory | `publish` waits for the run |
| `deploy-storybook.yml` | runs whatever the checks concluded (`repo-kit ci-gate`) | runs only after every needed job passed |
| Data Grid's `dependency-release` (`release.yml`) | stays behind its own check jobs in CI | the same |

The deploy and Data Grid's catalog automation stay in CI because they need the `storybook` environment's Cloudflare
token and the workflow's registry token there. They do not gate anything. For the deploy to run after a failed check,
its caller job needs `if: ${{ !cancelled() && … }}` and `needs: ${{ toJSON(needs) }}` (see [Workflows](#workflows));
a caller left as before still deploys only after its checks passed. A deploy could also run from a workstation
(`bun run storybook:prepare-deploy && bun run storybook:deploy` with `CLOUDFLARE_API_TOKEN` set), which would take
the runner out of the release path entirely; it is not wired up.

Repo-Kit does not need branch protection or a ruleset: the commit statuses are the record and `publish` the
enforcement. If a repository enables protection, require `Library checks (local, macOS)` under gate `local`, or the
`check.yml` jobs under gate `ci`, not both.

## GITHUB_TOKEN

`bunfig.toml` reads `@maxvyshniakov` packages with `token = "$GITHUB_TOKEN"`. Every `bun install` in these
repositories needs it, when the lockfile contains those packages:

- **Locally:** `export GITHUB_TOKEN=$(gh auth token)`. The token needs `read:packages` to install and `write:packages`
  to publish (`gh auth refresh -s write:packages`).
- **pre-push hook:** installs in a temporary worktree. When `GITHUB_TOKEN` is unset, it uses `gh auth token`. Without
  either it warns, and a failed install names the fix.
- **publish** and **release-gate:** also fall back to `gh auth token`. The release gate's commit status needs `repo`
  scope (`gh` grants it by default).
- **CI:** the workflow token. The caller grants `packages: read`, and the package's Actions access lists the repository
  (Package settings → Manage Actions access).

## TLS gate

Bun 1.3.14 trusted the compromised eMudhra chains; Bun 1.4.4 rejects all 12 fixtures.

`src/tls-gate.mjs` is a dependency-free live check on the actual Bun runtime's `fetch` and `https` clients:

- `registry.npmjs.org` must succeed;
- every `*.we-have-a-problem.com` incident host must fail with a trust-chain rejection;
- DNS errors and timeouts fail closed.

Where it runs:

- the composite action runs it before `bun install`;
- `publish` runs it before the token reaches any request;
- the pre-push hook refuses a local Bun older than 1.4.4.

Each environment has its own trust boundary. Node, Git, downloaded actions and containers need their own
verification. Do not disable certificate verification.

## Workflows

The caller keeps `.github/workflows/check.yml` (publish waits for it under gate `ci`; under gate `local` it is
advisory), with its triggers, concurrency and permissions, and calls the reusable workflows at the installed kit's tag:

```yaml
name: Library checks
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
  packages: read
concurrency:
  group: checks-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  check:
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.6.0
  browser:
    uses: maxvyshniakov/repo-kit/.github/workflows/browser.yml@v0.6.0
    with:
      checks: '[{"name": "stories", "run": "bun run check:stories -- --no-build"}]'
  # !cancelled() lets the deploy start when a check failed; repo-kit ci-gate then
  # deploys under release.gate "local" and does nothing under "ci".
  deploy:
    needs: [check, browser]
    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}
    uses: maxvyshniakov/repo-kit/.github/workflows/deploy-storybook.yml@v0.6.0
    with:
      url: https://catalog.example.com
      needs: ${{ toJSON(needs) }}
    secrets: inherit   # the job reads STORYBOOK_CLOUDFLARE_API_TOKEN from the storybook environment
```

| Workflow | Inputs |
|---|---|
| `verify.yml` | `args` (none; `--release` is added for `main` and pull requests into `main`), `slots` (`all`), `slot-wait` (0: wait as long as the job runs), `runner`, `timeout-minutes` (20), `fetch-depth` (1; 0 for a [changelog-entries](#changelog-entries) range step), `verified-url`, `junit`, `junit-artifact` |
| `browser.yml` | `checks` (JSON list of `{name, run}`), `build`, `playwright` (true), `slots` (`all`: the build and every check lease them together), `slot-wait` (0), `runner`, `timeout-minutes` (45: the wait, the build and every check), `verified-url`, `junit`, `junit-artifact` |
| `deploy-storybook.yml` | `url`, `needs` (the caller's `toJSON(needs)`, for `repo-kit ci-gate`; default `{}`), `environment` (`storybook`), `runner`, `slots` (`all`, for the builds and `storybook:prepare-deploy`), `slot-wait` (0), `timeout-minutes` (30); `STORYBOOK_CLOUDFLARE_API_TOKEN` from that environment, with `secrets: inherit` |
| `release.yml` | `command` (`bun run release:publish`), `enabled` (true), `slots` (`all`), `slot-wait` (0), `runner`, `timeout-minutes` (30); the caller grants `contents: write`, `packages: write` |
| `verified-tree.yml` | `plans` (required), `branches` (`["main", "dev"]`), `depth` (100), `force` (false), `runner`; output `urls`; the caller grants `contents: read`, `checks: read`, `statuses: read`, `actions: read` to this job |

`runner` is `runs-on` as JSON and defaults to `'["ubuntu-latest"]'`. A private repository may name a self-hosted
runner, for example `'["self-hosted", "homelab"]'`. When the caller's repository is public and `runner` contains
`self-hosted`, the job runs on `ubuntu-latest` instead and its first step fails: a pull request from a fork chooses
the code a public repository's runner executes. Name self-hosted runners with the `self-hosted` label so the guard
sees them. A `schedule` event carries no repository visibility, so the guard does not act on nightly runs; they run
the default branch's own workflow, not a fork's.

Every heavy step of these workflows runs under a slotfather lease where the runner has slotfather: `verify`, the
browser build and checks, the Storybook builds and `storybook:prepare-deploy`, and the release command. What runs
outside one is light: checkout, the TLS gate, `bun install`, the cached Playwright browser and the Cloudflare upload.
`slots` defaults to `all`, the whole runner, so no heavy job runs beside another and each gets the runner's memory; a job waits
for the lease instead. `verify.yml` passes `slots` to verify as `REPO_KIT_VERIFY_SLOTS`, which overrides
`verify.slots` and `verify.browserSlots`.

`browser.yml` builds once and runs its checks one after another in one job, `repo-kit checks`: every check runs,
after a failed one too, and the job fails naming the failed ones. Under a lease of the whole runner a job per check
could not run side by side with another anyway, and each built Storybook again: three concurrent builds exhausted a
10 GiB runner. Set
`timeout-minutes` to cover the lease wait plus the build and every check.

### Skipping a verified tree

A check result belongs to a tree and a plan, not to a branch or a commit. The tree (`git rev-parse <sha>^{tree}`)
holds the workflow files, `repo-kit.config.mjs` and the lockfile, so two commits with one tree run the same checks
the same way: promoting dev to main, merging a pull request that was up to date, or a nightly run on an unchanged
main. `verified-tree.yml` looks for such a result before the heavy jobs start:

1. It reads the tree of the workflow's commit and compares it with the newest `depth` commits of each of
   `branches`, the commit itself and a pull request's head.
2. On each commit with that tree it reads the check runs (the jobs of earlier workflow runs, named
   `<caller job> / <job>`) and the commit statuses (the newest per context, such as the local release gate's
   `Library checks (local, macOS)`).
3. `plans` maps each plan name to the check names or status contexts that count as passing it; a trailing `*`
   accepts a prefix. A plan reuses the first success it accepts. A plan whose checks changed never matches,
   because a renamed or added check changes the job name (`browser.yml`'s job is named by its checks joined with
   ` + `, so `[{"name": "stories"}]` runs as `browser / stories`).
   A check run counts only when GitHub Actions ran it from the caller's own workflow file in the same release
   mode: `verify.yml` adds `--release` on `main` and on pull requests into `main`, so a pull request into `dev`
   never verifies a main push. A commit status counts by its context alone.
4. The `urls` output maps each plan to that result's link, or `""`. `verify.yml` and `browser.yml` take it as
   `verified-url`: when it is set the job runs no step but one, which links the reused result in the job summary,
   and the job passes. Give those jobs `if: ${{ !cancelled() }}` and
   `verified-url: ${{ needs.tree.result == 'success' && fromJSON(needs.tree.outputs.urls).verify || '' }}`, so a
   failed lookup runs the checks instead of skipping them. `force: true` (the template passes it on a manual run)
   runs every plan.

The lookup checks nothing out and installs nothing: `actions/verified-tree` runs `src/verified-tree.mjs` with
Node against GitHub's API. When GitHub cannot answer, every plan runs. `repo-kit verified-tree` is the same step
for a job of your own (`REPO_KIT_PLANS`, `REPO_KIT_BRANCHES`, `REPO_KIT_DEPTH`, `REPO_KIT_HEAD_SHA`, `GITHUB_TOKEN`).

The runner is outside the tree too: a local gate status ran `verify --release` and the browser checks on macOS.
Leave the local gate out of a plan when you want its Linux run on every tree.

### Triggers: fast checks on main, the full suite nightly and on release

[docs/templates/check.yml](templates/check.yml) is a complete caller. Main pushes run `verify`; the browser suite
runs nightly (`schedule`), on `v*` tags, on pull requests and on a manual run; changes to Markdown and `docs/` start
no run (`paths-ignore`); every heavy job first asks `verified-tree.yml`. Under release gate `local` the checks are
advisory, so moving the browser suite off main pushes costs at most a day of Linux coverage; releases are gated on
the Mac. A pull request whose checks are required stays pending when `paths-ignore` starts no run: keep required
checks off docs-only pull requests, or drop the filter there.

### JUnit reports

`junit` names paths or globs (one per line) of JUnit reports the job's commands write, for example a test runner's
`--reporter=junit` output; after the job they are uploaded as the artifact `junit-artifact` (default
`junit-<job>-<attempt>`) for 30 days, after a failed or timed-out job too. In `browser.yml`, `repo-kit checks` also writes its per-check results and
times to `repo-kit-junit/checks.xml` (`REPO_KIT_CHECKS_JUNIT`) and that file is uploaded with them. A workflow
calling `browser.yml` twice with `junit` gives each call its own `junit-artifact`.

Jobs show as `<caller job> / <reusable job>`, for example `check / verify`, `browser / browser + stories` (named by
its checks) and `deploy / Publish private Storybook`.

A cancelled run counts as failed for `publish` under gate `ci`, so `cancel-in-progress` covers pull requests only.

`actions/setup-bun` installs Bun 1.4.4, runs the TLS gate, then `bun install --frozen-lockfile` with `token`.
Jobs that do not use a reusable workflow call it directly:
`uses: maxvyshniakov/repo-kit/actions/setup-bun@v0.6.0`.

Any repository can call these while repo-kit is public. A private copy needs its Settings → Actions → General →
Access set to "Accessible from repositories owned by the user".

The default `runner`, `["self-hosted", "homelab"]`, is the maintainer's runner; pass your own. The verification,
browser and Storybook jobs declare `contents: read` and `packages: read`, and `release.yml` `contents: write` and
`packages: write`: a called job never receives more than its caller grants, and these never more than they declare.
None of the workflows uses `pull_request_target`. Do not route pull requests from forks to a self-hosted runner.

## Versioning

repo-kit follows the same changelog rules as the libraries. Consumer-visible changes go under `## Unreleased`.
Changelog sections: Breaking, Added, Changed, Deprecated, Removed, Fixed and Security. Before 1.0.0, a breaking
change is a minor release.

A release:

1. Cut the version with `bun run release -- <patch|minor|major>`. This also moves every `maxvyshniakov/repo-kit/...@v`
   reference in the workflows, README and this reference to the new tag. The reusable workflows reference the action at that
   tag, which `publish` creates on the release commit.
2. Push the release commit to `main`.
3. Run `bun run repo-kit release-gate origin/main`, then `bun run release:publish` (gate `local`, this repository's
   default). Under gate `ci`, run `release:publish` once Library checks pass on `main`; repo-kit's own checks use
   `./actions/setup-bun` from the commit itself, so they run before the tag exists.
4. Raise the pinned version in each repository and run `bun run repo-kit hooks sync`. Update the workflow references;
   `repo-kit check` fails until they match.

## Developing

`bun run verify` runs:

- the changelog check;
- `repo-kit check` on this repository;
- a comparison of `hooks/reference-transaction` with Lanefather's canonical copy (skipped without a checkout);
- the tests;
- the packed-consumer check.

The pre-push hook runs the same. This repository uses `main` for everyday work;
version tags identify releases. Its `prePush.releaseBranches: []` keeps ordinary
main pushes compatible with `Unreleased` entries. `release-gate` still runs
`verify --release` before package publication. Consumers default to release
validation on `main`; they can configure `prePush.releaseBranches` themselves.

Agent commands and repository policy: [checks](agents/checks.md),
[publishing](agents/publishing.md), [orchestration](agents/orchestration.md).

`hooks/reference-transaction` comes from Lanefather's `hooks/reference-transaction`: one writer for `main` and
`dev`, using the landing lock held by `lanefather promote` (or the project's configured entry point). repo-kit
distributes the exact copy, pinned by `REFERENCE_TRANSACTION_SHA256` in `src/hooks.mjs`, and installs it in
consumers' managed hooks. Repo-kit's own single-branch checkout omits it. `check:upstream` compares it with
`LANEFATHER_DIR/hooks/reference-transaction`; the checkout defaults to `~/lanefather` and the check is skipped
without one. `LANEFATHER_DIR` selects a
source checkout for this comparison, not the runtime engine.

When Lanefather's canonical hook changes:

1. copy it here;
2. update the hash;
3. release.
