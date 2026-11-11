# @maxvyshniakov/repo-kit Changelog

Versions and release rules: [README.md](README.md#versioning).

## Unreleased

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
