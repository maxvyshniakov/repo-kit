# Checks

Focused behavior: `slotfather run -n 1 --priority interactive -- node --test test/<area>.test.mjs`.
Full gate: `bun run verify` acquires its own lease and runs changelog, configuration,
pinned upstream-hook, unit and packed-consumer checks. The pre-push hook runs it
on the outgoing tree; reuse that result rather than running it twice.
`bun run repo-kit release-gate <sha>` additionally requires release-ready changelogs
and any configured browser checks; an ordinary main push is not a package release.

Keep consumer behavior covered when changing shared commands. Browser/Safari
capture changes need their focused integration acceptance in addition to parser
tests. Preserve the canonical reference-transaction hook and its SHA pin for
consumers; repo-kit's own single-branch checkout omits that hook.
Tool versions live in package.json and the reusable setup action.
