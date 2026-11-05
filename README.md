# repo-kit

Shared tooling for the private `maxvyshniakov` library repositories (Sid-Kit,
Data Grid, Inline Measure, Text Truncate):

- the verify gate;
- the pre-push hook;
- release, publish and changelog checks;
- the release gate, local or in CI;
- the slotfather wrapper;
- the Bun TLS gate;
- the packed-consumer check;
- story screenshots in Chromium, Firefox, WebKit and Safari;
- reusable GitHub Actions workflows.

It replaces the copies of `scripts/verify.mjs`, `pre-push.mjs`, `publish.mjs`, `release.mjs`,
`check-changelogs.mjs`, `heavy.sh`, `install-git-hooks.mjs` and `.githooks/*` those repositories carried.

The package is private: `@maxvyshniakov/repo-kit` in GitHub Packages.

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

The memory a run may use is the leased slots times slotfather's `gib_per_slot` (the homelab runner: 5 GiB a slot), capped
by the job's cgroup limit and Linux's MemAvailable; without a lease, MemAvailable on Linux and all memory elsewhere.
On this Mac slotfather budgets cores only, so cores decide. `REPO_KIT_VERIFY_MEMORY_GIB` and `REPO_KIT_VERIFY_CORES`
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

### Step memory

verify plans its steps by the memory each declares, so declare it: a step left at 0 never waits for room, and on the
homelab runner (two 5 GiB slots, a 10 GiB cap) steps that all read 0 start together and run it out of memory.

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
| `hooks sync` | Writes the managed hooks into `.githooks`: a `pre-push` shim and `reference-transaction`. Other hooks there are the repository's own. |
| `hooks check` / `hooks status` | The tracked managed hooks match the kit / Git would run every tracked hook. |
| `check` | `hooks check`. Every `maxvyshniakov/repo-kit/...@` reference in `.github/workflows` names the installed version. `packageManager` names `bun@1.4.4`. |
| `check-changelogs [--release]` | Changelog format, version agreement (`package.json`, the newest release, `bun.lock`, quick start archives) and peer ranges. `--release`: no unreleased entries. |
| `release [<package>:]<patch\|minor\|major\|x.y.z> [--date=]` | Cuts `## Unreleased` into a version; sets `package.json`, `bun.lock` and the quick start. |
| `release-gate [<ref>] [--rerun] [--no-attest]` | The local [release gate](#release-gate) on a commit (default `HEAD`): a clean worktree, frozen install, `verify --release`, `verify --browser` with Chromium in software compositing, the TLS gate; records the commit status `Library checks (local, <platform>)`. `--mode` prints `release.gate`. |
| `ci-gate` | In a workflow job that needs the checks (`deploy-storybook.yml`): writes `run=true` under gate `local`, or under gate `ci` when every job in `REPO_KIT_NEEDS` (the caller's `toJSON(needs)`) passed. |
| `publish [--resume]` | TLS gate; HEAD must be `origin/main` by SHA (any branch, worktree or detached HEAD); the [release gate](#release-gate) on that commit: a passed `release-gate` status (gate `local`) or the checks workflow (gate `ci`), not inside Actions; publishes, checks the registry serves the version, tags `v<version>` (GH007 recovery printed when the tag push is declined), then requests `publish.notify`. `--resume` finishes a partial publication. |
| `notify` | Requests `publish.notify`'s workflows again. |
| `heavy <slots\|all> <command...>` | Runs a command under `slotfather run -n <slots>` when slotfather is on PATH and no lease is held; otherwise directly. |
| `tls` | The TLS gate (below). |
| `packed-consumer [--keep]` | Packs, installs into a temporary consumer, imports every entrypoint in plain Node, type-checks under `nodenext` without `skipLibCheck`, then runs the probes. Optional peers are not installed. |
| `shoot <story id filter...> [<url>\|--url=] [--theme=] [--width=] [--browser=] [--out=] [--viewport]` | [Story screenshots](#story-screenshots) from a running Storybook, under a lease of `shoot.slots`. |

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
(up to 15 s, then a warning), each `decode()`d. Safari paints lazy, async-decoded images late, and a wait over an
empty list of images passes before the content mounts, so the settle comes first. A dev server keeps a failed story
index until the broken file changes again: shoot touches the file the error names (under `shoot.storybookDir`, default
`apps/storybook`) and retries, and reloads a story that shows the Vite error overlay.

| `--browser=` | Engine |
|---|---|
| `chromium` | Playwright's Chromium, the `chromium` channel (not the headless shell). |
| `firefox` | The installed `/Applications/Firefox.app` over WebDriver BiDi (Playwright's `moz-firefox` channel). Playwright's own patched Firefox does not start on macOS 27 ("Could not find profile folder"), and it is not the Firefox users run. |
| `webkit` | Playwright's WebKit. It renders like Safari but has none of Safari's scrolling or settings: static layout only. |
| `safari` | Safari Technology Preview over its own `safaridriver`. Viewport pictures only (WebDriver), `fullPage` is ignored. |

Playwright stays the repository's own pinned devDependency: repo-kit declares it as an optional peer and loads it from
the repository root, and `safari` needs none. `firefox` needs Firefox installed.

Safari itself refuses WebDriver while the owner has it open, so `safari` drives Safari Technology Preview, which runs
beside it. One-time setup by the owner: `brew install --cask safari-technology-preview` (the installer asks for an
administrator password), then in its own Settings, Advanced → "Show features for web developers" and Developer →
"Allow remote automation". safaridriver brings the window to the front; shoot hands focus straight back to the app
that had it, and the window keeps drawing behind the owner's apps. When the run ends, shoot quits the automation window
it started (SIGTERM: in automation mode it ignores a quit request and window close). Do not hide or minimise it: WebKit then marks the
page hidden, stops drawing frames and cannot screenshot. A run that ended without closing its session (killed, or its
safaridriver gone) leaves Safari Technology Preview "already paired with another WebDriver session"; when no other
safaridriver of it runs, shoot quits that automation window (`--automation`, never the owner's own) and starts again,
and when one runs, it fails naming that driver. Engine details: the mastack `browser-verify` skill.

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
  release: { gate: "local" }, // the default: a local run of repo-kit release-gate on this Mac
  // release: { gate: "ci" }, // the checks workflow on the homelab runner, as before release.gate existed
};
```

Gate `local` is the default, chosen on 2026-11-03: over 33 days and five repositories the homelab runner's 52 failed
attempts were 24 infrastructure, 19 flaky and 7 CI-only plumbing failures and 2 real library defects, and CI delayed
about 9 releases. Both defects were Sid-Kit ScrollArea defects (edge fades, a rounded clip) that broke only under
Chromium's software compositing on Linux, which a GPU-rendered Mac run did not catch. The local gate runs its browser checks in software compositing for
that reason. Switch to `ci` when a second contributor joins, or whenever releases must not depend on one machine.

### Gate `local`

```sh
git fetch origin && bunx repo-kit release-gate origin/main   # after the release commit is pushed
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
   `gpu_compositing: disabled_software`; on this Mac the same Chromium reports `enabled` (Metal) without the switch.
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

Replayed on Sid-Kit `8f6695c^` (before the rounded scroll clip fix), `check-scroll-fade-edges` passes on this Mac's GPU
path and fails through the mirror with the CI failure's assertion; at `8f6695c` it passes through the mirror.

### Gate `ci`

`release: { gate: "ci" }` restores the behaviour from before `release.gate` existed: `publish` waits for `publish.checks`
(`check.yml`) on the commit and refuses when it failed, was cancelled or never started; `publish.checks: false` skips
the wait with a warning. `release-gate` still runs, and its status is for information only.

### The workflows under each gate

The workflows stay in both modes and run on the homelab runner as before. Under gate `local` they are advisory:
nothing waits for them.

| Job | Gate `local` | Gate `ci` |
|---|---|---|
| `check.yml`: `verify.yml`, `browser.yml` | advisory | `publish` waits for the run |
| `deploy-storybook.yml` | runs whatever the checks concluded (`repo-kit ci-gate`) | runs only after every needed job passed |
| Data Grid's `dependency-release` (`release.yml`) | stays behind its own check jobs in CI | the same |

The deploy and Data Grid's catalog automation stay in CI because they need the `storybook` environment's Cloudflare
token and the workflow's registry token there. They do not gate anything. For the deploy to run after a failed check,
its caller job needs `if: ${{ !cancelled() && … }}` and `needs: ${{ toJSON(needs) }}` (see [Workflows](#workflows));
a caller left as before still deploys only after its checks passed. A deploy could also run from the Mac
(`bun run storybook:prepare-deploy && bun run storybook:deploy` with `CLOUDFLARE_API_TOKEN` set), which would take
the runner out of the release path entirely; it is not wired up.

No branch protection or ruleset requires any check: GitHub offers neither for private repositories on this account's
plan (the API answers 403, "Upgrade to GitHub Pro"), so the commit statuses are the only record and `publish` the only
enforcement. If protection is enabled later, require `Library checks (local, macOS)` under gate `local`, or the
`check.yml` jobs under gate `ci`, not both.

## GITHUB_TOKEN

`bunfig.toml` reads `@maxvyshniakov` packages with `token = "$GITHUB_TOKEN"`. Every `bun install` in these
repositories needs it, now including repo-kit itself:

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
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.3.1
  browser:
    uses: maxvyshniakov/repo-kit/.github/workflows/browser.yml@v0.3.1
    with:
      checks: '[{"name": "stories", "run": "bun run check:stories -- --no-build"}]'
  # !cancelled() lets the deploy start when a check failed; repo-kit ci-gate then
  # deploys under release.gate "local" and does nothing under "ci".
  deploy:
    needs: [check, browser]
    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}
    uses: maxvyshniakov/repo-kit/.github/workflows/deploy-storybook.yml@v0.3.1
    with:
      url: https://sid-kit.maxvyshniakov.com
      needs: ${{ toJSON(needs) }}
    secrets: inherit   # the job reads STORYBOOK_CLOUDFLARE_API_TOKEN from the storybook environment
```

| Workflow | Inputs |
|---|---|
| `verify.yml` | `args` (none; `--release` is added for `main` and pull requests into `main`), `slots` (`all`), `slot-wait` (0: wait as long as the job runs), `runner`, `timeout-minutes` (20) |
| `browser.yml` | `checks` (JSON list of `{name, run}`), `build`, `playwright` (true), `slots` (`all`: the build and every check lease them together), `slot-wait` (0), `runner`, `timeout-minutes` (45: the wait, the build and every check) |
| `deploy-storybook.yml` | `url`, `needs` (the caller's `toJSON(needs)`, for `repo-kit ci-gate`; default `{}`), `environment` (`storybook`), `slots` (`all`, for the builds and `storybook:prepare-deploy`), `slot-wait` (0), `timeout-minutes` (30); `STORYBOOK_CLOUDFLARE_API_TOKEN` from that environment, with `secrets: inherit` |
| `release.yml` | `command` (`bun run release:publish`), `enabled` (true), `slots` (`all`), `slot-wait` (0), `runner`, `timeout-minutes` (30); the caller grants `contents: write`, `packages: write` |

Every heavy step of these workflows runs under a slotfather lease where the runner has slotfather: `verify`, the
browser build and checks, the Storybook builds and `storybook:prepare-deploy`, and the release command. What runs
outside one is light: checkout, the TLS gate, `bun install`, the cached Playwright browser and the Cloudflare upload. `slots` defaults to `all`, the whole runner (the
homelab runner has two 5 GiB slots), so no heavy job runs beside another and each gets the runner's memory; a job waits
for the lease instead. `verify.yml` passes `slots` to verify as `REPO_KIT_VERIFY_SLOTS`, which overrides
`verify.slots` and `verify.browserSlots`.

`browser.yml` builds once and runs its checks one after another in one job, `repo-kit checks`: every check runs,
after a failed one too, and the job fails naming the failed ones. Under a lease of the whole runner a job per check
could not run side by side with another anyway, and each built Storybook again (straylight#656). Set
`timeout-minutes` to cover the lease wait plus the build and every check.

Jobs show as `<caller job> / <reusable job>`, for example `check / verify`, `browser / browser + stories` (named by
its checks) and `deploy / Publish private Storybook`.

A cancelled run counts as failed for `publish` under gate `ci`, so `cancel-in-progress` covers pull requests only.

`actions/setup-bun` installs Bun 1.4.4, runs the TLS gate, then `bun install --frozen-lockfile` with `token`.
Jobs that do not use a reusable workflow call it directly:
`uses: maxvyshniakov/repo-kit/actions/setup-bun@v0.3.1`.

Calling these from another repository needs repo-kit's Settings → Actions → General → Access set to
"Accessible from repositories owned by the user".

## Versioning

repo-kit follows the same changelog rules as the libraries. Consumer-visible changes go under `## Unreleased`.
Changelog sections: Breaking, Added, Changed, Deprecated, Removed, Fixed and Security. Before 1.0.0, a breaking
change is a minor release.

A release:

1. Cut the version with `bun run release -- <patch|minor|major>`. This also moves every `maxvyshniakov/repo-kit/...@v`
   reference in the workflows and this README to the new tag. The reusable workflows reference the action at that
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
- a comparison of `hooks/reference-transaction` with Straylight's (skipped without a checkout);
- the tests;
- the packed-consumer check.

The pre-push hook runs the same. This repository uses `main` for everyday work;
version tags identify releases. Its `prePush.releaseBranches: []` keeps ordinary
main pushes compatible with `Unreleased` entries. `release-gate` still runs
`verify --release` before package publication. Consumers default to release
validation on `main`; they can configure `prePush.releaseBranches` themselves.

Agent commands and repository policy: [checks](docs/agents/checks.md),
[publishing](docs/agents/publishing.md), [orchestration](docs/agents/orchestration.md).

`hooks/reference-transaction` is Straylight's `tools/agent-hooks/reference-transaction` (one writer for `main` and
`dev`, landing lock from `tools/lane promote`). Its canonical home moves to lanefather. Until then, repo-kit carries
the copy, pinned by `REFERENCE_TRANSACTION_SHA256` in `src/hooks.mjs`, and only installs it.

When Straylight's copy changes:

1. copy it here;
2. update the hash;
3. release.
