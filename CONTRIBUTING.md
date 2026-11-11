# Contributing

Repo-Kit is one maintainer's tooling, shared as a reference. Issues with a reproduction are welcome. Pull requests
are read, but a change that adds scope or alters a command's behavior may be declined to keep the kit small; open an
issue first for anything beyond a small fix.

For a pull request:

- Keep the kit free of runtime dependencies; it uses Node's standard library.
- Add a focused test under `test/` for a behavior change, and an entry under `## Unreleased` in
  [CHANGELOG.md](CHANGELOG.md) for anything a consumer would notice.
- Run `bun install` and `bun run verify` (Node 22+, Bun 1.4.4+). The upstream-hook comparison is skipped without a
  Lanefather checkout, and Slotfather is optional.

Security reports go through [SECURITY.md](SECURITY.md), not issues. Contributions are licensed under the
[MIT License](LICENSE).
