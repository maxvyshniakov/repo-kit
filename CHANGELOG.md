# @maxvyshniakov/repo-kit Changelog

Versions and release rules: [README.md](README.md#versioning).

## Unreleased

## 0.1.0 - 2026-11-03

### Added

- `repo-kit verify`: the repository's gate, with steps declared in `repo-kit.config.mjs`. Steps run as soon as the steps they need have passed, stream their output with a step prefix, stop on the first failure and forward signals. A step marked `usesCores` gets the lease's share of the cores. Taken from Sid-Kit's `scripts/verify.mjs`.
- `repo-kit pre-push`: verifies each pushed commit in a clean worktree, as a release for `main`, under one slotfather lease (`prePush.slots`). It installs with `GITHUB_TOKEN`, or `gh auth token` when that is unset, and refuses a Bun older than 1.4.4.
- `repo-kit hooks install|sync|check|status`: the tracked `.githooks` (a `pre-push` shim and Straylight's `reference-transaction`, pinned by hash), their activation, and drift checks.
- `repo-kit check`: managed hooks, `maxvyshniakov/repo-kit` workflow references and `packageManager` match the installed kit.
- `repo-kit check-changelogs`, `release` and `publish` for a root package or a workspace under `packages/`. Union of the four repositories' copies:
  - publication by SHA from any branch, worktree or detached HEAD at `origin/main`;
  - waits for the checks workflow;
  - runs the TLS gate itself;
  - handles GH007 tag pushes;
  - `--resume` for a partial publication;
  - `publish.notify` workflow requests.
- `repo-kit heavy`, `tls` and `packed-consumer`: the slotfather wrapper, the Bun TLS gate and the packed-consumer check, with probes declared by the repository.
- Reusable workflows `verify.yml`, `browser.yml`, `deploy-storybook.yml` and `release.yml`, and the composite action `actions/setup-bun`: Bun 1.4.4, the TLS gate, then `bun install`.
