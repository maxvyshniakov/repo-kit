# Package-Kit

A shared verification and release workflow for Bun-based JavaScript and TypeScript libraries.

When several repositories copy the same test scripts, Git hooks and release commands, they gradually disagree.
One checks the working tree, another checks the pushed commit; one publishes the right archive, another forgets
a version or a tag. Package-Kit puts that machinery in one versioned package. Each repository declares its own
commands and pins the version that verifies them.

## What it solves

| Pain | Package-Kit's part |
| --- | --- |
| Verification scripts drift between repositories | One runner executes each project's configured steps, dependencies, timeouts and memory budget. |
| Local checks pass but the pushed revision differs | The pre-push gate checks exact outgoing commits in clean worktrees with frozen dependencies. |
| Releases need a fragile sequence of manual commands | Version/changelog checks, release gates, archive validation, publishing and tags have explicit commands; partial publishing can resume. |
| Builds and browser checks compete for the same machine | Optional Slotfather leases coordinate heavy work; the runner schedules steps within its resource budget. |
| Parallel tasks lack a common verification result | The Lanefather adapter exposes the configured checks and their actual results without copying the project workflow engine. |

It is useful for a library or a family of libraries sharing Bun, Git and GitHub-based publishing. Tests and builds
remain your commands. Browser/Storybook checks, package-consumer probes and release notifications are optional.
Consumer commands and configuration run with the invoking account's privileges; verification is not a sandbox.
The publisher currently expects one publishable package; changelog/release helpers also understand workspaces. Every
released package keeps its version in `package.json`.

## Status

Package-Kit is one maintainer's working tooling, published as a reference and case study. It verifies and releases a
small family of the author's TypeScript libraries (a component kit, a data grid and two text utilities), each of
which pins an exact version. Before 1.0.0 a minor release may break configuration or commands; every change is in
the [changelog](CHANGELOG.md). Use it as is, fork it, or borrow its ideas. Issues are welcome; see
[contributing](CONTRIBUTING.md) for what to expect.

### Terms

| Term | Meaning here |
| --- | --- |
| Consumer | A repository that installs Package-Kit and declares its checks in `package-kit.config.mjs`. |
| Step / check | One command from that configuration, with its dependencies, memory and timeout. |
| Gate | A check whose result decides something: the pre-push gate, the release gate. |
| Slot, lease | A unit of machine capacity and a running command's reservation of it, both from [Slotfather](https://github.com/maxvyshniakov/fathers/tree/main/slotfather). Without Slotfather nothing is leased. |
| Lane | Lanefather's unit of parallel work: a task with a worktree, path claims and a verification receipt. |
| Catalog | A library's Storybook, built and deployed by the optional Storybook workflow. |

## How the tools fit

