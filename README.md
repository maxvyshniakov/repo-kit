# Repo-Kit

A shared verification and release workflow for Bun-based JavaScript and TypeScript libraries.

When several repositories copy the same test scripts, Git hooks and release commands, they gradually disagree.
One checks the working tree, another checks the pushed commit; one publishes the right archive, another forgets
a version or a tag. Repo-Kit puts that machinery in one versioned package. Each repository declares its own
commands and pins the version that verifies them.

## What it solves

| Pain | Repo-Kit's part |
| --- | --- |
| Verification scripts drift between repositories | One runner executes each project's configured steps, dependencies, timeouts and memory budget. |
| Local checks pass but the pushed revision differs | The pre-push gate checks exact outgoing commits in clean worktrees with frozen dependencies. |
| Releases need a fragile sequence of manual commands | Version/changelog checks, release gates, archive validation, publishing and tags have explicit commands; partial publishing can resume. |
| Builds and browser checks compete for the same machine | Optional Slotfather leases coordinate heavy work; the runner schedules steps within its resource budget. |
| Parallel tasks lack a common verification result | The Lanefather adapter exposes the configured checks and their actual results without copying the project workflow engine. |

It is useful for a library or a family of libraries sharing Bun, Git and GitHub-based publishing. Tests and builds
remain your commands. Browser/Storybook checks, package-consumer probes and release notifications are optional.
Consumer commands and configuration run with the invoking account's privileges; verification is not a sandbox.
The publisher currently expects one publishable package; changelog/release helpers also understand workspaces.

## How the tools fit

