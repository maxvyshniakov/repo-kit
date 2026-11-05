import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { kitRoot, tempRepository } from "./fixtures.mjs";

const hook = fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"));

function compare({ canonical, legacy }) {
  const files = { "legacy/tools/agent-hooks/reference-transaction": legacy };
  if (canonical !== undefined) files["lanefather/hooks/reference-transaction"] = canonical;
  const fixture = tempRepository(files);
  try {
    return spawnSync(process.execPath, [path.join(kitRoot, "scripts/check-upstream.mjs")], {
      encoding: "utf8",
      env: { ...process.env, LANEFATHER_DIR: path.join(fixture.root, "lanefather"),
        STRAYLIGHT_DIR: path.join(fixture.root, "legacy") },
    });
  } finally {
    fixture.cleanup();
  }
}

test("the upstream check accepts the canonical Lanefather hook independently of a stale Straylight copy", () => {
  const result = compare({ canonical: hook.toString(), legacy: "stale project copy\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches .*lanefather[/\\]hooks[/\\]reference-transaction/);
});

test("a mismatched canonical hook fails even when the legacy Straylight copy matches", () => {
  const result = compare({ canonical: "changed canonical hook\n", legacy: hook.toString() });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /differs from .*lanefather[/\\]hooks[/\\]reference-transaction/);
  assert.match(result.stderr, /REFERENCE_TRANSACTION_SHA256/);
});

test("a missing canonical checkout is reported as unrun comparison, not a legacy fallback or a mismatch", () => {
  const result = compare({ legacy: "stale project copy\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no .*lanefather[/\\]hooks[/\\]reference-transaction; skipped/);
  assert.equal(result.stderr, "");
});
