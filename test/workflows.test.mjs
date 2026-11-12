import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { KIT_VERSION, kitReferences } from "../src/check.mjs";
import { BUN_VERSION } from "../src/token.mjs";
import { TLS_GATE } from "../src/tls.mjs";
import { kitRoot } from "./fixtures.mjs";

const workflowsDir = path.join(kitRoot, ".github/workflows");
const read = file => fs.readFileSync(file, "utf8");
const reusable = ["verify.yml", "browser.yml", "deploy-storybook.yml", "release.yml"];
const action = read(path.join(kitRoot, "actions/setup-bun/action.yml"));

test("the reusable workflows run only when called", () => {
  for (const file of reusable) {
    const text = read(path.join(workflowsDir, file));
    assert.match(text, /^on:\n {2}workflow_call:\n/m, file);
    assert.doesNotMatch(text, /^ {2}(push|pull_request|workflow_dispatch|schedule):/m, file);
  }
});

test("every reusable workflow sets up Bun through the action at this release's tag", () => {
  for (const file of reusable) {
    const references = kitReferences(read(path.join(workflowsDir, file)));
    assert.ok(references.some(({ target }) => target === "actions/setup-bun"), file);
    for (const { ref } of references) assert.equal(ref, `v${KIT_VERSION}`, file);
    assert.doesNotMatch(read(path.join(workflowsDir, file)), /oven-sh\/setup-bun/, `${file} must not bypass the TLS gate`);
  }
});

const releaseArgs = "RELEASE_ARGS: ${{ (github.ref == 'refs/heads/main' || github.base_ref == 'main') && '--release' || '' }}";

test("verify.yml passes --release for main and pull requests into main only", () => {
  const text = read(path.join(workflowsDir, "verify.yml"));
  assert.ok(text.includes(releaseArgs));
  assert.match(text, /- run: bun run verify -- \$RELEASE_ARGS \$VERIFY_ARGS\n/);
  assert.match(text, /args:\n(?:\s+\w.*\n)*?\s+default: ""\n/, "args must not default to --release");
});

test("verify.yml checks out one commit unless the caller asks for history", () => {
  const text = read(path.join(workflowsDir, "verify.yml"));
  assert.match(text, /fetch-depth:\n(?:\s+\w.*\n)*?\s+default: 1\n/);
  assert.match(text, /- uses: actions\/checkout@[0-9a-f]{40}\n {8}with:\n {10}fetch-depth: \$\{\{ inputs\.fetch-depth \}\}\n/);
});

