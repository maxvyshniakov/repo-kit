# @maxvyshniakov/repo-kit Changelog

Versions and release rules: [README.md](README.md#versioning).

## Unreleased

### Added

- The changelog check fails an Unreleased `### Breaking` entry that lacks an indented line `No transition period: <why>`, saying why a transition period could not avoid the break. Only Unreleased is checked; released sections stay as they are.

### Changed

- A tree counts as verified only for the platform it was checked on (owner decision 2026-11-13). `verified-tree.yml`, `actions/verified-tree` and `repo-kit verified-tree` take `platform` (`REPO_KIT_PLATFORM`; `<os>-<arch>` in Node's names, by default the lookup runner's) and count a commit status only when its context ends with that platform (the local gate's `Library checks (local, linux-x64)`, or `.../linux-x64` for a status another tool posts), and a check run only when its job's runner labels name no other OS or architecture; a new `platform` output says which platform counted. A green local gate on the Mac no longer skips a Linux run; a second run of the tree on the same platform still does. The deprecated `Library checks (local, macOS)` counts for macOS on any architecture (`darwin-*`), `(local, Linux)` and `(local, Windows)` likewise. Nothing to change on upgrade.
- The local release gate also records its commit status as `Library checks (local, <os>-<arch>)`, such as `Library checks (local, darwin-arm64)`, beside the old `Library checks (local, macOS)`. `publish` accepts either. A branch protection rule can require the new context now.
- `repo-kit shoot --browser=firefox` on a Playwright older than 1.57.0 (the first that launches the `moz-firefox` channel) fails at once, naming the version it needs and the one installed. The optional Playwright peer stays `>=1.50.0`; the other browsers need nothing new.
- `repo-kit shoot`: a story the Vite overlay never leaves, or one on Storybook's error display, gets no picture and the run fails naming it after the others; such a story used to be pictured with exit 0.

- The TLS gate (repo-kit#17) is offline and deterministic, about 2 ms instead of 6 s or more: Bun 1.4.4 or later, none of the eMudhra incident roots (by SHA-256 fingerprint) in `tls.rootCertificates`, and no environment variable that adds certificate authorities (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_USE_SYSTEM_CA`, `--use-system-ca`/`--use-openssl-ca` in `NODE_OPTIONS` or `BUN_OPTIONS`, `npm_config_cafile`/`npm_config_ca`). `REPO_KIT_TLS_ALLOW_CA_ENV=1` allows such variables when the bundles they name hold no incident root. The live probe of the incident hosts runs its 26 requests side by side and fails only when an incident host answers; timeouts and DNS errors warn instead of failing. `publish` still requires `registry.npmjs.org` to answer. The live probe stops asking the incident hosts on 2027-02-01. `repo-kit tls --offline` runs the gate alone.

### Deprecated

- The local release gate's status context `Library checks (local, macOS)` (and `(local, Linux)`, `(local, Windows)`): the gate writes it beside `Library checks (local, <os>-<arch>)` until the next batched minor release removes it. Move branch protection rules to the new context.

### Fixed

- `repo-kit shoot` (the overall review in repo-kit#3): the image decode no longer waits forever on an image that never loaded; the Vite overlay counts as a shown story, so its reloads run; SIGTERM and SIGHUP close the browser first, also one still launching, give up on a hung close after 10 s and exit at once on a second signal; Safari treats a safaridriver a killed run started (recorded by pid and start time) as dead and any other as live, stops its driver on every failed launch, quits only the automation window its own session started, fails a viewport narrower than Safari allows and warns about a shorter one.
- `packed-consumer` installs the optional peers the repository pins again, leaving out only those it declares no version of.

## 0.6.0 - 2026-11-12

### Breaking

- `verify.yml`, `browser.yml`, `deploy-storybook.yml` and `release.yml` default `runner` to `'["ubuntu-latest"]'` instead of the maintainer's self-hosted labels. A private repository that wants its self-hosted runner passes `runner: '["self-hosted", "homelab"]'` (or its own labels) when it moves its workflow pins to this release. In a public repository a `runner` containing `self-hosted` runs the job on `ubuntu-latest` and fails its first step. The guard sees the `self-hosted` label only, and not on `schedule` runs, whose event carries no repository visibility; it does not replace keeping self-hosted runners off public repositories (SECURITY.md).

### Added

- `verified-tree.yml` and `actions/verified-tree` (also `repo-kit verified-tree`): before the heavy jobs, look up a passed check run or commit status, accepted by a plan, on any commit with the same tree (the newest commits of main and dev, the commit itself, a pull request's head). Its `urls` output feeds the new `verified-url` input of `verify.yml` and `browser.yml`, which then skip every step and link the reused result. Opt-in: callers that do not add the job run as before.
- `verify.yml` and `browser.yml` take `junit` (and `junit-artifact`) to upload the JUnit reports their commands write; `repo-kit checks` writes per-check results and times as JUnit to `REPO_KIT_CHECKS_JUNIT`, which `browser.yml` uploads with them.
- `repo-kit test-hygiene [--init|--update]`: shrink-only rules over test files with a baseline (`test-hygiene-baseline.json`): fixed sleeps (`sleep-ok: <reason>` allows one), timing assertions outside the perf suite (ported from Straylight's perf budget check; a perf-helper caller outside the perf suite fails), and opt-in class-name and CSS-text assertions (`testHygiene.ui`). It runs only where a repository adds it, and without `repo-kit.config.mjs` too.
- `@maxvyshniakov/repo-kit/perf-budget`: `perfBudget(holds, message)` fails only under `REPO_KIT_PERF_BUDGETS=enforce` (the perf suite) and reports elsewhere.
- `chain()` takes a list of steps as one entry: a group that runs side by side after the entry before it. A step's `slots` option bounds side-by-side steps by the run's lease, and the step sees its share as `REPO_KIT_STEP_SLOTS`.
- `docs/templates/check.yml`: a caller running fast checks on main pushes, the full suite nightly and on release tags, skipping docs-only changes and verified trees.

### Changed

- `repo-kit-lane` leases the slots Lanefather passes with `--jobs` (capped by the configured `slots`/`browserSlots`) instead of always the configured ones: a Sid-Kit lane check given one job held three slots and used 1.6 cores. Where a slot has memory, it still leases enough slots for its largest step; a smaller lease is also a smaller memory budget.
- Slotfather lease labels name the project or lane and what runs (`sid-kit verify`, `lane-sk-api-surfaces check`, `sid-kit check:stories`) instead of the directory name, which in a worktree said nothing.

## 0.5.0 - 2026-11-11

### Added

- `changelog.versionSource: "pyproject.toml"` reads and releases a Python package's version from `pyproject.toml`'s `[project]` table; a repository without a root `package.json` uses it by default. `check-changelogs` compares it with the newest release and `release` sets it.
- The changelog-entry guard: with `changelog.paths` set, a commit changing those paths must add, change or remove a line under `## Unreleased` in its package's `CHANGELOG.md`, or carry the trailer `Changelog: none (<reason>)`, which covers the whole commit; merges and release cuts are exempt. `repo-kit check-changelog-entries <base>..<head>` checks a range, and `hooks sync` writes a managed `commit-msg` hook that checks each commit, skips `fixup!`/`squash!` commits, and warns instead of blocking when it cannot run the kit.
- `hooks.managed` limits the managed hooks `hooks sync` writes and `hooks check` expects, for a repository that wants only some of them.
- `verify.yml` takes `fetch-depth`, for a verify step that checks a range against its base branch.

### Changed

- `verify.yml` and `browser.yml` jobs declare `contents: read` and `packages: read`. Every current caller grants exactly these, so nothing changes for them; a caller granting more no longer passes it to the checks.
- Public-repository documentation: status and terms in the README, SECURITY.md and CONTRIBUTING.md, workflow runner guidance for outside callers, package metadata, and maintainer-specific hosts and links replaced with self-contained explanations.

## 0.4.0 - 2026-11-07

### Added

- `repo-kit-lane` exposes configured verification steps through Lanefather's plan/report contract, with real step logs, dependency outcomes, cancellation and committed-input checks.
- Consumers with `.lanefather.toml` receive a managed `lane-check` entry from `hooks sync`; it prepares the target checkout's frozen dependencies before running its locked adapter.
- Lane verification leases carry configured labels, named priority/ticket and metadata through the `REPO_KIT_SLOT_*` execution context.

- `prePush.releaseBranches` selects branches requiring release validation; the default remains `main` for consumers.

### Changed

- Replace the README's maintainer-specific introduction with use cases, a minimal setup and explicit tool boundaries; keep the detailed contract in the packaged reference.
- Repo-Kit's own pull-request checks use GitHub-hosted runners with checkout credentials disabled; reusable consumer runner defaults remain explicit configuration.

- The consumer protected-branch hook follows Lanefather's canonical source. `check:upstream` uses `LANEFATHER_DIR` (default `~/lanefather`) instead of Straylight's project copy; the pinned hash still guards installations without a source checkout.
- Document the Mastack/Lanefather/repo-kit/Slotfather workflow boundaries for consumers, including the lane adapter and pre-push evidence contracts. Repo-kit's own main-only publishing contract remains separate.

- Repo-kit's own workflow uses one `main` branch with ordinary push checks and an explicit release gate. Its own hooks omit the Straylight branch-movement guard; consumer hooks retain it.

### Fixed

- The lane adapter honors `--keep-going`: independent checks finish after a failure while dependants remain blocked; ordinary verification remains fail-fast.

- Refresh the canonical consumer branch guard so refusals name lane sync and its backup-preserving recovery command.

## 0.3.1 - 2026-11-04

### Added

- `repo-kit shoot` (`"shoot:stories": "repo-kit shoot"`) screenshots Storybook stories by story id filter, in each `--theme`, `--width` and `--browser=chromium,firefox,webkit,safari`, full page or `--viewport`, into `--out`, from a Storybook given as a bare URL or `--url=`. `firefox` is the installed Firefox (Playwright's `moz-firefox` channel; Playwright's own Firefox does not start on macOS 27), `safari` is Safari Technology Preview over its safaridriver, with focus handed back to the app that had it and its automation window quit after the run that started it. Before each picture it waits for `sb-show-main`, a settle, then the viewport's images loaded and decoded. A full page over 16384 px is cut to its top 16384 px with a warning (Firefox refuses one over 65535 px; Data Grid's showcase is 390104 px tall). A Safari Technology Preview left paired by a run that died is restarted when no other safaridriver holds it. It leases `shoot.slots` (default 1) as `repo-kit heavy` does, and loads the repository's own Playwright, now an optional peer. It replaces Sid-Kit's and Data Grid's `scripts/shoot-stories.mjs`, `scripts/lib/browsers.mjs` and `scripts/lib/safari.mjs`, which had drifted: Sid-Kit's had no Safari and no image waits.
- `@maxvyshniakov/repo-kit/shoot` exports the parser, the engine launcher and the screenshot loop.

### Changed

- `packed-consumer` does not install optional peers.

## 0.3.0 - 2026-11-03

### Breaking

- `release:publish` requires the release gate chosen by `release.gate` in `repo-kit.config.mjs`. The default, `"local"`, requires a passed `repo-kit release-gate` status (`Library checks (local, macOS)`) on the commit it publishes and refuses without one, naming the command to run; it no longer waits for the checks workflow. `release: { gate: "ci" }` restores the old behaviour exactly: publish waits for `publish.checks` on the commit. No consumer needs a config change to adopt the local gate; a repository that keeps CI as its gate adds that one line. Owner decision 2026-11-03: over 33 days the homelab runner's 52 failed attempts held 2 real library defects and delayed about 9 releases. Inside GitHub Actions (Data Grid's automated catalog release) the calling workflow's jobs still gate publication under either gate.

### Added

- `repo-kit release-gate [<ref>]`: the local release gate on a commit (default `HEAD`), under one slotfather lease. The TLS gate, then a clean temporary worktree of the exact commit, `bun install --frozen-lockfile`, `verify --release`, and `verify --browser` when the commit declares browser checks. A pass or a failure is recorded as the commit status `Library checks (local, <platform>)`, with the host, duration, kit version and the local log (`.git/repo-kit-gate/<sha>.log`). A commit that passed is not run again, so the run after pushing a commit GitHub did not have yet only records its status. `--rerun` runs it again, `--no-attest` records nothing, and `--mode` prints the configured gate.
- The release gate runs every check against Playwright's Chromium with software compositing (`--disable-gpu`), as on the Linux CI runner. It points `PLAYWRIGHT_BROWSERS_PATH` at a mirror whose Chromium executables add the switch, so Playwright launches, agent-browser behind a repository's wrapper and a check's own `chromium.launch` all get it without changes in the repository. Before the checks it asks that Chromium over DevTools and stops unless `gpu_compositing` is `disabled_software`; on this Mac it reports `enabled` (Metal) without the switch. It also fails when browser checks start no Chromium through the mirror. Replayed on Sid-Kit before its rounded scroll clip fix, `check-scroll-fade-edges` passes on the Mac's GPU path and fails through the mirror, as it failed on CI.
- `repo-kit ci-gate` and a `needs` input on `deploy-storybook.yml`: with the caller's `toJSON(needs)` and `!cancelled()` in its `if`, the Storybook deploy runs whatever the checks concluded under gate `local` and only after every needed job passed under gate `ci`. A caller left as before still deploys only after its checks passed.

### Changed

- README: a "Release gate" section on both gates, the one-line switch, how the workflows relate to each gate, and why no branch protection requires a check (the repositories' plan offers none).

## 0.2.3 - 2026-11-03

### Added

- A verify step that runs past its timeout fails: `verify.stepTimeout` minutes (default 15; 0: no limit), or the step's own `timeout`. Its whole process tree gets SIGTERM, SIGKILL 5 s later, and verify stops waiting for its output 2 s after that, with `[step] timed out after …s` and `FAIL step (…, timed out)` in the summary. A repo-kit check hung for 15 minutes after its last output until the job limit cancelled it, with nothing naming the step (run 41630008769). A step that was stopped and still runs at its timeout is killed the same way.

### Changed

- README: how a repository declares its steps' `memory` and `verify.workerMemory` from the summary's measured peaks.
- `browser.yml` builds once and runs every check after it in one job, under one lease, through the new `repo-kit checks`: every check runs, after a failed one too, and the job fails naming the failed ones. The job is named by its checks (`browser + stories`). A job per check built Storybook once per check, and with the whole runner leased the checks ran one after another anyway; Sid-Kit 0.41.1's checks failed when three Storybook builds ran at once (straylight#656). Its default `timeout-minutes` rises from 30 to 45 to cover every check; callers with several long checks set it to the lease wait plus all of them.
- `deploy-storybook.yml` runs `storybook:prepare-deploy`, which installs and builds the retained releases' Storybooks, under the lease too.

### Fixed

- A step's measured peak counts its whole process tree: its process group, every descendant by parent pid, processes it started that were since reparented, and daemons orphaned before a sample saw them (agent-browser's), which carry the step's `REPO_KIT_STEP` in their environment. Browsers that start sessions of their own (Chromium, agent-browser) used to fall outside the group, so Sid-Kit's browser checks read 0.4 GiB while the runner peaked at 8.85 GB (straylight#656). On Linux the summary also shows the job cgroup's peak: `memory.peak`, reset for the run where the kernel allows (6.12 and later), else the per-second samples of `memory.current`; it includes page cache.
- The pre-push hook works out which pushed commits have not passed before it takes its lease, and takes none when every one has. A push of commits that had passed used to wait for `prePush.slots` like a real verification: on this Mac pushes at 3 slots waited 1071–2426 s to run for 2–38 s (straylight#656).

## 0.2.2 - 2026-11-03

### Changed

- Every heavy step of the reusable workflows runs under a slotfather lease of the whole runner by default (`slots: all`): verify (through `REPO_KIT_VERIFY_SLOTS`, which overrides `verify.slots` and `verify.browserSlots`), the build and check of `browser.yml`, the Storybook builds of `deploy-storybook.yml` and the command of `release.yml`. On the homelab runner a 1-slot verify used to run beside browser jobs and other repositories' builds that ran outside any lease, until the runners' memory cap stalled its tests (Sid-Kit 0.41.1, straylight#656). `deploy-storybook.yml` and `release.yml` take `slot-wait` too, and their default time limits rise to 30 minutes to cover the wait.

## 0.2.1 - 2026-11-03

### Fixed

- `repo-kit heavy` handles SIGTERM, SIGHUP and SIGINT before its command starts. A signal that came between the start and the handlers (the command writes to the same stdout, so its reader can signal at once) killed repo-kit and left the command running; under load on Linux this hung 9 of 30 runs of its signal test, and Library checks for 0.2.0, which was never published. It also lets go of the handlers when the command cannot start.

## 0.2.0 - 2026-11-03

### Added

- Verify steps declare `memory`, the GiB they hold at their peak. A step starts only when it fits beside the running steps in the run's memory: the leased slots times slotfather's `gib_per_slot`, capped by the job's cgroup limit and Linux's MemAvailable (`REPO_KIT_VERIFY_MEMORY_GIB` overrides it). A step that never fits runs alone. Taken from Data Grid's parallel verify (straylight#656).
- A `usesCores` step gets no more workers than half the run's memory holds at `verify.workerMemory` GiB each (default 0.9), and is planned with that memory plus its own `memory` (default 0.25).
- `workers` on a step: a fixed `VITEST_MAX_WORKERS` and `REPO_KIT_WORKERS`, for example Storybook tests on 2.
- The verify summary shows the peak RSS of the steps, sampled every second, and each step's measured peak beside its declared `memory`.
- A reaper stops every step's process group when verify itself is killed outright, SIGKILL included.
- `REPO_KIT_SLOT_WAIT=<seconds>` (or Sid-Kit's `SID_KIT_SLOT_WAIT`) makes a lease give up after that long, through `slotfather run --wait`, and says so; `verify.yml` and `browser.yml` take it as `slot-wait`.

### Changed

- `browser.yml` runs the build and the check under one `repo-kit heavy` lease (`slots`, default 2), so the build queues with the runner's other jobs instead of running outside any lease.

## 0.1.2 - 2026-11-03

### Changed

- `verify.yml` runs `verify --release` only for `main` and for pull requests into `main`, as the pre-push hook does; on `dev`, other branches and manual runs there it runs without `--release`, so `## Unreleased` entries no longer fail it. `args` no longer defaults to `--release`; callers that set `--release` themselves can drop it.

## 0.1.1 - 2026-11-03

### Fixed

- `packed-consumer` installs a peer the repository declares only as a range (Text Truncate's `react: ^19.3.0`), as Inline Measure's and Text Truncate's own checks did; an exact pin still wins.

## 0.1.0 - 2026-11-03

### Added

- `repo-kit verify`: the repository's gate, with steps declared in `repo-kit.config.mjs`. Steps run as soon as the steps they need have passed, stream their output with a step prefix, stop on the first failure and forward signals. A step marked `usesCores` gets the lease's share of the cores. Taken from Sid-Kit's `scripts/verify.mjs`.
- `repo-kit pre-push`: verifies each pushed commit in a clean worktree, as a release for `main`, under one slotfather lease (`prePush.slots`). It installs with `GITHUB_TOKEN`, or `gh auth token` when that is unset, and refuses a Bun older than 1.4.4.
- `repo-kit hooks install|sync|check|status`: the tracked `.githooks` (a `pre-push` shim and Straylight's `reference-transaction`, pinned by hash), their activation, and drift checks.
- `repo-kit check`: managed hooks, `maxvyshniakov/repo-kit` workflow references and `packageManager` match the installed kit.
- `repo-kit check-changelogs`, `release` and `publish` for a root package or a workspace under `packages/`. Union of the four repositories' copies:
  - publication by SHA from any branch, worktree or detached HEAD at `origin/main`;
  - waits for the checks workflow (`publish.checks: false` skips the wait, with a warning, while no runner can run the checks);
  - runs the TLS gate itself;
  - handles GH007 tag pushes;
  - `--resume` for a partial publication;
  - `publish.notify` workflow requests.
- `repo-kit heavy`, `tls` and `packed-consumer`: the slotfather wrapper, the Bun TLS gate and the packed-consumer check, with probes declared by the repository.
- Subpath exports `./changelog`, `./release`, `./publish` and `./packed-consumer` for repository scripts such as Data Grid's catalog update.
- Reusable workflows `verify.yml`, `browser.yml`, `deploy-storybook.yml` and `release.yml`, and the composite action `actions/setup-bun`: Bun 1.4.4, the TLS gate, then `bun install`.
