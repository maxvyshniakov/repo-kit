# repo-kit

This repository owns `@maxvyshniakov/repo-kit`. It holds the shared verify, pre-push, release and publish tooling,
plus the reusable workflows of the Sid-Kit, Data Grid, Inline Measure and Text Truncate repositories.
[README.md](README.md) is the reference for its commands, config, workflows and release order.

The repository and the package are private. Publishing publicly or making the repository public needs explicit
authorization.

- Behavior changes need focused tests in `test/`. Consumer-visible changes go under `## Unreleased` in CHANGELOG.md.
- The kit runs in every consumer's pre-push hook and CI. Keep it dependency-free.
- Keep its behavior a union of what the consumers relied on: a fix to one consumer's needs must not drop another's.
- `hooks/reference-transaction` is a pinned copy of Straylight's `tools/agent-hooks/reference-transaction`. Change it
  only by copying that file and updating `REFERENCE_TRANSACTION_SHA256`.
- `bun run verify` is the push gate. The pre-push hook runs it, so do not run it by hand right before pushing.
- Everyday pushes go to `dev`. A release pushes the same tip to `dev` and `main`. Push through Straylight's
  `tools/lane promote`.
- Several agents may share this working tree. Never stash, check out, restore or reset files you did not change.