test("repo-kit's own main checks use the current action and ordinary verification", () => {
  const text = read(path.join(workflowsDir, "check.yml"));
  assert.match(text, /- uses: \.\/actions\/setup-bun\n/);
  assert.ok(!text.includes(releaseArgs));
  assert.match(text, /- run: bun run verify\n/);
  assert.match(text, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.match(text, /workflow_dispatch:/);
});

test("browser.yml builds once and runs every check after it in one job, under one lease", () => {
  const browser = read(path.join(workflowsDir, "browser.yml"));
  assert.match(browser, /- run: node_modules\/\.bin\/repo-kit heavy "\$SLOTS" sh -c 'eval "\$BUILD" && node_modules\/\.bin\/repo-kit checks'\n/);
  assert.match(browser, /REPO_KIT_CHECKS: \$\{\{ inputs\.checks \}\}\n/);
  // A job per check built Storybook once per check: three builds at once broke
  // Sid-Kit 0.41.1's checks on a self-hosted runner with a 10 GiB cap.
  assert.doesNotMatch(browser, /matrix:/, "one job, one build");
  assert.match(browser, /name: \$\{\{ join\(fromJSON\(inputs\.checks\)\.\*\.name, ' \+ '\) \}\}\n/, "the job is named by its checks");
  assert.doesNotMatch(browser, /- run: eval "\$BUILD"\n/, "the build must not run outside the lease");
  for (const file of ["verify.yml", "browser.yml"]) {
    const text = read(path.join(workflowsDir, file));
    assert.match(text, /\n      slot-wait:\n/, file);
    assert.match(text, /REPO_KIT_SLOT_WAIT: \$\{\{ inputs\.slot-wait \}\}\n/, file);
  }
});

test("every heavy step of the reusable workflows runs under a lease of the whole runner by default", () => {
  const leased = {
    "verify.yml": /- run: bun run verify -- \$RELEASE_ARGS \$VERIFY_ARGS\n/,
    "deploy-storybook.yml": /run: node_modules\/\.bin\/repo-kit heavy "\$SLOTS" sh -c 'bun run build && bun run storybook:build'\n/,
    "browser.yml": /- run: node_modules\/\.bin\/repo-kit heavy "\$SLOTS" sh -c 'eval "\$BUILD" && node_modules\/\.bin\/repo-kit checks'\n/,
    "release.yml": /run: node_modules\/\.bin\/repo-kit heavy "\$SLOTS" sh -c 'eval "\$COMMAND"'\n/,
  };
  for (const [file, step] of Object.entries(leased)) {
    const text = read(path.join(workflowsDir, file));
    assert.match(text, step, file);
    assert.match(text, /\n      slots:\n(?:        .*\n)*?        type: string\n        default: all\n/, `${file}: slots defaults to all`);
    assert.match(text, /REPO_KIT_SLOT_WAIT: \$\{\{ inputs\.slot-wait \}\}\n/, file);
    // Nothing heavy outside the lease: no build or check as a step of its own.
    assert.doesNotMatch(text, /- run: (bun run (build|storybook:build|storybook:prepare-deploy)|eval "\$(BUILD|CHECK|COMMAND)")\n/, `${file} runs a heavy step outside the lease`);
  }
  // prepare-deploy installs and builds the retained releases' Storybooks: heavy.
  assert.match(read(path.join(workflowsDir, "deploy-storybook.yml")), /run: node_modules\/\.bin\/repo-kit heavy "\$SLOTS" bun run storybook:prepare-deploy\n/);
  // verify leases itself: the workflow tells it how many slots.
  assert.match(read(path.join(workflowsDir, "verify.yml")), /REPO_KIT_VERIFY_SLOTS: \$\{\{ inputs\.slots \}\}\n/);
});

test("third-party actions are pinned by commit SHA", () => {
  const files = [...fs.readdirSync(workflowsDir).map(file => path.join(workflowsDir, file)), path.join(kitRoot, "actions/setup-bun/action.yml")];
  for (const file of files) {
    for (const [, target] of read(file).matchAll(/uses: ([^\s]+)/g)) {
      if (target.startsWith("./") || target.startsWith("maxvyshniakov/repo-kit/")) continue;
      assert.match(target, /@[0-9a-f]{40}$/, `${path.basename(file)}: ${target}`);
    }
  }
});

test("the action installs the Bun the kit requires and runs the kit's TLS gate before bun install", () => {
  assert.match(action, new RegExp(`bun-version:\\n(?: {4}.*\\n)*? {4}default: "${BUN_VERSION.replaceAll(".", "\\.")}"`));
  const gate = action.indexOf('run: bun "$GITHUB_ACTION_PATH/../../src/tls-gate.mjs"');
  assert.ok(gate > 0 && gate < action.indexOf("run: bun install --frozen-lockfile"));
  assert.equal(path.resolve(kitRoot, "actions/setup-bun", "../../src/tls-gate.mjs"), TLS_GATE);
  assert.ok(fs.existsSync(TLS_GATE));
});

test("inputs reach shell commands through the environment, not through expressions", () => {
  for (const file of reusable) {
    for (const [, command] of read(path.join(workflowsDir, file)).matchAll(/run: (.+)/g)) {
      assert.doesNotMatch(command, /\$\{\{/, `${file}: ${command}`);
    }
  }
});

test("every workflow and the action parse as YAML with the expected shape", () => {
  // Bun ships a YAML parser; Node does not.
  const script = `
const files = ${JSON.stringify([...fs.readdirSync(workflowsDir).map(file => path.join(workflowsDir, file)), path.join(kitRoot, "actions/setup-bun/action.yml")])};
const shapes = {};
for (const file of files) {
  const doc = Bun.YAML.parse(await Bun.file(file).text());
  shapes[file.split("/").pop()] = doc.runs ? { steps: doc.runs.steps.length } : { on: Object.keys(doc.on), jobs: Object.keys(doc.jobs) };
}
console.log(JSON.stringify(shapes));`;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const shapes = JSON.parse(result.stdout);
  assert.deepEqual(shapes["action.yml"], { steps: 3 });
  for (const file of reusable) assert.deepEqual(shapes[file].on, ["workflow_call"], file);
  assert.deepEqual(shapes["check.yml"].on, ["push", "pull_request", "workflow_dispatch"]);
});

test("the Storybook deploy reads the Cloudflare token from its environment, by name", () => {
  // The token is a secret of the storybook environment; a caller job cannot read it.
  const text = read(path.join(workflowsDir, "deploy-storybook.yml"));
  assert.match(text, /\n {4}environment:\n {6}name: \$\{\{ inputs\.environment \}\}/);
  assert.match(text, /STORYBOOK_CLOUDFLARE_API_TOKEN:\n {8}description: .*\n {8}required: false/);
  assert.equal(text.match(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.STORYBOOK_CLOUDFLARE_API_TOKEN \}\}/g)?.length, 2);
  assert.ok(text.indexOf("Require the environment's Cloudflare token") < text.indexOf("bun run storybook:deploy"));
  assert.match(read(path.join(kitRoot, "docs/reference.md")), /deploy-storybook\.yml@v[\d.]+\n(?: {4}.*\n)*? {4}secrets: inherit/);
});

test("the Storybook deploy follows release.gate: it runs whatever the checks concluded under local, only after they passed under ci", () => {
  const text = read(path.join(workflowsDir, "deploy-storybook.yml"));
  // The caller passes toJSON(needs); without it the caller's own needs order the deploy, as before.
  assert.match(text, /\n      needs:\n(?: {8}.*\n)*? {8}type: string\n {8}default: "\{\}"\n/);
  const gate = text.indexOf("- id: gate\n        run: node_modules/.bin/repo-kit ci-gate\n");
  assert.ok(gate > 0, "the gate step runs repo-kit ci-gate");
  assert.match(text, /REPO_KIT_NEEDS: \$\{\{ inputs\.needs \}\}\n/);
  assert.ok(gate > text.indexOf("uses: maxvyshniakov/repo-kit/actions/setup-bun@"), "it reads the installed kit's config");
  // Every step after the gate runs only when it says so.
  const after = text.slice(gate).split("\n      - ").slice(1);
  assert.ok(after.length >= 3, after.join("\n---\n"));
  for (const step of after) assert.match(step, /^if: steps\.gate\.outputs\.run == 'true'\n/, step);
  // The full workflow example moved from README to the reference; keep validating its gate semantics.
  const readme = read(path.join(kitRoot, "docs/reference.md"));
  assert.match(readme, /if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main'/);
  assert.match(readme, /needs: \$\{\{ toJSON\(needs\) \}\}/);
});

test("public pull requests never run repo-kit's untrusted checkout on a private runner", () => {
  const text = read(path.join(workflowsDir, "check.yml"));
  assert.match(text, /pull_request:/);
  assert.match(text, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(text, /runs-on:.*self-hosted/);
  assert.match(text, /persist-credentials: false/);
});

test("every reusable job states its token permissions and no workflow uses pull_request_target", () => {
  // A called job without permissions inherits whatever its caller granted.
  const expected = {
    "verify.yml": ["contents: read", "packages: read"],
    "browser.yml": ["contents: read", "packages: read"],
    "deploy-storybook.yml": ["contents: read", "packages: read"],
    "release.yml": ["contents: write", "packages: write"],
  };
  for (const [file, scopes] of Object.entries(expected)) {
    const text = read(path.join(workflowsDir, file));
    const block = text.match(/\n {4}permissions:\n((?: {6}.*\n)+)/);
    assert.ok(block, `${file}: the job declares permissions`);
    assert.deepEqual(block[1].trim().split("\n").map(line => line.trim()), scopes, file);
  }
  for (const file of fs.readdirSync(workflowsDir)) {
    assert.doesNotMatch(read(path.join(workflowsDir, file)), /pull_request_target/, file);
  }
});

const publicSelfHosted = "github.event.repository.visibility == 'public' && contains(inputs.runner, 'self-hosted')";

test("reusable workflows default to a GitHub-hosted runner and refuse a self-hosted one in a public repository", () => {
  for (const file of reusable) {
    const text = read(path.join(workflowsDir, file));
    // A public caller relying on the default must never reach a private runner.
    assert.match(text, /\n      runner:\n(?: {8}.*\n)*? {8}default: '\["ubuntu-latest"\]'\n/, `${file}: runner defaults to ubuntu-latest`);
    assert.doesNotMatch(text, /default: '\["self-hosted"/, file);
    // A public repository passing a self-hosted label lands on a GitHub-hosted runner and fails there.
    assert.ok(text.includes(`runs-on: \${{ ${publicSelfHosted} && fromJSON('["ubuntu-latest"]') || fromJSON(inputs.runner) }}`), `${file}: runs-on swaps a public self-hosted request`);
    const steps = text.slice(text.indexOf("\n    steps:\n"));
    const first = steps.split("\n      - ")[1];
    assert.match(first, /^name: Refuse a self-hosted runner in a public repository\n/, `${file}: the guard is the first step`);
    assert.ok(first.includes(`if: \${{ ${publicSelfHosted} }}`), file);
    assert.match(first, /exit 1/, file);
  }
});
