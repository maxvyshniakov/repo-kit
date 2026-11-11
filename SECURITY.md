# Security

## Reporting a vulnerability

Report it privately through GitHub: this repository's **Security** tab → **Report a vulnerability**. Please do not
open a public issue for a vulnerability. Include the affected version or commit, what an attacker controls, and the
smallest reproduction you have. Repo-Kit is maintained by one person in spare time; expect an acknowledgement within
about a week, and a fix in the next release when the report holds.

Only the latest release is supported.

## What is in scope

- The pre-push, release-gate and publish commands: anything that lets a pushed commit, a package archive or a
  registry response run code or publish something the maintainer did not intend.
- The reusable workflows and the `setup-bun` action: token permissions, secret handling, and inputs reaching a shell.
- The TLS gate: a Bun runtime or network path that passes it while trusting a certificate it should reject.

## What is not

Verification runs the consumer's own configured commands with the invoking account's privileges. It is not a
sandbox, and a repository's `repo-kit.config.mjs`, scripts and dependencies are trusted code.

## Running the workflows safely

The reusable workflows run on the runner the caller names. A pull request from a fork runs that pull request's own
workflow files, so in a public repository it can target any runner registered to that repository. Keep public pull
request checks on GitHub-hosted runners, register no self-hosted runner on a public repository (or require approval
for every outside contributor's workflow runs), and never check out pull-request code in a `pull_request_target`
workflow. The verification and browser jobs hold only `contents: read` and `packages: read`.
