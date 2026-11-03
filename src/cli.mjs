#!/usr/bin/env node
// repo-kit <command> [args]; see README.md.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: repo-kit <command>
  verify [--release] [--browser]   the repository's gate (repo-kit.config.mjs verify)
  pre-push                         the pre-push hook: verify each pushed commit in a clean worktree
  heavy <slots|all> <command...>   run a command under a slotfather lease, when slotfather is installed
  checks                           run REPO_KIT_CHECKS' list of {name, run} in order, as browser.yml does
  hooks <install|sync|check|status>
  check                            managed hooks, workflow references and packageManager match the kit
  check-changelogs [--release]
  release [<package>:]<level> [--date=YYYY-MM-DD]
  release-gate [<ref>] [--rerun] [--no-attest]
                                   the local release gate on a commit (default HEAD); records its commit status
  release-gate --mode              print release.gate: local or ci
  ci-gate                          in a workflow: whether a job that needs the checks runs (REPO_KIT_NEEDS)
  publish [--resume]
  notify                           request publish.notify's workflows again
  tls                              the Bun TLS gate
  packed-consumer [--keep]`;

export async function main([command, ...args]) {
  if (command === "heavy") {
    const [slots, ...rest] = args;
    if (!slots || !rest.length) return usage();
    const { runLeased } = await import("./heavy.mjs");
    return runLeased(slots, rest[0] === "--" ? rest.slice(1) : rest);
  }
  if (command === "checks") {
    const { parseChecks, runChecks } = await import("./checks.mjs");
    return runChecks(parseChecks(process.env.REPO_KIT_CHECKS));
  }
  if (command === "tls") {
    const { runTlsGate } = await import("./tls.mjs");
    return runTlsGate() ? 0 : 1;
  }
  if (!command || command === "help" || command === "--help") return usage(0);

  const { loadConfig } = await import("./config.mjs");
  const config = await loadConfig();
  switch (command) {
    case "verify": {
      const browser = args.includes("--browser");
      const { leaseSelf, verifyLeaseSlots } = await import("./heavy.mjs");
      if (await leaseSelf(verifyLeaseSlots(browser ? config.verify.browserSlots : config.verify.slots))) return process.exitCode;
      const { runVerify } = await import("./verify.mjs");
      await runVerify(config, { release: args.includes("--release"), browser });
      return process.exitCode;
    }
    case "pre-push": {
      // Read the pushed refs first: a push with nothing left to verify (a tag,
      // a deletion, commits that passed already) takes no slot. The leased run
      // gets them on its stdin.
      const [{ leaseSelf }, { pushedCommits, reportPassed, runPrePush }] = await Promise.all([import("./heavy.mjs"), import("./pre-push.mjs")]);
      const stdin = fs.readFileSync(0, "utf8");
      const { passed, left } = pushedCommits(stdin);
      if (!left.length) return reportPassed(passed), 0;
      if (await leaseSelf(config.prePush.slots, { input: stdin })) return process.exitCode;
      return runPrePush({ stdin });
    }
    case "hooks": {
      const hooks = await import("./hooks.mjs");
      const [action] = args;
      if (action === "install") return hooks.installHooks(config.root), 0;
      if (action === "sync") return hooks.syncHooks(config.root), 0;
      if (action === "check" || action === "status") {
        const issues = action === "check" ? hooks.hookIssues(config.root) : hooks.hookStatus(config.root);
        return report(`Git hooks ${action}`, issues);
      }
      return usage();
    }
    case "check": {
      const { kitIssues } = await import("./check.mjs");
      return report("repo-kit check", kitIssues(config.root));
    }
    case "check-changelogs": {
      const { runCheckChangelogs } = await import("./check-changelogs.mjs");
      return runCheckChangelogs(config, { release: args.includes("--release") }) ? 0 : 1;
    }
    case "release": {
      const { runRelease } = await import("./release.mjs");
      return runRelease(config, args);
    }
    case "release-gate": {
      const { releaseGate, runReleaseGate } = await import("./release-gate.mjs");
      if (args.includes("--mode")) return console.log(releaseGate(config)), 0;
      return runReleaseGate(config, args);
    }
    case "ci-gate": {
      const { runCiGate } = await import("./release-gate.mjs");
      return runCiGate(config);
    }
    case "publish": {
      const { runPublish } = await import("./publish.mjs");
      return runPublish(config, { resume: args.includes("--resume") });
    }
    case "notify": {
      const [{ notifyAll }, { resolveToken }] = await Promise.all([import("./notify.mjs"), import("./token.mjs")]);
      return (await notifyAll(config.publish.notify, resolveToken().token)) ? 0 : 1;
    }
    case "packed-consumer": {
      const { runPackedConsumer } = await import("./packed-consumer.mjs");
      return (await runPackedConsumer(config, { keep: args.includes("--keep"), args })) ? 0 : 1;
    }
    default:
      return usage();
  }
}

function usage(code = 1) {
  (code ? console.error : console.log)(USAGE);
  return code;
}

function report(label, issues) {
  if (!issues.length) {
    console.log(`${label}: ok`);
    return 0;
  }
  console.error(`${label}:`);
  for (const issue of issues) console.error(`  ${issue}`);
  return 1;
}

// realpath: a bin reached through a symlink (node_modules/.bin, a linked
// package) runs from the file the link names.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main(process.argv.slice(2));
    // Not process.exit: piped output is written asynchronously.
    if (code !== undefined) process.exitCode = code;
  } catch (error) {
    console.error(`repo-kit: ${error.message}`);
    process.exitCode = 1;
  }
}
