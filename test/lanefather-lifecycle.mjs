// Local acceptance against the real installed Lanefather and a private Git/Store.
// No project lane records, remotes or installed commands are changed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { kitRoot, tempRepository } from './fixtures.mjs';
import { syncHooks } from '../src/hooks.mjs';

const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-kit-lifecycle-'));
let repo, server;
const run = (file, args, cwd, env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', data => { text += data; });
  child.stderr.on('data', data => { text += data; });
  child.on('error', reject);
  child.on('close', status => status === 0 ? resolve(text) : reject(new Error(`${file} ${args.join(' ')}: ${status}\n${text}`)));
});
try {
  await run('bun', ['pm', 'pack', '--destination', archive], kitRoot, process.env);
  const tar = fs.readFileSync(path.join(archive, fs.readdirSync(archive).find(name => name.endsWith('.tgz'))));
  server = http.createServer((request, response) => response.end(tar));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  repo = tempRepository({
    'package.json': { name: 'generic-lane-consumer', type: 'module', devDependencies: {
      '@maxvyshniakov/repo-kit': `http://127.0.0.1:${server.address().port}/repo-kit.tgz`,
    } },
    '.gitignore': 'node_modules/\n.claude/\n',
    'README.md': 'original fixture\n',
    '.lanefather.toml': `project="arbitrary-consumer"\nstate_dir=${JSON.stringify(path.join(archive, 'lanes'))}\n[checks]\nverify=".githooks/lane-check"\nslot_env="REPO_KIT_SLOT"\n`,
    'repo-kit.config.mjs': `export default {verify:{steps:[{name:'arbitrary command',command:['-e',"console.log('validated')"]}]}};`,
  }, { git: true });
  const env = { ...repo.env };
  for (const key of Object.keys(env)) if (/^(LANEFATHER_|STRAYLIGHT_)/.test(key)) delete env[key];
  env.LANEFATHER_CAP = '3'; env.LANEFATHER_LOAD15 = '0'; env.LANEFATHER_DISK_FREE_GB = '500';
  await run('bun', ['install'], repo.root, env);
  const saved = console.log;
  try { console.log = () => {}; syncHooks(repo.root); } finally { console.log = saved; }
  repo.git('add', '.'); repo.git('commit', '-qm', 'fixture adapter configured');
  const integration = path.join(repo.root, '.claude/worktrees/integration');
  repo.git('worktree', 'add', '-b', 'integrate/fixture', integration, 'HEAD');
  const output = await run('lanefather', ['start', 'fixture-adapter', '--ticket', 'none', '--base', 'integrate/fixture',
    '--claims', 'README.md', '--create'], repo.root, env);
  const state = path.join(archive, 'lanes');
  const recordFile = path.join(state, 'fixture-adapter.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.ok(output.includes('fixture-adapter'));
  fs.writeFileSync(path.join(record.worktree, 'README.md'), 'updated fixture\n');
  repo.git('-C', record.worktree, 'add', 'README.md');
  repo.git('-C', record.worktree, 'commit', '-qm', 'document fixture change');
  await run('lanefather', ['check', 'fixture-adapter', '--slots', '1'], record.worktree, env);
  const receipt = JSON.parse(fs.readFileSync(path.join(state, 'fixture-adapter.receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'green');
  assert.equal(receipt.check_results['verify:arbitrary%20command'].status, 'passed');
  fs.writeFileSync(path.join(integration, 'integration.md'), 'independent concurrent change\n');
  repo.git('-C', integration, 'add', 'integration.md');
  repo.git('-C', integration, 'commit', '-qm', 'concurrent integration work');
  await run('lanefather', ['land', 'fixture-adapter', '--slots', '1'], repo.root, env);
  const finished = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(finished.status, 'done');
  assert.equal(finished.post_merge.status, 'green');
  const post = JSON.parse(fs.readFileSync(finished.post_merge.receipt, 'utf8'));
  assert.equal(post.results[0].status, 'passed');
  assert.ok(post.results[0].report, 'a changed integration tree must actually rerun checks');
  assert.equal(fs.existsSync(record.worktree), false);
  assert.equal(finished.overrides.length, 0);
  console.log(JSON.stringify({ registration: 'real private Store', checks: receipt.check_results,
    post_merge: finished.post_merge.status, post_merge_reran_after_integration_change: true, review: 'actual documentation-only exemption',
    status: finished.status, force_used: false }, null, 2));
} finally {
  if (repo) repo.cleanup();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(archive, { recursive: true, force: true });
}
