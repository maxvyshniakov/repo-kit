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

test("repo-kit's own checks use the action from their own commit and run verify --release", () => {
  const text = read(path.join(workflowsDir, "check.yml"));
  assert.match(text, /- uses: \.\/actions\/setup-bun\n/);
  assert.match(text, /- run: bun run verify -- --release\n/);
  assert.match(text, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.match(text, /workflow_dispatch:/);
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
  assert.match(read(path.join(kitRoot, "README.md")), /deploy-storybook\.yml@v[\d.]+\n(?: {4}.*\n)*? {4}secrets: inherit/);
});
