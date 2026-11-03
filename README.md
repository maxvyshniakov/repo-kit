# repo-kit

Shared tooling for the private `maxvyshniakov` library repositories (Sid-Kit,
Data Grid, Inline Measure, Text Truncate):

- the verify gate;
- the pre-push hook;
- release, publish and changelog checks;
- the slotfather wrapper;
- the Bun TLS gate;
- the packed-consumer check;
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
    "security:tls": "repo-kit tls"
  }
}
```

`repo-kit verify` and `repo-kit pre-push` take their own slotfather lease (`verify.slots`, `verify.browserSlots`,
`prePush.slots`). Other heavy scripts wrap themselves: `"check:stories": "repo-kit heavy 2 bun scripts/run-story-checks.mjs"`.
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
  release: { afterCut({ root, released }) {} }, // runs after the version is cut, before bun install
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
| `publish [--resume]` | TLS gate; HEAD must be `origin/main` by SHA (any branch, worktree or detached HEAD); waits for the checks workflow on that commit (not inside Actions); publishes, checks the registry serves the version, tags `v<version>` (GH007 recovery printed when the tag push is declined), then requests `publish.notify`. `--resume` finishes a partial publication. |
| `notify` | Requests `publish.notify`'s workflows again. |
| `heavy <slots\|all> <command...>` | Runs a command under `slotfather run -n <slots>` when slotfather is on PATH and no lease is held; otherwise directly. |
| `tls` | The TLS gate (below). |
| `packed-consumer [--keep]` | Packs, installs into a temporary consumer, imports every entrypoint in plain Node, type-checks under `nodenext` without `skipLibCheck`, then runs the probes. |

## GITHUB_TOKEN

`bunfig.toml` reads `@maxvyshniakov` packages with `token = "$GITHUB_TOKEN"`. Every `bun install` in these
repositories needs it, now including repo-kit itself:

- **Locally:** `export GITHUB_TOKEN=$(gh auth token)`. The token needs `read:packages` to install and `write:packages`
  to publish (`gh auth refresh -s write:packages`).
- **pre-push hook:** installs in a temporary worktree. When `GITHUB_TOKEN` is unset, it uses `gh auth token`. Without
  either it warns, and a failed install names the fix.
- **publish:** also falls back to `gh auth token`.
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

The caller keeps `.github/workflows/check.yml` (publish waits for it), with its triggers, concurrency and
permissions, and calls the reusable workflows at the installed kit's tag:

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
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.2.3
  browser:
    uses: maxvyshniakov/repo-kit/.github/workflows/browser.yml@v0.2.3
    with:
      checks: '[{"name": "stories", "run": "bun run check:stories -- --no-build"}]'
  deploy:
    needs: [check, browser]
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    uses: maxvyshniakov/repo-kit/.github/workflows/deploy-storybook.yml@v0.2.3
    with:
      url: https://sid-kit.maxvyshniakov.com
    secrets: inherit   # the job reads STORYBOOK_CLOUDFLARE_API_TOKEN from the storybook environment
```

| Workflow | Inputs |
|---|---|
| `verify.yml` | `args` (none; `--release` is added for `main` and pull requests into `main`), `slots` (`all`), `slot-wait` (0: wait as long as the job runs), `runner`, `timeout-minutes` (20) |
| `browser.yml` | `checks` (JSON list of `{name, run}`), `build`, `playwright` (true), `slots` (`all`: the build and every check lease them together), `slot-wait` (0), `runner`, `timeout-minutes` (45: the wait, the build and every check) |
| `deploy-storybook.yml` | `url`, `environment` (`storybook`), `slots` (`all`, for the builds and `storybook:prepare-deploy`), `slot-wait` (0), `timeout-minutes` (30); `STORYBOOK_CLOUDFLARE_API_TOKEN` from that environment, with `secrets: inherit` |
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

A cancelled run counts as failed for `publish`, so `cancel-in-progress` covers pull requests only.

`actions/setup-bun` installs Bun 1.4.4, runs the TLS gate, then `bun install --frozen-lockfile` with `token`.
Jobs that do not use a reusable workflow call it directly:
`uses: maxvyshniakov/repo-kit/actions/setup-bun@v0.2.3`.

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
2. Push the release commit to `dev` and `main`.
3. Run `bun run release:publish` once Library checks pass on `main`. repo-kit's own checks use `./actions/setup-bun`
   from the commit itself, so they run before the tag exists.
4. Raise the pinned version in each repository and run `bun run repo-kit hooks sync`. Update the workflow references;
   `repo-kit check` fails until they match.

## Developing

`bun run verify` runs:

- the changelog check;
- `repo-kit check` on this repository;
- a comparison of `hooks/reference-transaction` with Straylight's (skipped without a checkout);
- the tests;
- the packed-consumer check.

The pre-push hook runs the same.

`hooks/reference-transaction` is Straylight's `tools/agent-hooks/reference-transaction` (one writer for `main` and
`dev`, landing lock from `tools/lane promote`). Its canonical home moves to lanefather. Until then, repo-kit carries
the copy, pinned by `REFERENCE_TRANSACTION_SHA256` in `src/hooks.mjs`, and only installs it.

When Straylight's copy changes:

1. copy it here;
2. update the hash;
3. release.
