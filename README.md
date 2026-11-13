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
The publisher currently expects one publishable package; changelog/release helpers also understand workspaces and
Python packages, whose version lives in `pyproject.toml`.

## Status

Repo-Kit is one maintainer's working tooling, published as a reference and case study. It verifies and releases a
small family of the author's TypeScript libraries (a component kit, a data grid and two text utilities), each of
which pins an exact version. Before 1.0.0 a minor release may break configuration or commands; every change is in
the [changelog](CHANGELOG.md). Use it as is, fork it, or borrow its ideas. Issues are welcome; see
[contributing](CONTRIBUTING.md) for what to expect.

### Terms

| Term | Meaning here |
| --- | --- |
| Consumer | A repository that installs Repo-Kit and declares its checks in `repo-kit.config.mjs`. |
| Step / check | One command from that configuration, with its dependencies, memory and timeout. |
| Gate | A check whose result decides something: the pre-push gate, the release gate, the TLS gate. |
| Slot, lease | A unit of machine capacity and a running command's reservation of it, both from [Slotfather](https://github.com/maxvyshniakov/fathers/tree/main/slotfather). Without Slotfather nothing is leased. |
| Lane | Lanefather's unit of parallel work: a task with a worktree, path claims and a verification receipt. |
| Catalog | A library's Storybook, built and deployed by the optional Storybook workflow. |

## How the tools fit

| Tool | Question it answers |
| --- | --- |
| **Repo-Kit** | Which checks run, did they pass, and is this exact package revision ready to publish? |
| [**Lanefather**](https://github.com/maxvyshniakov/fathers/tree/main/lanefather) | Who owns this task's paths, what was verified, and can its branch be integrated and finished? |
| [**Slotfather**](https://github.com/maxvyshniakov/fathers/tree/main/slotfather) | When may this expensive command use the shared machine, and how much capacity does it reserve? |

Use Repo-Kit on its own for verification and releases. Add Slotfather when processes share a constrained machine;
without it, Repo-Kit's commands run directly. Add Lanefather when coordinating parallel branches or agents.
A lane registration does not reserve machine capacity.

## Requirements and availability

- Node.js 22 or newer, Bun 1.4.4 or newer, Git, and macOS/Linux with POSIX process tools (`sh`, `ps`).
- The GitHub CLI (`gh`) for GitHub-backed release commands; local verification can run without it.
- GitHub authentication for GitHub Packages, remote release gates, publishing and notifications.
- Playwright and browser system dependencies only for features that use them. Native Safari automation requires macOS.
- Optional: [Slotfather](https://github.com/maxvyshniakov/fathers/tree/main/slotfather) on `PATH` to lease machine capacity for heavy
  commands, and Lanefather for parallel lanes. Neither is needed for verification, hooks or releases.

Process supervision and managed hooks assume POSIX behavior; native Windows is not a supported workflow.

Package releases currently use GitHub Packages, not the public npm registry. GitHub Packages' npm registry requires
a token for every install, even of a public package, and the package's own visibility is set separately from this
repository's. This README describes the development branch; use the documentation at your installed version's tag
when adopting a release.

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
To inspect or develop the tool from a source checkout:

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

## Changelog entries

A commit that changes what a package ships must say so in its changelog. List the shipped paths in
`repo-kit.config.mjs`:

```js
export default {
  changelog: { paths: ["packages/sid-kit/src/**", "!packages/sid-kit/src/**/*.test.tsx"] },
};
```

Each commit touching those paths then adds, changes or removes a line under `## Unreleased` in that package's
`CHANGELOG.md`, or ends its message with the trailer `Changelog: none`, optionally with a reason:
`Changelog: none (tests only)`. One such trailer covers every package the commit changes.
Merge commits and release commits (the version cut `repo-kit release` writes) are exempt. Without `changelog.paths`
nothing is checked.

`repo-kit hooks sync` then also writes a managed `commit-msg` hook, which checks the commit being made; when it
cannot run the kit it warns and lets the commit through.
`repo-kit check-changelog-entries origin/main..HEAD` checks every commit of a range, for a verify step or CI.
The check reads only Git: the same commits give the same answer everywhere.

[Configuration, CI and an AGENTS.md paragraph](docs/reference.md#changelog-entries)

## Working with Lanefather

A consumer using parallel lanes supplies `.lanefather.toml` with its project identity, state location and:

```toml
[checks]
verify = ".githooks/lane-check"
slot_env = "REPO_KIT_SLOT"
```

With a release containing `repo-kit-lane`, run `repo-kit hooks sync` and commit the managed entry. It prepares each
checkout's frozen dependencies, then runs that checkout's locked adapter. The first adapter version conservatively
selects all configured normal and optional browser checks; no consumer-specific paths are built in.
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
| Check changelog entries of a commit range | `repo-kit check-changelog-entries <base>..<head>` |
| Cut versions and changelogs | `repo-kit release` |
| Verify an exact release revision | `repo-kit release-gate <ref>` |
| Publish that verified revision | `repo-kit publish` |
| Capture a catalog story | `repo-kit shoot` |
| Keep fixed sleeps and timing asserts out of tests, shrink-only | `repo-kit test-hygiene` |

[Full command reference](docs/reference.md#commands) · [Story screenshots](docs/reference.md#story-screenshots)

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
    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.6.2
    permissions:
      contents: read
      packages: read
```

The verification and browser jobs never hold more than `contents: read` and `packages: read`; only `release.yml`
writes. Repo-Kit's own pull-request checks use GitHub-hosted runners. In a public repository, a pull request from a
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

## TLS gate

Setup and publishing check the Bun runtime before installation or credential use. The gate is offline and takes
milliseconds: Bun 1.4.4 or later, and none of the eMudhra incident roots in its root store or in the bundles that
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR` name, the CA variables Bun 1.4.4 reads (a Homebrew CA bundle
passes). A bundle path it cannot read, one without certificates, or a store it cannot read offline (`NODE_USE_SYSTEM_CA`,
`--use-system-ca`) fails, unless `REPO_KIT_TLS_ALLOW_CA_ENV=1` lets it through unchecked; an incident root always fails.
A live probe of the incident hosts runs beside it until 2027-02-01: it fails only when such a host answers, and
timeouts or DNS errors only warn. Publishing also needs `registry.npmjs.org` to answer. [Exact checks and boundaries](docs/reference.md#tls-gate)

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
