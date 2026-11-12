#!/usr/bin/env node
// Lanefather's verification command contract over the consumer's Repo-Kit steps.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { readCapacity, runVerify, verifySteps } from './verify.mjs';
import { cleanEnvironment } from './pre-push.mjs';
import { leaseSelf, verifyLeaseSlots } from './heavy.mjs';

export function configuredChecks(config) {
  const suites = ['verify', ...(config.verify.browser ? ['browser'] : [])];
  return suites.flatMap(suite => verifySteps(config, { browser: suite === 'browser' }).map(step => ({
    id: `${suite}:${encodeURIComponent(step.name)}`, suite, step,
  })));
}

/**
 * The slots the run leases. Lanefather's --jobs is the lease it decided for this
 * run (its check contract: verify queues for its own --jobs-slot lease); the
 * configured slots of the selected suites cap it, and are the lease without it.
 */
export function laneLeaseSlots(config, selected, jobs = Infinity, { gibPerSlot = 0 } = {}) {
  const configured = Math.max(...selected.map(check => check.suite === 'browser' ? config.verify.browserSlots : config.verify.slots));
  // Where slotfather gives a slot memory, never fewer slots than the largest step's declared memory needs.
  const largest = Math.max(0, ...selected.map(check => check.step?.memory ?? 0));
  const floor = gibPerSlot > 0 ? Math.ceil(largest / gibPerSlot) : 0;
  return Math.min(configured, Math.max(jobs, floor));
}

export async function main(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, changed: { type: 'boolean' }, base: { type: 'string' }, plan: { type: 'boolean' },
    json: { type: 'boolean' }, checks: { type: 'string' }, suites: { type: 'string' },
    'keep-going': { type: 'boolean' }, jobs: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: repo-kit-lane --changed --base REF --plan --json\n       repo-kit-lane [--checks IDS | --suites SUITES] [--keep-going] [--jobs N]');
    return 0;
  }
  const gitEnv = cleanEnvironment();
  const config = await loadConfig();
  const checks = configuredChecks(config);
  if (!checks.length) throw new Error('the project config declares no checks');
  if (values.plan) {
    if (values.checks !== undefined || values.suites !== undefined) throw new Error('plan does not take a run selection');
    if (!values.changed || !values.base || !values.json) throw new Error('plan requires --changed --base REF --plan --json');
    const git = (...argv) => execFileSync('git', argv, { cwd: config.root, encoding: 'utf8', env: gitEnv });
    const base = git('rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`).trim();
    const paths = [...new Set([
      ...git('diff', '--name-only', '-z', base, '--').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ].filter(Boolean))].sort();
    const suites = [...new Set(checks.map(check => check.suite))];
    console.log(JSON.stringify({ v: 1, full: true, paths, unowned: [], suites,
      reasons: Object.fromEntries(suites.map(suite => [suite, ['All configured steps are checked.']])),
      checks: checks.map(({ id, suite }) => ({ id, suite, paths, producer: false })),
    }));
    return 0;
  }
  if (values.changed || values.base || values.json) throw new Error('plan flags require --plan');
  if (values.checks !== undefined && values.suites !== undefined) throw new Error('choose --checks or --suites');
  const jobs = values.jobs === undefined ? Infinity : Number(values.jobs);
  if (values.jobs !== undefined && !(Number.isSafeInteger(jobs) && jobs > 0)) throw new Error('--jobs must be a positive integer');
  const byId = new Map(checks.map(check => [check.id, check]));
  let selected = checks;
  if (values.checks !== undefined) {
    const ids = values.checks.split(',');
    if (ids.some(id => !byId.has(id))) throw new Error('unknown check selection');
    const wanted = new Set();
    const include = id => {
      if (wanted.has(id)) return;
      wanted.add(id);
      const check = byId.get(id);
      for (const name of check.step.needs) include(`${check.suite}:${encodeURIComponent(name)}`);
    };
    ids.forEach(include);
    selected = checks.filter(check => wanted.has(check.id));
  } else if (values.suites !== undefined) {
    const suites = values.suites.split(',');
    const known = new Set(checks.map(check => check.suite));
    if (suites.some(suite => !known.has(suite))) throw new Error('unknown suite selection');
    selected = checks.filter(check => suites.includes(check.suite));
  }
  if (!selected.length) throw new Error('no configured checks selected');
  // The label names the lane (REPO_KIT_SLOT_LABEL, from Lanefather) and the phase, e.g. "lane-sk-api-surfaces check".
  let phase = 'check';
  try { phase = JSON.parse(gitEnv.REPO_KIT_SLOT_META || '{}').phase || phase; } catch { /* leasedCommand reports bad metadata */ }
  const lease = Number.isFinite(jobs) && !gitEnv.SLOTFATHER_LEASE ? laneLeaseSlots(config, selected, jobs, { gibPerSlot: readCapacity().gib_per_slot ?? 0 }) : laneLeaseSlots(config, selected, jobs);
  if (await leaseSelf(verifyLeaseSlots(lease), { env: gitEnv, purpose: phase })) return process.exitCode;
  const git = (...argv) => execFileSync('git', argv, { cwd: config.root, encoding: 'utf8', env: gitEnv }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  if (git('status', '--porcelain')) throw new Error('verification requires a clean committed checkout');
  const directory = path.resolve(config.root, git('rev-parse', '--git-path', 'repo-kit-verification'));
  fs.mkdirSync(directory, { recursive: true });
  const run = fs.mkdtempSync(path.join(directory, 'run-'));
  const logs = new Map(selected.map((check, index) => {
    const log = path.join(run, `${index}.log`);
    fs.writeFileSync(log, '');
    return [check.id, log];
  }));
  const normalIds = selected.filter(check => check.suite === 'verify').map(check => check.id);
  const steps = selected.map(({ id, suite, step }) => ({ ...step, name: id,
    needs: [...step.needs.map(name => `${suite}:${encodeURIComponent(name)}`),
      ...(suite === 'browser' ? normalIds : [])],
  }));
  const result = await runVerify(config, { steps, maxCores: jobs, env: gitEnv, keepGoing: Boolean(values['keep-going']),
    onLine: (step, text) => fs.appendFileSync(logs.get(step.name), text + '\n'),
  });
  const environment = git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')
    ? { class: 'inputs-changed', message: 'verification changed committed inputs' } : null;
  const byName = new Map(result.results.map(row => [row.name, row]));
  const report = { v: 1, head, tree, exit: environment ? 1 : result.exit, environment,
    interrupted: result.interrupted,
    checks: steps.map(step => {
      const row = byName.get(step.name);
      const blockedBy = row ? [] : step.needs.filter(id => byName.get(id)?.status !== 'ok');
      return { id: step.name, suite: byId.get(step.name).suite,
        status: environment ? 'void' : row ? { ok: 'passed', fail: 'failed', stopped: 'cancelled' }[row.status] : (!result.interrupted && blockedBy.length ? 'blocked' : 'cancelled'),
        seconds: row?.seconds ?? 0, timed_out: Boolean(row?.timedOut), log: logs.get(step.name),
        blocked_by: blockedBy,
      };
    }),
  };
  const file = path.join(run, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`Verification report: ${file}`);
  return report.exit;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`repo-kit-lane: ${error.message}`); process.exitCode = 1; }
}
