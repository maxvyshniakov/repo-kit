// Compares hooks/reference-transaction with its canonical copy in a Straylight
// checkout (STRAYLIGHT_DIR, default ~/straylight; tools/agent-hooks). Its
// canonical home moves to lanefather; until then repo-kit carries this copy.
// Without a checkout, as on CI, there is nothing to compare: the pinned hash in
// src/hooks.mjs still guards the copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const copy = fileURLToPath(new URL("../hooks/reference-transaction", import.meta.url));
const upstream = path.join(process.env.STRAYLIGHT_DIR ?? path.join(os.homedir(), "straylight"), "tools/agent-hooks/reference-transaction");

if (!fs.existsSync(upstream)) {
  console.log(`check:upstream: no ${upstream}; skipped`);
} else if (fs.readFileSync(upstream).equals(fs.readFileSync(copy))) {
  console.log(`check:upstream: hooks/reference-transaction matches ${upstream}`);
} else {
  console.error(`check:upstream: hooks/reference-transaction differs from ${upstream}.`);
  console.error("Copy it, update REFERENCE_TRANSACTION_SHA256 in src/hooks.mjs and release repo-kit.");
  process.exitCode = 1;
}
