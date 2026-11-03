import assert from "node:assert/strict";
import test from "node:test";

import { entrySpecifiers, exportTargets, pinnedVersions, runtimeTarget, tarballIssues } from "../src/packed-consumer.mjs";

const manifest = {
  name: "@maxvyshniakov/example",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./multiline": { types: "./dist/multiline.d.ts", import: "./dist/multiline.js" },
    "./styles.css": "./dist/styles.css",
    "./package.json": "./package.json",
  },
};

test("export targets and entrypoints come from the manifest's exports", () => {
  assert.deepEqual(exportTargets(manifest.exports["."]), ["./dist/index.d.ts", "./dist/index.js"]);
  assert.equal(runtimeTarget(manifest.exports["."]), "./dist/index.js");
  assert.equal(runtimeTarget({ default: "./x.js" }), "./x.js");
  assert.deepEqual(entrySpecifiers(manifest), ["@maxvyshniakov/example", "@maxvyshniakov/example/multiline"]);
});

test("a tarball that misses an export target, ships tests or keeps workspace ranges fails", () => {
  const files = new Set(["dist/index.d.ts", "dist/index.js", "dist/multiline.d.ts", "dist/multiline.js", "dist/styles.css", "package.json"]);
  const packedManifest = { name: manifest.name, peerDependencies: { react: "^19.0.0" } };
  assert.deepEqual(tarballIssues({ manifest, packedManifest, files }), []);
  const missing = new Set([...files].filter(file => file !== "dist/multiline.js"));
  assert.match(tarballIssues({ manifest, packedManifest, files: missing }).join("\n"), /export "\.\/multiline" points at \.\/dist\/multiline\.js, which is not in the tarball/);
  const tests = new Set([...files, "dist/__tests__/a.js", "dist/fixtures/b.json", "dist/a.stories.js"]);
  assert.match(tarballIssues({ manifest, packedManifest, files: tests }).join("\n"), /ships test files: dist\/__tests__\/a\.js, dist\/fixtures\/b\.json, dist\/a\.stories\.js/);
  assert.match(tarballIssues({ manifest, packedManifest: { dependencies: { a: "workspace:*" } }, files }).join("\n"), /dependencies\.a is workspace:\* in the tarball/);
  assert.match(tarballIssues({ manifest, packedManifest: { private: true }, files }).join("\n"), /private and cannot be published/);
});

test("consumer packages take the first exact pin in the repository's manifests, else the declared range", () => {
  const pinned = pinnedVersions([
    { devDependencies: { vite: "^8.0.0", react: "19.2.8", "react-dom": "^19.3.0", self: "workspace:*" } },
    { dependencies: { vite: "8.3.2" } },
  ]);
  assert.equal(pinned("react"), "19.2.8");
  assert.equal(pinned("vite"), "8.3.2", "an exact pin wins over an earlier range");
  // Text Truncate's React peers are ^ ranges in devDependencies, as its own check accepted.
  assert.equal(pinned("react-dom"), "^19.3.0");
  assert.throws(() => pinned("self"), /No version of self is declared/);
  assert.throws(() => pinned("typescript"), /No version of typescript is declared/);
});
