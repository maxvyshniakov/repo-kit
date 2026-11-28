# Package-Kit reference

[Overview and quick start](../README.md)

Configuration, command details and integration contracts for the shared toolkit. Examples use the package's
own GitHub scope and some existing consumers; replace consumer repositories, endpoints and runner choices with
your project's values. The [README](../README.md) explains fit, requirements and the minimal setup.

## Install

```sh
bun add --dev --exact @maxvyshniakov/package-kit
```

The package is on npmjs.org, so installing it needs no token. A repository's other `@maxvyshniakov` packages on
GitHub Packages still need the scope in `bunfig.toml` and a token: [GITHUB_TOKEN](#github_token).
Before the rename it was `@maxvyshniakov/repo-kit` (GitHub Packages, 0.10.0 and older); a repository that still has
`repo-kit.config.mjs` and no `package-kit.config.mjs` fails with what to rename, and a `REPO_KIT_*` variable that is
still set is named on stderr with its `PACKAGE_KIT_*` replacement.

Pin the exact version. Each commit is verified by the kit its lockfile records, so the pre-push hook
checks an older commit with that commit's kit.

## package.json

The command names stay as they were, so instructions and skills that name them keep working:

```json
{
  "scripts": {
    "prepare": "package-kit hooks install",
    "verify": "package-kit verify",
    "verify:browser": "package-kit verify --browser",
    "check:kit": "package-kit check",
    "check:changelogs": "package-kit check-changelogs",
    "check:consumer": "package-kit packed-consumer",
    "release": "package-kit release",
    "release:publish": "package-kit publish",
    "shoot:stories": "package-kit shoot"
  }
}
```

`package-kit verify` and `package-kit pre-push` take their own slotfather lease (`verify.slots`, `verify.browserSlots`,
`prePush.slots`). Other heavy scripts wrap themselves: `"check:stories": "package-kit heavy 2 bun scripts/run-story-checks.mjs"`.
Slotfather priority defaults to `normal`; ticket is optional. For tagged ad-hoc
runs, use `slotfather run -n K --priority interactive --ticket ID -- package-kit ...`.
The kit detects the inherited lease and does not acquire a second one. Lane
registration and integration belong to the project's orchestration contract;
package-kit owns verification execution rather than lane lifecycle.

`PACKAGE_KIT_SLOT_WAIT=<seconds>` makes every lease give up after that long (slotfather exits 75), so a CI job fails with
that reason instead of reaching its time limit while queued.

The memory a run may use is the leased slots times slotfather's `gib_per_slot` (for example, 5 GiB per slot), capped
by the job's cgroup limit and Linux's MemAvailable; without a lease, MemAvailable on Linux and all memory elsewhere.
On hosts without a per-slot memory budget, cores decide. `PACKAGE_KIT_VERIFY_MEMORY_GIB` and `PACKAGE_KIT_VERIFY_CORES`
override the figures.

## package-kit.config.mjs

At the repository root. Every field is optional except the steps `verify` runs.

```js
import { chain } from "@maxvyshniakov/package-kit";

export default {
  verify: {
    // bun arguments; a step starts once every step in `needs` has passed and its
    // memory (GiB at its peak, as the summary measures it) fits beside the running steps.
    steps: ({ release }) => [
      { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])], memory: 0.1 },
      { name: "kit", command: ["run", "check:kit"], memory: 0.1 },
      { name: "lint", command: ["run", "lint"], memory: 0.3 },
      // VITEST_MAX_WORKERS and PACKAGE_KIT_WORKERS from the run's cores and memory;
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
    registry: "github",    // "github" (GitHub Packages, the default), "npm" (npmjs.org) or ["github", "npm"], in that order
    access: "public",      // npm's --access on npmjs.org: "public" (the default) or "restricted"
  },
  changelog: {
    quickStart: "docs/GETTING_STARTED.md", // archive names checked and moved by release, when the file exists
    peerScope: "@maxvyshniakov/",          // peer ranges checked against workspace versions and exact devDependency pins
    paths: ["packages/sid-kit/src/**"],    // shipped paths: the changelog-entry guard (Changelog entries); default none, off
  },
  hooks: {
    managed: ["pre-push", "commit-msg"],   // the managed hooks sync writes and check expects; default every one that applies
  },
  release: {
    gate: "local",  // what publish requires: "local" (default), a passed `package-kit release-gate`; "ci", the checks workflow
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

Every released package keeps its name and version in `package.json`; a repository without one fails with
"package.json not found". `changelog.versionSource` and `pyproject.toml` packages were removed in 0.10.0.

### Unknown keys

`loadConfig` rejects a key it does not know before any command runs: an unknown section, an unknown key of a section
or of a `publish.notify` target, and, when the steps are built, an unknown key of a step in `verify.steps` or
`verify.browser`. The error names the key's path, the nearest known key and the keys the section takes:

```text
package-kit: package-kit.config.mjs:
  unknown key verify.cheapp; did you mean cheap? It is a key of each verify step (known: steps, browser, slots, ...)
  adopt: package-kit adopt was removed in 0.10.0; delete the adopt section
```

The keys are `CONFIG_KEYS`, `NOTIFY_KEYS` and `STEP_KEYS` in `src/config.mjs`; a test keeps them equal to the keys
`src/` reads.

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
`PACKAGE_KIT_STEP_SLOTS`, for a check that sizes its own browser pool.

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

### Change-aware selection and planning

Each step in `verify.steps` or `verify.browser` (and in `chain()` option objects) may declare path scopes and tier metadata:

```js
export default {
  verify: {
    inert: ["**/*.md", "docs/**"],
    runner: ["package-kit.config.mjs"],
    canary: ["unit tests"],
    smoke: ({ plan }) => ["verify:lint", ...plan.checks.filter(r => r.suite === "browser" && !r.producer).map(r => r.id)],
    steps: [
      { name: "lint", command: ["run", "lint"], always: true, cheap: true, memory: 0.3 },
      { name: "unit tests", command: ["run", "test"], inputs: ["packages/*/src/**"], usesCores: true },
    ],
    browser: chain([
      ["build", ["run", "build"], { inputs: ["packages/*/src/**"] }],
      [
        ["browser checks", ["run", "check:browser", "--", "--no-build"], {
          slots: 2,
          inputs: ["packages/*/src/components/**"],
          scopeArgs: ({ matchedPaths, full }) => full ? [] : [...new Set(matchedPaths.map(p => p.split("/")[3]).filter(Boolean))],
        }],
      ],
    ]),
  },
};
```

- `inputs`: repository-relative globs (`*`, `?`, `**`, `{a,b}`, trailing `/`, `!` exclusions). A step also transitively triggers when a producer in its `needs` matches a changed path, and selecting a step pulls in its `needs` as producers.
- `always: true`: runs on every non-empty change; its `inputs` still own their paths.
- `inert`: globs for tracked paths no check reads. Any changed path matching no check's `inputs`, no `runner`, and no `inert` is reported in `unowned` and falls back to a full run.
- `runner` + `canary`: when a `runner` path changes, `canary` checks run instead of forcing a full run.
- `cheap: true`: runs in the cheap-first tier (with its `needs`) before heavier steps; any failure in the cheap tier stops heavier steps from starting.
- `scopeArgs({ paths, matchedPaths, full, release })`: returns extra CLI arguments appended to `command` on scoped runs (`full: false`), or `[]` on full runs (`full: true`).
- `smoke`: array of check names/IDs, function `({ paths, plan, checks }) => ids`, or `smoke: true` on steps; queried via `package-kit-lane --changed --base REF --plan --smoke --json` or `planSmoke()`.
- Consumers that declare no `inputs`, `always`, `inert`, or `runner` keep the legacy `full: true` behavior unchanged.

## Commands

| Command | Does |
|---|---|
| `verify [--release] [--browser] [--changed] [--base REF] [--plan] [--json] [--no-reuse] [--keep-going]` | Runs the config's steps side by side, within the run's memory. Output streams with a step prefix. The first failure stops the rest (unless `--keep-going` is set, which lets independent steps finish while dependants stay blocked) and prints that step's last 80 lines; a step past its timeout fails and its whole process tree is stopped; a signal stops every step, and a reaper stops them when verify is killed outright. With `--changed [--base REF]` (default `HEAD`), runs only checks whose `inputs` (or transitive `needs` producers' `inputs`) changed, plus `always` checks, falling back to a full run when an unowned path changed (`--plan [--json]` prints the plan without taking a lease or running checks). Steps with `cheap: true` run in the cheap-first tier before heavier steps; a red cheap step stops heavier steps from starting. On a clean committed checkout, passed checks are reused per `(HEAD^{tree}, platform, command, runtime, transitive needs)` unless `--no-reuse`, `PACKAGE_KIT_NO_REUSE=1`, or a local-source override (such as `SID_KIT_SOURCE`) is set (producers still run if any dependent is uncached). Under a `--yieldable` Slotfather lease (`SLOTFATHER_YIELD`), yields between checks when a waiter asks. The summary shows the peak RSS and each step's measured peak beside its declared `memory`: the resident memory of the step's whole process tree, browsers in sessions of their own included, and on Linux the job cgroup's peak. |
| `pre-push` | Runs from `.githooks/pre-push`. Verifies each pushed commit in a clean temporary worktree (`--release` for `main`), once per commit. Refuses Bun older than 1.4.4. Skip once with `git push --no-verify`. |
| `hooks install` | `prepare`: points `core.hooksPath` at `.githooks`, unless someone set another path or `CI` is set. |
| `hooks sync` | Writes the managed hooks into `.githooks`: a `pre-push` shim and `reference-transaction`; `lane-check` with a `.lanefather.toml`; `commit-msg` with `changelog.paths`. `hooks.managed` keeps only the named ones. Other hooks there are the repository's own, and an existing `commit-msg` of its own is never replaced. |
| `hooks check` / `hooks status` | The tracked managed hooks match the kit / Git would run every tracked hook. |
| `check` | `hooks check`. Every `maxvyshniakov/package-kit/...@` reference in `.github/workflows` names the installed version. `packageManager` names `bun@1.4.4`. |
| `check-changelogs [--release]` | Changelog format (including one `### <Heading>` of each kind per release), version agreement (`package.json`, the newest release, `bun.lock`, quick start archives) and peer ranges. `--release`: no unreleased entries. |
| `check-changelog-entries <base>..<head>` | The [changelog-entry guard](#changelog-entries) on every commit of the range. Without `changelog.paths`, nothing. |
| `commit-msg <message file>` | Runs from `.githooks/commit-msg`: the same guard on the commit being made. Skip once with `git commit --no-verify`. |
| `release [<package>:]<patch\|minor\|major\|x.y.z> [--date=]` | Cuts `## Unreleased` into a version; sets `package.json`, `bun.lock` and the quick start. |
| `release-gate [<ref>] [--rerun] [--no-attest]` | The local [release gate](#release-gate) on a commit (default `HEAD`): a clean worktree, frozen install, `verify --release`, `verify --browser` with Chromium in software compositing; records the commit status `Library checks (local, <os>-<arch>)`, such as `(local, darwin-arm64)`. `--mode` prints `release.gate`. |
| `ci-gate` | In a workflow job that needs the checks (`deploy-storybook.yml`): writes `run=true` under gate `local`, or under gate `ci` when every job in `PACKAGE_KIT_NEEDS` (the caller's `toJSON(needs)`) passed. |
| `publish [--resume]` / `publish --prerelease <preid> --dist-tag <tag> [--ref <ref>] [--dry-run]` | Release mode: HEAD must be `origin/main` by SHA (any branch, worktree or detached HEAD); the [release gate](#release-gate) on that commit: a passed `release-gate` status (gate `local`) or the checks workflow (gate `ci`), not inside Actions; publishes to `publish.registry` ([npmjs.org](#publishing-to-npmjsorg) packs one archive and checks it first), waits until every registry serves the version, tags `v<version>` (GH007 recovery printed when the tag push is declined), then requests `publish.notify`. `--resume` finishes a partial publication: the registries still missing the version, then the tag. [Prerelease mode](#prerelease-publishing): archives a captured commit (`HEAD` or `--ref`), bumps `X.Y.Z-<preid>.N` from the registry, skips the release gate, never tags or mutates the checkout, refuses `--dist-tag latest`, and prints the published version on the last line of stdout. |
| `notify` | Requests `publish.notify`'s workflows again. |
| `heavy <slots\|all> <command...>` | Runs a command under `slotfather run -n <slots>` when slotfather is on PATH and no lease is held; otherwise directly. |
| `packed-consumer [--keep]` | Packs (or, from `publish`, takes the archive it is about to upload), installs into a temporary consumer, imports every entrypoint in plain Node, type-checks under `nodenext` without `skipLibCheck`, then runs the probes. Optional peers are not installed. |
| `shoot <story id filter...> [<url>\|--url=] [--theme=] [--width=] [--browser=] [--out=] [--viewport]` | [Story screenshots](#story-screenshots) from a running Storybook, under a lease of `shoot.slots`. |
| `serve <dir> [--port N] [--host 127.0.0.1]` | Dependency-free HTTP/1.1 Keep-Alive [static preview server](#static-preview-server) (`@maxvyshniakov/package-kit/serve`): high socket backlog (`2048`), `Cache-Control: no-cache` for `.html` and `.json`, `public, max-age=31536000, immutable` for hashed `/assets/*`, path-traversal guard (`403`) and clean MIME types. Use instead of `python3 -m http.server`. |
| `test-hygiene [--init\|--update] [--base REF] [--warn-lowered]` | [Shrink-only test rules](#test-hygiene): fixed sleeps, timing assertions outside the perf suite, and opt-in UI, CSS/DOM, browser-sleep, console-spy and browser-mock rules. Runs without `package-kit.config.mjs` too. |
| `verified-tree` | In a workflow: links each `PACKAGE_KIT_PLANS` plan to a passed result of the same tree ([skipping a verified tree](#skipping-a-verified-tree)). |
| `friction <log\|report\|export>` | Deprecated, moving to Mastack's `friction`; prints a deprecation line on stderr. The local [friction journal](#friction-journal): writes an event, ranks the journal, writes a redacted bundle to share. Needs no `package-kit.config.mjs`. |
| `tls`, `adopt`, `rust` | Removed in 0.10.0: each exits 1 and says what to use instead. |

## Test hygiene

`package-kit test-hygiene` (also exported as `@maxvyshniakov/package-kit/test-hygiene` with unified `maskJs` and rule functions) scans the test and configured browser-check files Git tracks (or would track) and counts, per rule and file:

| Rule | Finds | Allowed |
|---|---|---|
| `fixed-sleep` | `waitForTimeout(...)` and Python's `wait_for_timeout(...)` whatever the argument; a `new Promise(resolve => setTimeout(resolve, <n or NAME>))`, `sleep(<n>)`, `delay(<n>)` and `Bun.sleep(<n>)` of 50 ms or more; Python `time.sleep(<n>)`/`asyncio.sleep(<n>)` of 0.2 s or more; `Thread.sleep`, `Task.sleep`, a bare `sleep`/`usleep`, `runMain(for:)`, `thread::sleep` | a `sleep-ok: <reason>` comment on the line or right above it |
| `timing-assert` | an assertion bounding a measured duration from above: `assert.ok(Date.now() - started < 2000)`, `expect(elapsed).toBeLessThan(100)` (or chai's `below`, `lessThan`, `most`), `self.assertLess(elapsed, 0.2)` (ported from Straylight's `tools/perf-budget-check.py`; also Swift and Rust) | a budget through `perfBudget` / `perf_budget`; a deadline with a literal bound of at least 30 s, or a tighter one with a `load-tolerant: <why>` comment |
| `ui-assertion` (opt-in) | `toHaveClass(...)`, an asserted `.className`, `classList`, `getAttribute("class")`, or `.matches(".<class>")`, a string holding a CSS declaration (`"color: var(--x);"`) in an assertion | roles, states and data attributes (including `.matches("[role='button']")` and `.matches("[data-state='open']")`) |
| `classname-split` (opt-in) | splitting `.className` strings in tests (`.className.split(...)`, `?.trim().split(...)`, `(el.className ?? "").split(...)`) | roles, states and data attributes |
| `css-file-read` (opt-in) | reading `.css` files with `readFileSync` (directly, through tracked variables/loops/local helpers) or `readDataGridCss()` in tests | non-CSS file reads; browser/story computed-style checks |
| `unasserted-computed-style-spy` (opt-in) | spying on `window`/`globalThis.getComputedStyle` without a positive call assertion | `toHaveBeenCalled*()`, `toHaveBeenCalledTimes(1+)`, positive `mock.calls` length/equality assertions |
| `browser-fixed-sleep` (opt-in) | fixed sleeps in `browserChecks` minus `browserExclude`: `waitForTimeout(...)`, `new Promise(... setTimeout(..., ms))`, unpaired `setTimeout(..., ms)`, local/imported sleep wrappers (`pause`, `sleep`, `delay`, `wait`, including default-parameter wrappers), and string-evaluated sleeps in `eval`/`evaluate`/`page`/`chrome`/`browser("eval", ...)` | `setTimeout(..., 0)` and 1-arg `setTimeout(cb)` macrotask yields, `clearTimeout(<handle>)`-paired watchdogs, and `// sleep-ok: <reason>` comments |
| `unfiltered-console-spy` (opt-in) | suppressing `spyOn(console, "error" \| "warn")` (`.mockImplementation*` / `.mockReturnValue*`) without total call accountability, including `beforeEach` spies missing `afterEach` checks, negated partial matchers, and subset filters | `expect(spy).not.toHaveBeenCalled()` (or `expect(console.error).not.toHaveBeenCalled()`), `toHaveBeenCalledTimes(0)`, exhaustive `spy.mock.calls` equality, or exact call-count paired with positive argument assertions |
| `inline-browser-mock` (opt-in) | inline `ResizeObserver` / `matchMedia` `stubGlobal`, `Object.defineProperty`, `spyOn`, direct dot/bracket assignments (including TypeScript casts), and inline `ResizeObserver` classes in test files outside `mockAdapters` | shared adapters matching `mockAdapters` and restoring a saved original global in scope |

Only the helper exempts an assertion, in the perf suite as anywhere. Each file calling it must match `perfSuite`, or its
budgets never hold: that fails outright. The perf suite is the repository's own command: it runs those files alone,
with `PACKAGE_KIT_PERF_BUDGETS=enforce`, and the ordinary test command leaves them out.

The counts live in a baseline (`test-hygiene-baseline.json`, plus an optional `extraBaseline` for the six extra rules) and only shrink:

- `package-kit test-hygiene --init` writes any missing configured baseline file(s) with today's counts; it never overwrites an existing baseline and exits 1 when all configured baselines already exist.
- The check fails when a file gains a finding or a new file has one, naming each line.
- It fails when a count went down and the baseline still holds the old one: `--update` lowers it (and never raises, printing a message and skipping writes for any baseline that raises entries above the base commit). `--warn-lowered` prints lowered counts as a warning and exits 0 when no growth or raise occurred (still failing on any growth, raise, or unrun perf budget).
- Compared with the baseline of the base commit, no entry may rise. The base commit is resolved from `--base <ref>` (or `--base=<ref>`), `PACKAGE_KIT_HYGIENE_BASE`, or `PACKAGE_KIT_BASE`—an explicit base that cannot be resolved fails loudly with exit code 1. Without an explicit base, it picks the closest merge-base ancestor among `origin/dev`, `origin/HEAD`, and `origin/main` (falling back to `HEAD~1` when already on that ref, or `HEAD`). An entry may move with its file: the entries of files that no longer exist can be given to new paths.
- Counts are per file, so one wait can replace another in the same file; the lines are printed when a count grows.

```js
// package-kit.config.mjs, all optional
testHygiene: {
  baseline: "test-hygiene-baseline.json",
  // extraBaseline: "test-hygiene-extra-baseline.json", // optional separate baseline for the 6 extra rules
  tests: ["**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx,mts,cts}", "test/**/*.{js,mjs,cjs,ts,tsx,py}", "tests/**/*.{js,mjs,cjs,ts,tsx,py,rs,swift}", /* ... */],
  exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
  perfSuite: ["**/*.perf.{js,mjs,ts,tsx}", "**/perf/**", "**/test_perf_*.py", "**/*perf*.test.*"],
  // browserChecks: ["scripts/check-*.mjs", "scripts/*.browser.mjs", "scripts/lib/*.mjs"],
  // browserExclude: ["**/node_modules/**", "**/dist/**"],
  // mockAdapters: ["packages/my-lib/src/test/**"],
  ui: true,                                  // adds ui-assertion (unit tests: keep end-to-end tests out of `tests`)
  // rules: ["fixed-sleep", "timing-assert", "ui-assertion", "classname-split", "css-file-read", "unasserted-computed-style-spy", "browser-fixed-sleep", "unfiltered-console-spy", "inline-browser-mock"],
},
```

A budget goes through a `perfBudget(holds, message)` / `perf_budget` helper the repository defines beside its tests:
it fails a missed budget only in the perf suite, which runs alone on a quiet machine, and elsewhere reports it and
lets the test go on. `test-hygiene` recognises the helper by its name. (Package-Kit shipped one as
`@maxvyshniakov/package-kit/perf-budget` until 0.10.0.)

### Adopting it

Nothing runs until a repository adds the step, so a release of the kit turns no gate red. Run
`package-kit test-hygiene --init`, commit the baseline, then add the check to the gate:

- **Sid-Kit and Data Grid:** a verify step `{ name: "test hygiene", command: ["run", "package-kit", "test-hygiene"] }`
  (or a `check:hygiene` script) and `testHygiene: { ui: true }`. Measured on 2026-11-12: Sid-Kit 2 fixed sleeps,
  2 timing assertions and 757 UI assertions in 239 test files; Data Grid 0, 0 and 87 in 229. Their perf scripts
  (`perf:*`, run under a whole-machine lease) belong in `perfSuite`.
- **fathers** (Python, no `package-kit.config.mjs`): `bunx @maxvyshniakov/package-kit test-hygiene` from the repository
  root in `tools/check.py`, or a CI step. Measured: 23 fixed sleeps and 9 timing assertions in 85 test files,
  among them godfather's four `assertLess(time.monotonic() - started, ...)`.
- A scan of a few hundred test files takes 0.1–0.5 s.

## Friction journal

Moments an agent misread or misused a package, one JSON line each, so a retro
starts from counts instead of transcripts. Producers: `package-kit friction log`
(by hand, or by an agent when the package's skill says so), Sid-Kit's
`sid-kit-lint` (findings beyond the baseline), and optional Claude Code hooks and
transcript scanners (mastack). Everything stays on the machine.

- File: `FRICTION_JOURNAL`, else `$XDG_STATE_HOME/friction/events.jsonl`, else
  `~/.local/state/friction/events.jsonl` (directory 0700, file 0600).
  `FRICTION_JOURNAL=off` turns every writer off; `--journal FILE` reads or
  writes another file. Each event is one `write` with `O_APPEND`, so concurrent
  writers keep lines whole.
- Schema version 1 (`v: 1`). Readers skip lines of other versions and count
  them; unknown extra fields are kept and ignored. Renaming or retyping a field
  is version 2.
- The format's source is [`friction-contract.json`](../friction-contract.json),
  shipped in the package (`@maxvyshniakov/package-kit/friction-contract.json`): the
  schema (fields, kinds, limits, validation order and line encoding), how an
  event is built and written (schema order, a long detail cut, an invalid
  event refused with an error), the fingerprint rule (`fingerprint(...parts)`: the first 16 hex
  digits of SHA-256 over the parts joined by NUL) and the export redaction rules,
  plus golden cases: build (fields, working directory, environment and time to the
  exact line), write (an event as given to its line or refusal), validate (line
  to its problems, including the edge times `Date.parse` takes), fingerprint and
  redact. The table
  below summarises it. A change to its `schema` part needs a new `schema.version`
  and new cases; package-kit's tests run every case and hold a hash of the schema
  part per version.
- A writer in another language (Mastack's Python hook) keeps a pinned copy with
  its SHA-256, changed only by copying the file and updating the hash, as package-kit
  pins Lanefather's `hooks/reference-transaction`, and runs every writer case
  (build, write, validate, fingerprint) against itself.

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | `1` |
| `ts` | yes | ISO 8601 UTC time of the moment |
| `project` | yes | consuming repository (a linked worktree names its main repository) |
| `package` | yes | npm name of the package the friction is about |
| `kind` | yes | `lint-finding`, `selector-reach-in`, `type-error`, `owner-correction`, `misuse`, `vendored-patch`, `review-finding`, `note` |
| `component` | | the export involved, e.g. `Button` |
| `rule` | | lint rule, TypeScript code (`TS2322`) or review category |
| `detail` | | local text, at most 500 characters; never exported as written |
| `session` | | agent session id: `FRICTION_SESSION`, `CLAUDE_CODE_SESSION_ID` or `CODEX_SESSION_ID` |
| `source` | yes | the writer (`repo-kit`, `sid-kit-lint`, `mastack-hook`, ...) |
| `why` | | why a hook or scanner flagged it |
| `file` | | path relative to the project, or to the package for a vendored copy |
| `fingerprint` | | stable key of the underlying fact, so repeats count apart from distinct facts |

```sh
package-kit friction log --package @scope/kit --kind owner-correction --component Item \
  --detail "Item clamps its description; full text goes in ItemBody"
package-kit friction report --since 30d            # kinds, packages, top components, rules and triples
package-kit friction report --package @scope/kit --json
package-kit friction export --since 30d --out friction.json
```

`report` counts events, distinct facts (fingerprints), sessions and projects per
row. `export` writes the bundle a person reads and sends: package, component,
rule and kind with those counts and a template paraphrase ("TS2322 type error on
Button"), and the period as two dates. It leaves out projects, sessions, files,
times and every `detail`; a component or rule that is not an identifier becomes
`(other)`, an event whose package is not an npm name is dropped. `--notes` adds
up to three notes per row from corrections, misuse, review findings and notes,
redacted to at most 12 words with code, paths, URLs, addresses and long numbers
removed. Nothing is uploaded.

## Changelog entries

A package's changelog misses changes when nothing asks for an entry. The guard asks, deterministically, from Git alone:
a commit that changes a package's shipped paths adds, changes or removes a line under `## Unreleased` in that package's
`CHANGELOG.md`, or ends its message with the trailer `Changelog: none` and an optional reason.

```js
// package-kit.config.mjs
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
| cuts that package's release: its newest changelog release is newer and is the version the manifest now records, as after `package-kit release` | exempt |
| anything else, including only reordering lines or editing older releases' lines | fails, naming the files and the changelog |

The trailer is read as `git interpret-trailers` parses trailers: it belongs to the message's last paragraph, beside
`Co-Authored-By:` for example, not on the subject line. A `Changelog:` trailer with any other value fails and says so.
One `Changelog: none` covers the whole commit: in a repository with several packages it exempts every package the
commit changes. Split a commit that changes one package visibly and another invisibly, so the trailer cannot
cover a missing entry.

### Where it runs

- **commit-msg hook.** `package-kit hooks sync` writes `.githooks/commit-msg` when `changelog.paths` is set; `package-kit hooks
  install` (the `prepare` script) activates `.githooks`. It checks the index against `HEAD`, and against `HEAD`'s
  parent for `git commit --amend`, read from the `git` command line. An amend that line does not show (an alias, a
  hook manager, a GUI) usually keeps `HEAD`'s message: a commit with `HEAD`'s message that fails against `HEAD` is
  checked against its parent too, so the amended commit's entry counts. It skips merges in progress and `fixup!`,
  `squash!` and `amend!` commits, which the range check sees after they are folded in. It runs the installed kit,
  the main checkout's in a linked worktree, or a `package-kit` on `PATH` for a repository without `node_modules`. When
  it cannot run the kit (none installed, no `node` on the `PATH` Git hooks get, a kit without `commit-msg`) it prints
  one warning naming the fix and lets the commit through: the range check in verify or CI is the backstop.
  `git commit --no-verify` skips it once.
- **verify step.** `{ name: "changelog entries", command: ["run", "check:changelog-entries"] }` with
  `"check:changelog-entries": "package-kit check-changelog-entries origin/main..HEAD"` (the branch commits integrate into).
  The base must be in the checkout: in CI call `verify.yml` with `fetch-depth: 0`. A range Git cannot resolve fails.
- **CI on its own.** On a pull request: `package-kit check-changelog-entries ${{ github.event.pull_request.base.sha }}..${{ github.sha }}`
  after a checkout with `fetch-depth: 0`.

The range form checks every commit of the range against the current checkout's `changelog.paths`: adopt it in a
commit of its own, or with a base past the commits from before.

### For an AGENTS.md

A repository's agent instructions can link here and carry this paragraph:

> A commit that changes a shipped path (`changelog.paths` in `package-kit.config.mjs`) adds or changes a line under
> `## Unreleased` in that package's `CHANGELOG.md`, in the same commit. When the change is invisible to the package's
> users (tests, internal refactoring, tooling), end the message with the trailer `Changelog: none (<reason>)` instead.
> The commit-msg hook and `package-kit check-changelog-entries` enforce it; merges and release cuts are exempt, and one
> trailer covers every package the commit changes.

## Working with Lanefather

Package-Kit does not orchestrate parallel work; the maintainer's agents follow their own orchestration process.
[Lanefather](https://github.com/maxvyshniakov/fathers/tree/main/lanefather) supplies lanes, path claims, integration, independent
review and protected-branch promotion for projects that configure it. package-kit supplies verification and package
release/publish commands. Slotfather leases the machine while those commands execute; an active lane itself holds
no machine slots.

A consumer adopting parallel lanes keeps its check-contract adapter and project seams in `.lanefather.toml`.
Follow that project's orchestration instructions and configured command (`lanefather`, or a project wrapper):

| Phase | Owner and evidence |
|---|---|
| Implement and check a lane | Lanefather registers the lane and its claims. Its `check` calls the project's adapter and records a receipt for the committed inputs. package-kit's verification steps run where the adapter/config selects them. |
| Integrate and review | Lanefather `land` merges onto the integration branch, runs the configured post-merge smoke and starts the independent review. Findings receive the project's fix round before promotion. |
| Publish a batch | Lanefather `promote <sha>` takes the landing lock and pushes an explicit commit. A project with a verified-tree contract gets its configured batch gate. A library without that contract relies on package-kit's mandatory clean-worktree pre-push gate. |
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

`package-kit-lane` implements [Lanefather's check contract](https://github.com/maxvyshniakov/fathers/tree/main/lanefather#the-check-contract)
from the consumer's existing `verify.steps` and optional `verify.browser`. It selects checks by declared `inputs`, or all
checks when none are declared. Check IDs are the suite (`verify` or `browser`), a colon and the URL-encoded step name.
Requested checks include their dependencies; when both suites run, browser work waits for normal verification. Names and
commands come entirely from `package-kit.config.mjs`. Plans and reports advertise `capabilities: ["base"]` so Lanefather
passes `--base <ref>` on scoped lane check runs and their solo reruns. Failed check rows carry strictly-typed
`failure_evidence` v1 (`version`, `comparable`, `context`, `cases`) so `lanefather check` can classify pre-existing base
failures across worktrees.

A parallel-work consumer tracks `.lanefather.toml` with its own project facts and:

```toml
[checks]
verify = ".githooks/lane-check"
slot_env = "PACKAGE_KIT_SLOT"
```

Run `package-kit hooks sync` and commit the managed `.githooks/lane-check`. It works in a fresh linked checkout:
using the installed kit in this or the main checkout to lease a frozen dependency install, then executing the
adapter from the target checkout's locked package. Install the main checkout's dependencies once before starting
lanes. Keep the registry credentials available as for pre-push; the entry also resolves `gh auth token`.

The managed entry prepares dependencies under a one-slot lease even for planning. Direct `package-kit-lane
--changed --base REF --plan --json` reads configuration and Git without running checks. Execution uses Package-Kit's
existing scheduler, cancellation and timeouts. It leases the slots Lanefather gives it with `--jobs` (its check
contract: verify queues for its own `--jobs`-slot lease), no more than the selected suites' configured `slots` /
`browserSlots`, and the configured ones without `--jobs`. Where slotfather gives a slot memory (`gib_per_slot`), the
lease never holds less than the largest selected step's declared `memory`, which can exceed `--jobs`; a smaller lease
also means a smaller memory budget for side-by-side steps. `PACKAGE_KIT_VERIFY_SLOTS` still overrides it.
`--jobs` also caps automatically sized worker parallelism. Leases are labelled by lane and phase (`PACKAGE_KIT_SLOT_LABEL`
plus the phase from `PACKAGE_KIT_SLOT_META`, for example `lane-sk-api-surfaces check`), and elsewhere by project and
command (`sid-kit verify`, `sid-kit release-gate`, `sid-kit check:stories`), never by a bare directory name.
Steps that take `slots` share that lease (below). Explicit per-step worker counts remain project configuration. `PACKAGE_KIT_SLOT_LABEL`, `_PRIORITY`, `_TICKET`, `_META` and `_YIELDABLE` carry Lanefather's
execution context. The adapter honors `--keep-going` to collect independent results; ordinary `package-kit verify`
retains its fail-fast behavior. Reports and step logs live under the checkout's Git metadata, not in tracked source.

A run prints `Verification report: <path>` to a version-1 JSON report with the original commit/tree, each check's
status, log and blocking dependencies. Cancellation, failed setup or changed committed inputs cannot yield green
verification evidence. Lanefather remains responsible for receipts, review, landing and cleanup. When a full
run passes on a clean checkout and `lanefather` is on `PATH` with built-in stamping, the adapter records the
verified tree via `lanefather stamp record` and prints its `Verified tree <tree> stamped.` line; older or absent
`lanefather` installations degrade cleanly without failing the run. Pre-push and release attestations keep their
own contracts and still run when publishing.

Adding this adapter does not reconcile a previously published lane that never went through `land`. Keep that
historical completion separate; changing a published task's metadata does not manufacture its missing evidence.

Package-Kit's own repository has no lane adapter and uses one active `main` branch. Its task-worktree process is in
[orchestration](agents/orchestration.md); the explicit-SHA push, pre-push gate and CI procedure is in
[publishing](agents/publishing.md).

## Story screenshots

```sh
bun run shoot:stories -- button--default
bun run shoot:stories -- field --theme=light,dark --width=1280,375 --out=/tmp/shots
bun run shoot:stories -- showcase --browser=chromium,firefox,webkit,safari
bun run shoot:stories -- http://127.0.0.1:6020 badge --viewport     # no full page
```

`package-kit shoot` screenshots every story whose id contains one of the filters, in each theme (the `theme` global),
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
| `safari` | Real Safari Technology Preview through the background transport. Viewport pictures only; `fullPage` is ignored. |

Playwright stays the repository's own pinned devDependency: package-kit declares it as an optional peer (`>=1.50.0`)
and loads it from the repository root, and `safari` needs none. `firefox` needs Firefox installed and Playwright 1.57
or later, the first that launches the `moz-firefox` channel; on an older one `--browser=firefox` fails before it
starts, naming both versions, and the other browsers run as before.

Safari uses the background route extracted from Data Grid's real-STP harness: a shared lock,
non-activating `NSWorkspace` launch (the native `open -g` equivalent), a tokenized local page bridge, Accessibility window sizing, window capture and
continuous frontmost monitoring. It does not start WebDriver or activate another app afterward.
An already running STP instance is left alone and reported busy. The run closes only its owned
PID, page bridge and watcher; it also sweeps newly started Safari sync services while preserving the pre-run baseline. The lock is shared with existing real-STP checks. Launch is asynchronous and bounded; cleanup confirms process exit before succeeding.

STP, Swift command-line tools, and existing Accessibility/Screen Recording permissions are
required. Missing permissions fail without requesting a prompt. Placement keeps a 20-point band below maximized owner windows; capture checks page visibility. Hiding, minimising or fully covering the window stops rendering. A focus-guard failure aborts the run;
it is not a passed screenshot. A viewport width Safari cannot provide fails instead of writing a
mislabelled image; a height the display cannot fit warns. This transport's native runtime
acceptance must include frontmost monitoring, viewport cropping and cleanup; mocked tests alone
do not establish those properties on a machine.

```js
// package-kit.config.mjs; every field is optional
export default {
  shoot: { url: "http://127.0.0.1:6010", storybookDir: "apps/storybook", slots: 1 },
};
```

The background transport pieces (`acquireLock`, `startPage`, `backgroundLaunchArgs`) are exported
as `@maxvyshniakov/package-kit/safari-background` so native gesture harnesses can share the same
lock and page bridge after adopting this release, instead of maintaining copied launchers.

The module is exported as `@maxvyshniakov/package-kit/shoot` (`parseShootArgs`, `launchBrowser`, `shootStories`) for a
check that needs the same engines.

## Static preview server

```sh
package-kit serve apps/storybook/storybook-static --port 6020 --host 127.0.0.1
```

`package-kit serve <dir> [--port N] [--host 127.0.0.1]` runs a dependency-free Node HTTP/1.1 Keep-Alive static preview
server (defaults: `--port 6010 --host 127.0.0.1`, backlog `2048`, `keepAliveTimeout` 65 s). Use it instead of
`python3 -m http.server` for Storybook static builds and local previews:

- `python3 -m http.server` speaks HTTP/1.0 without Keep-Alive, listens with a 5-connection socket backlog, and sets
  no `Cache-Control` headers. Behind an HTTP/2 reverse proxy (`tailscale serve`), Safari's cold first load fires
  ~45 concurrent ES module requests (`assets/*.js`), resetting sockets (`502` / `Importing a module script failed.`)
  and serving stale `iframe.html` across rebuilds.
- `package-kit serve` keeps HTTP/1.1 connections alive with a `2048` listen backlog, supports `GET` and `HEAD`, serves
  `Cache-Control: no-cache` on `.html` and `.json` (`iframe.html`, `index.json`) and
  `public, max-age=31536000, immutable` on hashed `/assets/*`, rejects path traversal and escaping symlinks with
  `403`, answers `404` on missing files, and shuts down cleanly on `SIGINT`/`SIGTERM`.
- Exported as `@maxvyshniakov/package-kit/serve` (`startStaticServer`, `parseServeArgs`, `runServe`, `mimeTypeFor`,
  `cacheControlFor`, `resolveStaticFile`, `MIME_TYPES`).

## Release gate

`publish` publishes a commit only after the release gate passed on it. `package-kit.config.mjs` chooses the gate with one
line:

```js
export default {
  release: { gate: "local" }, // the default: a local run of package-kit release-gate
  // release: { gate: "ci" }, // the configured remote checks workflow
};
```

Gate `local` is the default. It verifies a release revision on the invoking machine and records its result.
Its browser checks use software compositing where configured. Choose `ci` when publication must depend on the
configured remote workflow results rather than a local gate.

### Gate `local`

```sh
git fetch origin && bun run package-kit release-gate origin/main   # after the release commit is pushed
bun run release:publish
```

`package-kit release-gate [<ref>]` (default `HEAD`) runs under one slotfather lease (the larger of `verify.slots` and
`verify.browserSlots`):

1. the Bun floor and the token, before any install;
2. a clean temporary worktree of the exact commit and `bun install --frozen-lockfile`;
3. when the commit has Playwright: `bunx playwright install --no-shell chromium` (as `browser.yml` does), then a mirror
   of Playwright's browsers directory in which every Chromium executable starts the real one with `--disable-gpu`.
   Every check that starts Playwright's Chromium (Playwright's `launch`, agent-browser behind a repository's wrapper,
   a check's own `chromium.launch`) runs through it, because the gate points `PLAYWRIGHT_BROWSERS_PATH` at the mirror.
   Before the checks, the gate asks the wrapped Chromium (DevTools `SystemInfo.getInfo`) and stops unless it reports
   `gpu_compositing: disabled_software`; on a Mac the same Chromium reports `enabled` (Metal) without the switch.
   `PACKAGE_KIT_CHROMIUM_SWITCHES` names the switches for a runner that starts a browser of its own;
4. `bun run verify -- --release`;
5. `bun run verify -- --browser` when the commit's config declares `verify.browser`. The gate fails if that starts no
   Chromium through the mirror, and fails if the commit declares browser checks but has no Playwright.

On a pass it records the commit status `Library checks (local, darwin-arm64)` (the gate's `<os>-<arch>`, in Node's
names) and, with the same state, the deprecated `Library checks (local, macOS)` (`Linux`, `Windows`) that package-kit 0.6.0
and older wrote, so a branch protection rule requiring the old name keeps passing; the next batched minor release stops
writing the old name. The status carries a summary: host, duration, kit version,
the number of software-compositing Chromium launches, and the local log, `.git/package-kit-gate/<sha>.log`. A failure
records `failure`. Without a token with `repo` scope it refuses to start.

A commit that passed is listed in `.git/package-kit-gate/passed` and is not run again: a commit GitHub did not have yet
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
| `deploy-storybook.yml` | runs whatever the checks concluded (`package-kit ci-gate`) | runs only after every needed job passed |
| Data Grid's `dependency-release` (`release.yml`) | stays behind its own check jobs in CI | the same |

The deploy and Data Grid's catalog automation stay in CI because they need the `storybook` environment's Cloudflare
token and the workflow's registry token there. They do not gate anything. For the deploy to run after a failed check,
its caller job needs `if: ${{ !cancelled() && … }}` and `needs: ${{ toJSON(needs) }}` (see [Workflows](#workflows));
a caller left as before still deploys only after its checks passed. A deploy could also run from a workstation
(`bun run storybook:prepare-deploy && bun run storybook:deploy` with `CLOUDFLARE_API_TOKEN` set), which would take
the runner out of the release path entirely; it is not wired up.

Package-Kit does not need branch protection or a ruleset: the commit statuses are the record and `publish` the
enforcement. If a repository enables protection, require `Library checks (local, darwin-arm64)` under gate `local`, or the
`check.yml` jobs under gate `ci`, not both. A rule that still requires the deprecated `Library checks (local, macOS)`
passes until the next batched minor; move it to the new context before then.

## Publishing to npmjs.org

`publish: { registry: "npm" }` publishes to npmjs.org instead of GitHub Packages, with npm trusted publishing: GitHub
Actions' OIDC token instead of a long-lived npm token, and from a public repository a provenance attestation. While
consumers still install the package from GitHub Packages (`bunfig.toml` and `.npmrc` map a whole scope to one
registry), `registry: ["github", "npm"]` publishes to both, in that order. `"github"` stays the default and runs
`bun publish` as before.

With npm in the list, `publish`:

1. Refuses outside GitHub Actions, naming `gh workflow run release-npm.yml --ref main`; refuses a job without
   `id-token: write` (no `ACTIONS_ID_TOKEN_REQUEST_URL`), an npm older than 11.5.1, and a `publishConfig.registry`
   other than `https://registry.npmjs.org/` (beside GitHub Packages, any `publishConfig.registry`).
2. Packs one archive with `bun pm pack` (prepack builds it; `workspace:` and `catalog:` ranges are resolved) and runs
   [packed-consumer](#commands) on those bytes.
3. Uploads that archive to each registry: GitHub Packages with `bun publish <archive>`, npmjs.org with
   `npm publish <archive> --access <publish.access>` from outside the repository, so an `.npmrc` scope mapping
   cannot send it elsewhere. `--provenance` is added only when the repository is public and `publish.access` is
   `public`: npm refuses provenance from a private repository.
4. Waits (up to five minutes) until every registry serves the version, then tags only if each serves the archive's
   `sha512` integrity and, when provenance was requested, npmjs.org lists a provenance attestation
   (`dist.attestations`). A mismatch prints the registry, the served and the expected integrity, and leaves the
   version untagged.

`--resume` publishes to the registries still missing the version. When one already serves it, `publish` downloads
that registry's tarball, checks it against its `dist.integrity` and uploads the same bytes to the others.

`release.yml` keeps its permissions: adding `id-token: write` there would fail every caller that does not grant it.
The npm publication runs in the caller's own job instead, from
[`docs/templates/release-npm.yml`](templates/release-npm.yml): a `check` job (`verify.yml`) and a `publish` job that
grants `contents: write` and `id-token: write`, checks out, sets up Bun and runs `actions/npm-publish`. npm matches a
trusted publisher per package and by the caller's workflow file, so configure it on each package's own access page
(`https://www.npmjs.com/package/<package>/access` — never on a shared kit package) or via
`npm trust github <package> --file release-npm.yml --repo <owner>/<repo>`, enable "Allow npm publish", and validate
with one real publish within 48 hours. If `npm publish` fails with `ENEEDAUTH`, `publish` prints the package's own
access URL.

Reading npmjs.org needs no token for a public package; for a restricted one, set `NPM_TOKEN` to a read token so
`publish` can see the version. Publishing a package to npmjs.org for the first time, like any change of registry,
is the owner's decision.

## Prerelease publishing

```sh
package-kit publish --prerelease integration --dist-tag integration
package-kit publish --prerelease integration --dist-tag integration --ref <ref> --dry-run
```

Publishes a prerelease (`X.Y.Z-<preid>.N`) of a single committed tree under an explicit non-`latest` dist-tag so
downstream consumers (such as Data Grid's integration branch) can install unreleased APIs by exact version without
duplicating publish or token plumbing:

- **Options:** `--prerelease <preid>` and `--dist-tag <tag>` are required together, cannot be combined with `--resume`,
  and must be lowercase identifiers (`[a-z][a-z0-9-]*`, no trailing hyphen). `--dist-tag latest` is always refused.
  `--ref <ref>` selects the commit to archive (default: `HEAD`; without `--ref`, uncommitted working-tree changes are
  refused). `--dry-run` builds, packs, checks the tarball and provenance, and passes `--dry-run` to the registry
  publish command.
- **Version:** picks the next minor after the newest stable release (local `package.json` or registry packument), or
  the next major when `## Unreleased` in `CHANGELOG.md` has a breaking entry from `1.0.0` onward, then increments `N`
  past any existing `X.Y.Z-<preid>.N` on the registry (starting at `1`).
- **Immutable archive:** captures the full 40-hex commit SHA, extracts it with `git archive` into a temporary checkout
  with sanitized `GIT_*` environment variables and `GIT_CEILING_DIRECTORIES` set so working-tree dirt and outer repos
  cannot leak in, rewrites only the temp `package.json` with `version` and `gitHead`, runs `prepack` (if declared) then
  `bun pm pack --ignore-scripts` (avoiding `prepare`), checks the packed tarball with `inspectTarball` and
  `tarballIssues`, and verifies `name`, `version`, and `gitHead` before uploading with `--tag=<tag>`.
- **Safety & output:** skips the release gate, creates no Git tags, sends no `publish.notify` dispatches, and leaves
  the caller's working tree untouched. Non-dry-run uploads refuse if the target registry has no established stable
  `latest` version (a first upload may assign `latest` even with `--tag`), and poll after upload to verify the served
  `gitHead`, `dist.integrity` (and npm provenance attestation when requested), `dist-tags[tag]`, and unchanged
  `dist-tags.latest`. On success (including `--dry-run`), prints the bare prerelease version on the last line of stdout
  so wrapper scripts can capture it cleanly.

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
    uses: maxvyshniakov/package-kit/.github/workflows/verify.yml@v1.1.0
  browser:
    uses: maxvyshniakov/package-kit/.github/workflows/browser.yml@v1.1.0
    with:
      checks: '[{"name": "stories", "run": "bun run check:stories -- --no-build"}]'
  # !cancelled() lets the deploy start when a check failed; package-kit ci-gate then
  # deploys under release.gate "local" and does nothing under "ci".
  deploy:
    needs: [check, browser]
    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}
    uses: maxvyshniakov/package-kit/.github/workflows/deploy-storybook.yml@v1.1.0
    with:
      url: https://catalog.example.com
      needs: ${{ toJSON(needs) }}
    secrets: inherit   # the job reads STORYBOOK_CLOUDFLARE_API_TOKEN from the storybook environment
```

| Workflow | Inputs |
|---|---|
| `verify.yml` | `args` (none; `--release` is added for `main` and pull requests into `main`), `slots` (`all`), `slot-wait` (0: wait as long as the job runs), `runner`, `timeout-minutes` (20), `fetch-depth` (1; 0 for a [changelog-entries](#changelog-entries) range step), `verified-url`, `junit`, `junit-artifact` |
| `browser.yml` | `checks` (JSON list of `{name, run}`), `build`, `playwright` (true), `slots` (`all`: the build and every check lease them together), `slot-wait` (0), `runner`, `timeout-minutes` (45: the wait, the build and every check), `verified-url`, `junit`, `junit-artifact` |
| `deploy-storybook.yml` | `url`, `needs` (the caller's `toJSON(needs)`, for `package-kit ci-gate`; default `{}`), `environment` (`storybook`), `runner`, `slots` (`all`, for the builds and `storybook:prepare-deploy`), `slot-wait` (0), `timeout-minutes` (30); `STORYBOOK_CLOUDFLARE_API_TOKEN` from that environment, with `secrets: inherit` |
| `release.yml` | `command` (`bun run release:publish`), `enabled` (true), `slots` (`all`), `slot-wait` (0), `runner`, `timeout-minutes` (30); the caller grants `contents: write`, `packages: write` |
| `actions/npm-publish` (an action, in the caller's own job) | `command` (`bun run release:publish`), `kit` (`node_modules/.bin/package-kit`, which leases the publication; package-kit's own workflow passes `src/cli.mjs`), `node-version` (24), `npm-version` (11.19.1; 11.5.1 or newer), `slots` (`all`), `slot-wait` (0), `token`; the job grants `contents: write`, `id-token: write`. See [publishing to npmjs.org](#publishing-to-npmjsorg) |
| `verified-tree.yml` | `plans` (required), `branches` (`["main", "dev"]`), `depth` (100), `force` (false), `platform` (the lookup runner's), `runner`; outputs `urls`, `tree`, `platform`; the caller grants `contents: read`, `checks: read`, `statuses: read`, `actions: read` to this job |

`runner` is `runs-on` as JSON and defaults to `'["ubuntu-latest"]'`. A private repository may name a self-hosted
runner, for example `'["self-hosted", "homelab"]'`. When the caller's repository is public and `runner` contains
`self-hosted`, the job runs on `ubuntu-latest` instead and its first step fails: a pull request from a fork chooses
the code a public repository's runner executes. Name self-hosted runners with the `self-hosted` label so the guard
sees them. A `schedule` event carries no repository visibility, so the guard does not act on nightly runs; they run
the default branch's own workflow, not a fork's.

Every heavy step of these workflows runs under a slotfather lease where the runner has slotfather: `verify`, the
browser build and checks, the Storybook builds and `storybook:prepare-deploy`, and the release command. What runs
outside one is light: checkout, `bun install`, the cached Playwright browser and the Cloudflare upload.
`slots` defaults to `all`, the whole runner, so no heavy job runs beside another and each gets the runner's memory; a job waits
for the lease instead. `verify.yml` passes `slots` to verify as `PACKAGE_KIT_VERIFY_SLOTS`, which overrides
`verify.slots` and `verify.browserSlots`.

`browser.yml` builds once and runs its checks one after another in one job, `package-kit checks`: every check runs,
after a failed one too, and the job fails naming the failed ones. Under a lease of the whole runner a job per check
could not run side by side with another anyway, and each built Storybook again: three concurrent builds exhausted a
10 GiB runner. Set
`timeout-minutes` to cover the lease wait plus the build and every check.

### Skipping a verified tree

A check result belongs to a tree and a plan, not to a branch or a commit. The tree (`git rev-parse <sha>^{tree}`)
holds the workflow files, `package-kit.config.mjs` and the lockfile, so two commits with one tree run the same checks
the same way: promoting dev to main, merging a pull request that was up to date, or a nightly run on an unchanged
main. `verified-tree.yml` looks for such a result before the heavy jobs start:

1. It reads the tree of the workflow's commit and compares it with the newest `depth` commits of each of
   `branches`, the commit itself and a pull request's head.
2. On each commit with that tree it reads the check runs (the jobs of earlier workflow runs, named
   `<caller job> / <job>`) and the commit statuses (the newest per context, such as the local release gate's
   `Library checks (local, darwin-arm64)`).
3. `plans` maps each plan name to the check names or status contexts that count as passing it; a trailing `*`
   accepts a prefix. A plan reuses the first success it accepts. A plan whose checks changed never matches,
   because a renamed or added check changes the job name (`browser.yml`'s job is named by its checks joined with
   ` + `, so `[{"name": "stories"}]` runs as `browser / stories`).
   A check run counts only when GitHub Actions ran it from the caller's own workflow file in the same release
   mode: `verify.yml` adds `--release` on `main` and on pull requests into `main`, so a pull request into `dev`
   never verifies a main push.
   The platform is part of the plan: a tree counts as verified only for the OS and architecture it was checked on
   (`platform`, `<os>-<arch>` in Node's names, by default the lookup runner's). A commit status counts only when its
   context ends with that platform, in the local gate's parentheses (`Library checks (local, linux-x64)`) or after
   a slash (`verified-tree/linux-x64`, for a status another tool posts). The deprecated gate context
   `Library checks (local, macOS)` (`Linux`, `Windows`) names the OS only and counts for it on any architecture
   (`darwin-*`), but only on a commit without a gate status naming its platform: a 0.6.1 gate writes both, and then
   only the platform one counts. Any other context naming no platform counts for none. A check run counts unless its job's runner labels name another OS or
   architecture: GitHub's hosted images by name (`ubuntu-*` and `windows-*` are x64 unless `-arm`, `macos-*` arm64
   but for `macos-13`, `-intel` and `-large`) and a self-hosted runner's `Linux`, `macOS`, `Windows`, `X64`, `ARM64`.
   Pass `platform` when the heavy jobs run on another runner than the lookup. A green local gate
   on the Mac therefore never skips the Linux run, and a second run of the tree on the same platform is skipped.
4. The `urls` output maps each plan to that result's link, or `""`. `verify.yml` and `browser.yml` take it as
   `verified-url`: when it is set the job runs no step but one, which links the reused result in the job summary,
   and the job passes. Give those jobs `if: ${{ !cancelled() }}` and
   `verified-url: ${{ needs.tree.result == 'success' && fromJSON(needs.tree.outputs.urls).verify || '' }}`, so a
   failed lookup runs the checks instead of skipping them. `force: true` (the template passes it on a manual run)
   runs every plan.

The lookup checks nothing out and installs nothing: `actions/verified-tree` runs `src/verified-tree.mjs` with
Node against GitHub's API. When GitHub cannot answer, every plan runs. `package-kit verified-tree` is the same step
for a job of your own (`PACKAGE_KIT_PLANS`, `PACKAGE_KIT_BRANCHES`, `PACKAGE_KIT_DEPTH`, `PACKAGE_KIT_HEAD_SHA`,
`PACKAGE_KIT_PLATFORM`, `GITHUB_TOKEN`).

The runner is outside the tree too, which is why the platform is part of the plan: a local gate status on the Mac
stands only for a lookup whose `platform` is the Mac's.

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
`junit-<job>-<attempt>`) for 30 days, after a failed or timed-out job too. In `browser.yml`, `package-kit checks` also writes its per-check results and
times to `package-kit-junit/checks.xml` (`PACKAGE_KIT_CHECKS_JUNIT`) and that file is uploaded with them. A workflow
calling `browser.yml` twice with `junit` gives each call its own `junit-artifact`.

Jobs show as `<caller job> / <reusable job>`, for example `check / verify`, `browser / browser + stories` (named by
its checks) and `deploy / Publish private Storybook`.

A cancelled run counts as failed for `publish` under gate `ci`, so `cancel-in-progress` covers pull requests only.

`actions/setup-bun` installs Bun 1.4.4, then runs `bun install --frozen-lockfile` with `token`.
Jobs that do not use a reusable workflow call it directly:
`uses: maxvyshniakov/package-kit/actions/setup-bun@v1.1.0`.

Any repository can call these while package-kit is public. A private copy needs its Settings → Actions → General →
Access set to "Accessible from repositories owned by the user".

The default `runner`, `["self-hosted", "homelab"]`, is the maintainer's runner; pass your own. The verification,
browser and Storybook jobs declare `contents: read` and `packages: read`, and `release.yml` `contents: write` and
`packages: write`: a called job never receives more than its caller grants, and these never more than they declare.
None of the workflows uses `pull_request_target`. Do not route pull requests from forks to a self-hosted runner.

## Versioning

package-kit follows the same changelog rules as the libraries. Consumer-visible changes go under `## Unreleased`.
Changelog sections: Breaking, Added, Changed, Deprecated, Removed, Fixed and Security. Before 1.0.0, a breaking
change is a minor release.

- **Compatible first.** A new form comes in beside the old one, and the old one is marked Deprecated with the release
  that removes it. A change is Breaking only when a consumer must act on upgrade and no transition period could avoid
  it.
- **Removals are batched.** Deprecated forms go together in one minor release, not one at a time.
- **Release when a consumer needs it**, or on a cadence, not after every change. Fixes can still ship as patches;
  consumers pin exact versions and upgrade when they choose.
- **Enforced:** every `### Breaking` entry under `## Unreleased` carries an indented line saying why no transition
  period was possible, and `check-changelogs` fails without one:

  ```markdown
  ### Breaking

  - Removed the `size` prop.
    No transition period: <why the old form could not stay, deprecated, for a while>
  ```

A release:

1. Cut the version with `bun run release -- <patch|minor|major>`. This also moves every `maxvyshniakov/package-kit/...@v`
   reference in the workflows, README and this reference to the new tag. The reusable workflows reference the action at that
   tag, which `publish` creates on the release commit.
2. Push the release commit to `main`.
3. Run `gh workflow run release-npm.yml --repo maxvyshniakov/package-kit --ref main`. Its `check` job runs
   `verify --release`; its `publish` job publishes to npmjs.org with trusted publishing and provenance, then tags the
   release commit (`publish` refuses npmjs.org outside GitHub Actions). Both use `./actions/...` from the commit
   itself, so they run before the tag exists. npmjs.org trusts that workflow file once, the owner's step:
   `npm trust github @maxvyshniakov/package-kit --file release-npm.yml --repo maxvyshniakov/package-kit`.
4. Raise the pinned version in each repository and run `bun run package-kit hooks sync`. Update the workflow references;
   `package-kit check` fails until they match.

## Developing

`bun run verify` runs:

- the changelog check;
- `package-kit check` on this repository;
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
`dev`, using the landing lock held by `lanefather promote` (or the project's configured entry point). package-kit
distributes the exact copy, pinned by `REFERENCE_TRANSACTION_SHA256` in `src/hooks.mjs`, and installs it in
consumers' managed hooks. Package-Kit's own single-branch checkout omits it. `check:upstream` compares it with
`LANEFATHER_DIR/hooks/reference-transaction`; the checkout defaults to `~/lanefather` and the check is skipped
without one. `LANEFATHER_DIR` selects a
source checkout for this comparison, not the runtime engine.

When Lanefather's canonical hook changes:

1. copy it here;
2. update the hash;
3. release.
