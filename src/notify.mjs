// Requests another repository's workflow after a release, such as Data Grid's
// catalog dependency workflow, which adopts a new Sid-Kit, Inline Measure or
// Text Truncate when every check passes. Reuses the publishing token locally; no
// cross-repository PAT is stored in CI.
//
//   publish: { notify: [{ repository: "maxvyshniakov/data-grid", workflow: "update-catalog-dependencies.yml", ref: "main" }] }

export function dispatchUrl({ repository, workflow }) {
  return `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;
}

/** Resolves to whether GitHub accepted the request; a failure only warns. */
export async function notify(target, token, fetcher = fetch) {
  const label = `${target.repository} ${target.workflow}`;
  try {
    if (!token) throw new Error("GITHUB_TOKEN is missing");
    const response = await fetcher(dispatchUrl(target), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: target.ref ?? "main" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    console.log(`Requested ${label}.`);
    return true;
  } catch (error) {
    // Publication already succeeded. Do not retry an immutable package release:
    // the target's own schedule is the fallback.
    console.warn(`Requesting ${label} failed: ${error.message}. Run again with: bun run repo-kit notify`);
    return false;
  }
}

export async function notifyAll(targets, token, fetcher = fetch) {
  let all = true;
  for (const target of targets) all = (await notify(target, token, fetcher)) && all;
  return all;
}