| Tool | Question it answers |
| --- | --- |
| **Package-Kit** | Which checks run, did they pass, and is this exact package revision ready to publish? |
| [**Lanefather**](https://github.com/maxvyshniakov/fathers/tree/main/lanefather) | Who owns this task's paths, what was verified, and can its branch be integrated and finished? |
| [**Slotfather**](https://github.com/maxvyshniakov/fathers/tree/main/slotfather) | When may this expensive command use the shared machine, and how much capacity does it reserve? |

Use Package-Kit on its own for verification and releases. Add Slotfather when processes share a constrained machine;
without it, Package-Kit's commands run directly. Add Lanefather when coordinating parallel branches or agents.
A lane registration does not reserve machine capacity.

## Requirements and availability

- Node.js 22 or newer, Bun 1.4.4 or newer, Git, and macOS/Linux with POSIX process tools (`sh`, `ps`).
- The GitHub CLI (`gh`) for GitHub-backed release commands; local verification can run without it.
- GitHub authentication for GitHub Packages, remote release gates, publishing and notifications.
- Playwright and browser system dependencies only for features that use them. Native Safari automation requires macOS.
- Optional: [Slotfather](https://github.com/maxvyshniakov/fathers/tree/main/slotfather) on `PATH` to lease machine capacity for heavy
  commands, and Lanefather for parallel lanes. Neither is needed for verification, hooks or releases.

Process supervision and managed hooks assume POSIX behavior; native Windows is not a supported workflow.

Package releases use GitHub Packages by default. GitHub Packages' npm registry requires a token for every install,
even of a public package, and the package's own visibility is set separately from this repository's.
`publish: { registry: "npm" }` (or `["github", "npm"]`) publishes to npmjs.org from GitHub Actions instead, with npm
trusted publishing and, from a public repository, provenance:
[publishing to npmjs.org](docs/reference.md#publishing-to-npmjsorg). This README describes the development branch; use the documentation at your installed version's tag
when adopting a release.

## Install

Package-Kit is published to npmjs.org, with provenance; installing it needs no token:

```sh
bun add --dev --exact @maxvyshniakov/package-kit
```

Until 0.10.0 it was `@maxvyshniakov/repo-kit` on GitHub Packages. Moving from it: depend on
`@maxvyshniakov/package-kit`, rename `repo-kit.config.mjs` to `package-kit.config.mjs` (and its imports), call
`package-kit` and `package-kit-lane` instead of `repo-kit` and `repo-kit-lane`, rename `REPO_KIT_*` variables to
`PACKAGE_KIT_*` (Lanefather: `slot_env = "PACKAGE_KIT_SLOT"`), point workflows at `maxvyshniakov/package-kit/...`,
then run `package-kit hooks sync`. [CHANGELOG.md](CHANGELOG.md) lists every rename.

An exact pin and lockfile keep older commits verifiable with the kit they used.
To inspect or develop the tool from a source checkout:

```sh
git clone https://github.com/maxvyshniakov/package-kit.git
cd package-kit
bun install
bun run package-kit help
```

## A minimal verification setup

Add scripts to your project's `package.json`:

```json
{
  "scripts": {
    "test": "node --test",
    "verify": "package-kit verify"
  }
}
```

Create `package-kit.config.mjs`:

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
that consume another step's output, and `inputs` globs to run only the steps a change touches via
`package-kit verify --changed [--base REF] [--plan]` (and scoped Lanefather lane checks). Independent steps can run
together when their declared memory fits. Output streams with step names, and a failed or timed-out command fails
the run.

Package-Kit rejects a key it does not know, in the config or in a step, with its path and the nearest known key
(`unknown key verify.stepTimout; did you mean verify.stepTimeout?`), so a typo fails instead of doing nothing.

[Configuration and workspace examples](docs/reference.md#package-kitconfigmjs) ·
[Change-aware selection and planning](docs/reference.md#change-aware-selection-and-planning) ·
[Memory and worker budgets](docs/reference.md#step-memory)

## Git hooks and branch policy

To adopt the managed hooks:

```sh
bun run package-kit hooks sync
bun run package-kit hooks install
```

Commit the generated files. The pre-push hook verifies outgoing commits rather than uncommitted local files.
The managed `reference-transaction` hook also protects agent updates to `dev` and `main`: those updates use
Lanefather's landing lock and `lanefather promote`. This is an opinionated branch policy; run verification directly
or in CI if you only want the check runner. Package-Kit's own repository uses a separate main-only publishing policy.

## Changelog entries

A commit that changes what a package ships must say so in its changelog. List the shipped paths in
`package-kit.config.mjs`:

```js
export default {
  changelog: { paths: ["packages/sid-kit/src/**", "!packages/sid-kit/src/**/*.test.tsx"] },
};
```

Each commit touching those paths then adds, changes or removes a line under `## Unreleased` in that package's
`CHANGELOG.md`, or ends its message with the trailer `Changelog: none`, optionally with a reason:
`Changelog: none (tests only)`. One such trailer covers every package the commit changes.
Merge commits and release commits (the version cut `package-kit release` writes) are exempt. Without `changelog.paths`
nothing is checked.

`package-kit hooks sync` then also writes a managed `commit-msg` hook, which checks the commit being made; when it
cannot run the kit it warns and lets the commit through.
`package-kit check-changelog-entries origin/main..HEAD` checks every commit of a range, for a verify step or CI.
The check reads only Git: the same commits give the same answer everywhere.

[Configuration, CI and an AGENTS.md paragraph](docs/reference.md#changelog-entries)

## Working with Lanefather

A consumer using parallel lanes supplies `.lanefather.toml` with its project identity, state location and:

```toml
[checks]
verify = ".githooks/lane-check"
slot_env = "PACKAGE_KIT_SLOT"
```

With a release containing `package-kit-lane`, run `package-kit hooks sync` and commit the managed entry. It prepares each
checkout's frozen dependencies, then runs that checkout's locked adapter. The first adapter version conservatively
selects all configured normal and optional browser checks; no consumer-specific paths are built in.
Lanefather records the receipt and handles integration, review and cleanup. A previously published task that never
went through lane landing still needs separate publication reconciliation.

[Adapter protocol, preparation and result semantics](docs/reference.md#lane-verification-adapter)

## Commands

| Task | Command |
| --- | --- |
| Run normal checks | `package-kit verify` |
| Run configured browser checks | `package-kit verify --browser` |
| Check configuration, hooks and workflow pins | `package-kit check` |
| Validate the packed package in a consumer | `package-kit packed-consumer` |
| Check changelog entries of a commit range | `package-kit check-changelog-entries <base>..<head>` |
| Cut versions and changelogs | `package-kit release` |
| Verify an exact release revision | `package-kit release-gate <ref>` |
| Publish that verified revision | `package-kit publish` |
| Capture a catalog story | `package-kit shoot` |
| Keep fixed sleeps and timing asserts out of tests, shrink-only | `package-kit test-hygiene` |
| Record and rank agent friction with packages (deprecated: moving to Mastack) | `package-kit friction log\|report\|export` |

[Full command reference](docs/reference.md#commands) · [Story screenshots](docs/reference.md#story-screenshots) · [Friction journal](docs/reference.md#friction-journal)

The friction journal's format is data: [`friction-contract.json`](friction-contract.json), shipped in the package,
holds its schema, build, write, fingerprint and redaction rules and golden cases, and is the format's source. A writer in
another language keeps a pinned copy with its SHA-256 (as `hooks/reference-transaction` pins Lanefather's hook) and
runs the cases against itself.

## Release gate

Verification, publication and deployment are separate results. The default local release gate checks an exact
revision in a temporary worktree and records a GitHub commit status. A project can instead require its configured
CI checks. Publishing validates the selected gate, package contents and source revision before uploading/tagging.

[Release gate and partial-publication recovery](docs/reference.md#release-gate)

## Workflows

Reusable verification, browser, release and catalog-deployment workflows are included. Pin the kit's release tag
and configure the token permissions for your repository. They run on GitHub-hosted `ubuntu-latest` unless the
caller passes `runner`; a private repository may pass a self-hosted runner, for example
`runner: '["self-hosted", "homelab"]'`. In a public repository a self-hosted label fails the job on a GitHub-hosted
runner before anything is checked out:

```yaml
jobs:
  check:
    uses: maxvyshniakov/package-kit/.github/workflows/verify.yml@v1.2.0
    permissions:
      contents: read
      packages: read
```

The verification and browser jobs never hold more than `contents: read` and `packages: read`; only `release.yml`
writes. Package-Kit's own pull-request checks use GitHub-hosted runners. In a public repository, a pull request from a
fork runs the workflow files of that pull request, so it can choose any runner registered to the repository: do not
register a self-hosted runner on a public repository, or require approval for every outside contributor's workflow
runs. Before the heavy jobs, `verified-tree.yml` can look up a passed result for the same tree and plan (another branch,
a pull request head, last night's run, the local release gate) and let `verify.yml` and `browser.yml` skip with a
link to it. [docs/templates/check.yml](docs/templates/check.yml) is a complete caller: fast checks on main pushes,
the full suite nightly and on release tags, docs-only changes skipped and optional JUnit uploads.
See [workflow inputs and browser prerequisites](docs/reference.md#workflows) and [security](SECURITY.md).

## GITHUB_TOKEN

Use `read:packages` for installation and the required write scopes only for publishing or commit-status updates.
Local commands that need GitHub access can fall back to `gh auth token`; CI uses the caller's workflow token and
package access settings. [Authentication reference](docs/reference.md#github_token) ·
[GitHub Packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)

## Versioning

Pin package and workflow versions together. Changes are compatible first: a new form comes in beside the old one,
which is deprecated and removed later together with other deprecated forms in one minor release. A change is Breaking
only when no transition period could avoid it, and its changelog entry says why (`No transition period: …`);
`check-changelogs` fails a Breaking entry without that line. Releases follow consumer need, not every change.
Cut a release, publish the exact verified revision, then update consumer pins and managed hooks. Registry publication
and downstream adoption have their own checks and permissions.
[Versioning rules and maintainer release procedure](docs/reference.md#versioning)

## Developing

`bun run test` runs the tool's tests. `bun run verify` is its full gate; the pre-push hook runs it on the outgoing
commit, so do not duplicate it immediately before pushing. See [verification](docs/agents/checks.md) and
[repository publishing](docs/agents/publishing.md). The code uses Node's standard library without runtime dependencies;
optional browser functionality uses the consumer's Playwright installation.

[Contributing](CONTRIBUTING.md) · [Reporting a vulnerability](SECURITY.md)

## License

[MIT](LICENSE).
