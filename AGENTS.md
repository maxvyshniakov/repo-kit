# repo-kit

This repository owns `@maxvyshniakov/repo-kit`. It holds the shared verify, pre-push, release and publish tooling,
plus the reusable workflows of the Sid-Kit, Data Grid, Inline Measure and Text Truncate repositories.
[README.md](README.md) is the reference for its commands, config, workflows and release order.

Changing repository/package visibility or publishing to another registry requires explicit owner authorization.

- Behavior changes need focused tests in `test/`. Consumer-visible changes go under `## Unreleased` in CHANGELOG.md.
- The kit runs in every consumer's pre-push hook and CI. Keep it dependency-free.
- Keep its behavior a union of what the consumers relied on: a fix to one consumer's needs must not drop another's.
- `hooks/reference-transaction` is a pinned copy of Lanefather's `hooks/reference-transaction`. Change it
  only by copying that file and updating `REFERENCE_TRANSACTION_SHA256`.
- Checks: [docs/agents/checks.md](docs/agents/checks.md).
- Commit, push and release: [docs/agents/publishing.md](docs/agents/publishing.md).
- Parallel work: [docs/agents/orchestration.md](docs/agents/orchestration.md).
- Domain reference: [docs/agents/domain.md](docs/agents/domain.md).
- Issues: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- Several agents may share this working tree. Never stash, check out, restore or reset files you did not change.
