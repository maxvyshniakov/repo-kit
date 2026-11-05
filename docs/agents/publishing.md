# Publishing

## Branch and gate

One active branch, `main`, also the cleanup base. Version tags mark releases.
Existing `dev` is historical and is not updated by ordinary work.
The pre-push hook runs `bun run verify` on the exact outgoing commit in a clean
worktree; do not repeat the gate before pushing. Its ordinary-main policy permits
Unreleased changelog entries. Release validation remains explicit.

## Push

Fetch `origin`, rebase a task branch onto `origin/main`, then push its explicit SHA:
`git push origin <sha>:refs/heads/main`. Fast-forward the main checkout afterwards.
No Straylight promote tool or landing token is needed in this repository.
Use task worktrees under `.claude/worktrees/` when the shared checkout is dirty;
remove only worktrees belonging to completed, integrated work.

## CI

`check.yml` (Library checks) runs on main and pull requests. Follow
`gh run list --repo maxvyshniakov/repo-kit --commit <sha>` and
`gh run watch <run-id> --repo maxvyshniakov/repo-kit --exit-status` to completion.
The self-hosted homelab runner may queue; report an unavailable runner separately.

## Release

Only on an explicit release request: follow [README versioning](../../README.md#versioning).
Cut the version, push main, run `bun run repo-kit release-gate origin/main`, then
`bun run release:publish` from that exact clean revision. Publication to GitHub
Packages and tags is separate from an ordinary push. Update consumer pins only
within their authorized tasks. Repository visibility remains private.

## After push

No installation or deployment is implied. Report the SHA, remote main, CI result
and any consumer changes still pending.
