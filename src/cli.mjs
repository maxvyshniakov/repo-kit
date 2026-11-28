#!/usr/bin/env node
// package-kit <command> [args]; see README.md.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: package-kit <command>
  verify [--release] [--browser] [--changed] [--base REF] [--plan] [--json] [--no-reuse] [--keep-going]
                                   the repository's gate (package-kit.config.mjs verify)
  pre-push                         the pre-push hook: verify each pushed commit in a clean worktree
  heavy <slots|all> <command...>   run a command under a slotfather lease, when slotfather is installed
  shoot <story id filter...> [<storybook url>|--url=] [--theme=light,dark] [--width=1280,375]
        [--browser=chromium,firefox,webkit,safari] [--out=<dir>] [--viewport]
                                   screenshot Storybook stories, under a lease of shoot.slots
  serve <dir> [--port N] [--host 127.0.0.1]
                                   HTTP/1.1 Keep-Alive static preview server
  checks                           run PACKAGE_KIT_CHECKS' list of {name, run} in order, as browser.yml does
  verified-tree                    in a workflow: link each PACKAGE_KIT_PLANS plan to a passed result of this tree
  test-hygiene [--init|--update] [--base REF] [--warn-lowered]
                                   shrink-only test rules: fixed sleeps, timing assertions, UI/CSS/DOM/console/mock rules
  file-budget [--staged] [--all] [--init|--update] [--json]
                                   per-glob file-size budgets (lines or bytes) and a shrink-only allowlist
  hooks <install|sync|check|status>
  check [file-budget]              managed hooks, workflow references and packageManager match the kit
  check-changelogs [--release]
  check-changelog-entries <base>..<head>
                                   each commit changing changelog.paths adds an Unreleased line or says "Changelog: none"
  commit-msg <message file>        the commit-msg hook: the same check on the commit being made
  release [<package>:]<level> [--date=YYYY-MM-DD]
  release-gate [<ref>] [--rerun] [--no-attest]
                                   the local release gate on a commit (default HEAD); records its commit status
  release-gate --mode              print release.gate: local or ci
  ci-gate                          in a workflow: whether a job that needs the checks runs (PACKAGE_KIT_NEEDS)
  publish [--resume]
  publish --prerelease <preid> --dist-tag <tag> [--ref <ref>] [--dry-run]
  notify                           request publish.notify's workflows again
  friction <log|report|export>     deprecated: the local agent friction journal, moving to mastack
  packed-consumer [--keep]`;

// Commands 0.10.0 removed: each exits 1 with what to do instead.
export const REMOVED_COMMANDS = {
  tls: "package-kit tls was removed in 0.10.0: Bun 1.4.4, the floor package-kit and its setup-bun action require, already rejects the eMudhra chains. Delete the security:tls script.",
  adopt: "package-kit adopt was removed in 0.10.0: bump @maxvyshniakov/* pins by hand, or with bun update.",
  rust: "package-kit rust was removed in 0.10.0: package-kit covers Bun JavaScript and TypeScript packages only. Run cargo directly.",
};

export const FRICTION_DEPRECATION = "package-kit friction is deprecated and moves to mastack's friction command; it will be removed in a later release.";

export async function main([command, ...args]) {
  if (Object.keys(process.env).some(name => name.startsWith("REPO_KIT_"))) {
    const { legacyEnvironmentWarnings } = await import("./config.mjs");
    for (const warning of legacyEnvironmentWarnings()) console.error(warning);
  }
  if (Object.hasOwn(REMOVED_COMMANDS, command)) {
    console.error(REMOVED_COMMANDS[command]);
    return 1;
  }
  if (command === "heavy") {
    const [slots, ...rest] = args;
    if (!slots || !rest.length) return usage();
    const { runLeased } = await import("./slotfather.mjs");
    return runLeased(slots, rest[0] === "--" ? rest.slice(1) : rest);
  }
  if (command === "checks") {
    const { parseChecks, runChecks } = await import("./checks.mjs");
    return runChecks(parseChecks(process.env.PACKAGE_KIT_CHECKS));
  }
  if (command === "verified-tree") {
    const { runVerifiedTree } = await import("./verified-tree.mjs");
    return runVerifiedTree();
  }
  if (command === "test-hygiene") {
    // A repository without package-kit.config.mjs (a Python one, say) gets the defaults.
    const [{ findRoot, loadConfig, LegacyConfigError }, { runTestHygiene }] = await Promise.all([import("./config.mjs"), import("./test-hygiene.mjs")]);
    let root = null;
    try {
      root = findRoot();
    } catch (error) {
      if (error instanceof LegacyConfigError) throw error;
      // No package-kit.config.mjs: the repository's defaults. A broken config still fails below.
    }
    let config;
    if (root) config = await loadConfig(root);
    else {
      const { execFileSync } = await import("node:child_process");
      config = { root: execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() };
    }
    return runTestHygiene({ root: config.root, config, args });
  }
  if (command === "file-budget" || (command === "check" && args[0] === "file-budget")) {
    const budgetArgs = command === "check" ? args.slice(1) : args;
    const [{ findRoot, loadConfig, LegacyConfigError }, { runFileBudget }] = await Promise.all([import("./config.mjs"), import("./file-budget.mjs")]);
    let root = null;
    try {
      root = findRoot();
    } catch (error) {
      if (error instanceof LegacyConfigError) throw error;
      // No package-kit.config.mjs: resolve the Git top-level directory.
    }
    let config;
    if (root) config = await loadConfig(root);
    else {
      const { execFileSync } = await import("node:child_process");
      config = { root: execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() };
    }
    return runFileBudget({ root: config.root, config, args: budgetArgs });
  }
  if (command === "friction") {
    // stderr only: `friction report --json` and `friction export` output may be piped.
    console.error(FRICTION_DEPRECATION);
    const { runFriction } = await import("./friction.mjs");
    return runFriction(args);
  }
  if (command === "serve") {
    const { runServe } = await import("./serve.mjs");
    return runServe(args);
  }
  if (!command || command === "help" || command === "--help") return usage(0);

  const { loadConfig } = await import("./config.mjs");
  const config = await loadConfig();
  switch (command) {
    case "verify": {
      const { parseArgs } = await import("node:util");
      const { values } = parseArgs({
        args,
        options: {
          release: { type: "boolean", default: false },
          browser: { type: "boolean", default: false },
          changed: { type: "boolean", default: false },
          base: { type: "string" },
          plan: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          "no-reuse": { type: "boolean", default: false },
          "keep-going": { type: "boolean", default: false },
        },
      });
      if (values.json && !values.plan) throw new Error("verify: --json requires --plan");
      if (values.plan && !values.changed) throw new Error("verify: --plan requires --changed");
      if (values.base !== undefined && !values.changed) throw new Error("verify: --base requires --changed");
      if (!values.plan) {
        const { leaseSelf, verifyLeaseSlots } = await import("./slotfather.mjs");
        if (await leaseSelf(verifyLeaseSlots(values.browser ? config.verify.browserSlots : config.verify.slots), { purpose: values.browser ? "verify browser" : "verify" })) return process.exitCode;
      }
      const { runVerify } = await import("./verify.mjs");
      await runVerify(config, {
        release: values.release,
        browser: values.browser,
        changed: values.changed,
        base: values.base,
        plan: values.plan,
        json: values.json,
        reuse: !values["no-reuse"],
        keepGoing: values["keep-going"],
      });
      return process.exitCode;
    }
    case "shoot": {
      const [{ leaseSelf }, { parseShootArgs, runShoot }] = await Promise.all([import("./slotfather.mjs"), import("./shoot.mjs")]);
      // Bad arguments fail before the lease, not after a wait for it.
      parseShootArgs(args, { root: config.root, shoot: config.shoot });
      if (await leaseSelf(config.shoot.slots, { purpose: "shoot" })) return process.exitCode;
      return runShoot(config, args);
    }
    case "pre-push": {
      // Read the pushed refs first: a push with nothing left to verify (a tag,
      // a deletion, commits that passed already) takes no slot. The leased run
      // gets them on its stdin.
      const [{ leaseSelf }, { pushedCommits, reportPassed, runPrePush }] = await Promise.all([import("./slotfather.mjs"), import("./pre-push.mjs")]);
      const stdin = fs.readFileSync(0, "utf8");
      const { passed, left } = pushedCommits(stdin, undefined, config.prePush.releaseBranches);
      if (!left.length) return reportPassed(passed), 0;
      if (await leaseSelf(config.prePush.slots, { input: stdin, purpose: "pre-push" })) return process.exitCode;
      return runPrePush({ stdin, releaseBranches: config.prePush.releaseBranches });
    }
    case "hooks": {
      const hooks = await import("./hooks.mjs");
      const [action] = args;
      if (action === "install") return hooks.installHooks(config.root), 0;
      if (action === "sync") return hooks.syncHooks(config.root, config), 0;
      if (action === "check" || action === "status") {
        const issues = action === "check" ? hooks.hookIssues(config.root, config) : hooks.hookStatus(config.root);
        return report(`Git hooks ${action}`, issues);
      }
      return usage();
    }
    case "check": {
      const { kitIssues } = await import("./check.mjs");
      return report("package-kit check", kitIssues(config.root, config));
    }
    case "check-changelogs": {
      const { runCheckChangelogs } = await import("./check-changelogs.mjs");
      return runCheckChangelogs(config, { release: args.includes("--release") }) ? 0 : 1;
    }
    case "check-changelog-entries": {
      const { runCheckChangelogEntries } = await import("./changelog-entries.mjs");
      return runCheckChangelogEntries(config, args);
    }
    case "commit-msg": {
      const { runCommitMsg } = await import("./changelog-entries.mjs");
      return runCommitMsg(config, args);
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
      const { parsePublishArgs, runPrerelease, runPublish } = await import("./publish.mjs");
      const options = parsePublishArgs(args);
      if (options.mode === "prerelease") return runPrerelease(config, options);
      return runPublish(config, { resume: options.resume });
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
    console.error(`package-kit: ${error.message}`);
    process.exitCode = 1;
  }
}