| Tool | Question it answers |
| --- | --- |
| **Repo-Kit** | Which checks run, did they pass, and is this exact package revision ready to publish? |
| [**Lanefather**](https://github.com/maxvyshniakov/lanefather) | Who owns this task's paths, what was verified, and can its branch be integrated and finished? |
| [**Slotfather**](https://github.com/maxvyshniakov/slotfather) | When may this expensive command use the shared machine, and how much capacity does it reserve? |

Use Repo-Kit on its own for verification and releases. Add Slotfather when processes share a constrained machine;
without it, Repo-Kit's commands run directly. Add Lanefather when coordinating parallel branches or agents.
A lane registration does not reserve machine capacity.

## Requirements and availability

- Node.js 22 or newer, Bun 1.4.4 or newer, Git, and macOS/Linux with POSIX process tools (`sh`, `ps`).
- The GitHub CLI (`gh`) for GitHub-backed release commands; local verification can run without it.
- GitHub authentication for GitHub Packages, remote release gates, publishing and notifications.
- Playwright and browser system dependencies only for features that use them. Native Safari automation requires macOS.

Process supervision and managed hooks assume POSIX behavior; native Windows is not a supported workflow.

Package releases currently use GitHub Packages, not the public npm registry. Installation requires authentication
and access to the package. Repository visibility and package permissions are separate; opening this repository
does not automatically enable anonymous package installation. This README describes the development branch;
use the documentation at your installed version's tag when adopting a release.

## Install

Add the scope to your project's `bunfig.toml`:

```toml
[install.scopes]
maxvyshniakov = { url = "https://npm.pkg.github.com/", token = "$GITHUB_TOKEN" }
```

Then, with package access:

```sh
export GITHUB_TOKEN="$(gh auth token)"  # read:packages
bun add --dev --exact @maxvyshniakov/repo-kit
```

An exact pin and lockfile keep older commits verifiable with the kit they used.
To inspect or develop the tool from an accessible source checkout:

```sh
git clone https://github.com/maxvyshniakov/repo-kit.git
cd repo-kit
bun install
bun run repo-kit help
```

## A minimal verification setup

Add scripts to your project's `package.json`:

```json
{
  "scripts": {
    "test": "node --test",
    "verify": "repo-kit verify"
  }
}
```

Create `repo-kit.config.mjs`:

```js
export default {
  verify: {
    steps: [
      { name: "tests", command: ["run", "test"], memory: 0.5 }
    ]
  }
};
```

Run `bun run verify`. Replace the example step with your actual test/build commands; add `needs` to order steps
that consume another step's output. Independent steps can run together when their declared memory fits.
Output streams with step names, and a failed or timed-out command fails the run.

[Configuration and workspace examples](docs/reference.md#repo-kitconfigmjs) ·
[Memory and worker budgets](docs/reference.md#step-memory)

## Git hooks and branch policy

To adopt the managed hooks:

```sh
bun run repo-kit hooks sync
bun run repo-kit hooks install
```

Commit the generated files. The pre-push hook verifies outgoing commits rather than uncommitted local files.
The managed `reference-transaction` hook also protects agent updates to `dev` and `main`: those updates use
Lanefather's landing lock and `lanefather promote`. This is an opinionated branch policy; run verification directly
or in CI if you only want the check runner. Repo-Kit's own repository uses a separate main-only publishing policy.

## Working with Lanefather

A consumer using parallel lanes supplies `.lanefather.toml` with its project identity, state location and:

```toml
[checks]
verify = ".githooks/lane-check"
slot_env = "REPO_KIT_SLOT"
```

With a release containing `repo-kit-lane`, run `repo-kit hooks sync` and commit the managed entry. It prepares each
checkout's frozen dependencies, then runs that checkout's locked adapter. The first adapter version conservatively
selects all configured normal and optional browser checks; no Data Grid, Sid-Kit or Straylight paths are built in.
Lanefather records the receipt and handles integration, review and cleanup. A previously published task that never
went through lane landing still needs separate publication reconciliation.

[Adapter protocol, preparation and result semantics](docs/reference.md#lane-verification-adapter)

## Commands

| Task | Command |
| --- | --- |
| Run normal checks | `repo-kit verify` |
| Run configured browser checks | `repo-kit verify --browser` |
| Check configuration, hooks and workflow pins | `repo-kit check` |
| Validate the packed package in a consumer | `repo-kit packed-consumer` |
| Cut versions and changelogs | `repo-kit release` |
| Verify an exact release revision | `repo-kit release-gate <ref>` |
| Publish that verified revision | `repo-kit publish` |
| Capture a catalog story | `repo-kit shoot` |

[Full command reference](docs/reference.md#commands) · [Story screenshots](docs/reference.md#story-screenshots)

## Release gate

Verification, publication and deployment are separate results. The default local release gate checks an exact
revision in a temporary worktree and records a GitHub commit status. A project can instead require its configured
CI checks. Publishing validates the selected gate, package contents and source revision before uploading/tagging.

[Release gate and partial-publication recovery](docs/reference.md#release-gate)

## Workflows

Reusable verification, browser, release and catalog-deployment workflows are included. Pin the kit's release tag
and configure the runner and token permissions for your repository. Their existing default runner labels are
`self-hosted, homelab`; external consumers should explicitly choose an appropriate runner, for example:

```yaml
jobs:
  check:
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.3.1
    with:
      runner: '["ubuntu-latest"]'
    permissions:
      contents: read
      packages: read
```

Repo-Kit's own pull-request checks use GitHub-hosted runners. Do not run untrusted pull-request code on a private
self-hosted machine. See [workflow inputs and browser prerequisites](docs/reference.md#workflows).

## GITHUB_TOKEN

Use `read:packages` for installation and the required write scopes only for publishing or commit-status updates.
Local commands that need GitHub access can fall back to `gh auth token`; CI uses the caller's workflow token and
package access settings. [Authentication reference](docs/reference.md#github_token) ·
[GitHub Packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)

## TLS gate

Setup and publishing perform live TLS checks before installation or credential use. They need network access to
the registry and certificate-test hosts; DNS failures/timeouts fail the gate. Offline or restricted-network use
therefore needs planning. [Exact probes and boundaries](docs/reference.md#tls-gate)

## Versioning

Pin package and workflow versions together. Cut a release, publish the exact verified revision, then update
consumer pins and managed hooks. Registry publication and downstream adoption have their own checks and permissions.
[Maintainer release procedure](docs/reference.md#versioning)

## Developing

`bun run test` runs the tool's tests. `bun run verify` is its full gate; the pre-push hook runs it on the outgoing
commit, so do not duplicate it immediately before pushing. See [verification](docs/agents/checks.md) and
[repository publishing](docs/agents/publishing.md). The code uses Node's standard library without runtime dependencies;
optional browser functionality uses the consumer's Playwright installation.

## License

[MIT](LICENSE).
