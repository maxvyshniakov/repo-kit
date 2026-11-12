// perfBudget(holds, message): a test's performance budget (latency, frames,
// allocations). It holds only in the perf suite, which runs alone on a quiet
// machine and sets REPO_KIT_PERF_BUDGETS=enforce; elsewhere a missed budget is
// reported and the test goes on, because a loaded machine misses budgets that
// are fine. `repo-kit test-hygiene` fails a raw timing assertion outside the
// perf suite and a file calling this helper that the perf suite does not run.
//
//   import { perfBudget } from "@maxvyshniakov/repo-kit/perf-budget";
//   perfBudget(elapsed < 16, `render took ${elapsed} ms, budget 16 ms`);
import { AssertionError } from "node:assert";

export function perfBudget(holds, message, { env = process.env, warn = console.warn } = {}) {
  if (holds) return;
  if (env.REPO_KIT_PERF_BUDGETS === "enforce") throw new AssertionError({ message: `perf budget missed: ${message}` });
  warn(`perf budget missed (not enforced outside the perf suite): ${message}`);
}
