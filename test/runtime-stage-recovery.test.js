import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, BUDGET } from './helpers.js';
import { patchFrontmatter, readCard } from '../src/board.js';
import { refreshWorktreeBase } from '../src/git.js';
import { remoteCiStatus } from '../src/remote-ci-status.js';
import { readPriorRuns } from '../src/runstore.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';

function setup() {
  isolateHome(); scheduler.resetState(); pipeline.init({ broadcast: () => {} });
  const repo = makeRepo(), dir = tmp('stage-recovery');
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('verify_command: node --version', 'verify_command: node -e "process.exit(1)"'));
  const project = { name: path.basename(repo), path: repo };
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  writeCard(repo, 'task-0001', { status: 'Planned' });
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed card']);
  return { repo, dir, project, wt };
}
async function candidate(f, extra = {}) {
  git(f.repo, ['worktree', 'add', '-b', 'todomd/task-0001', f.wt]);
  fs.writeFileSync(path.join(f.wt, 'candidate.txt'), 'candidate\n');
  git(f.wt, ['add', 'candidate.txt']); git(f.wt, ['commit', '-qm', 'candidate']);
  await patchFrontmatter(f.repo, 'task-0001', { status: 'Needs Human', needs_human_reason: 'ci_failed',
    recovery_stage: 'CI', worktree: 'todomd/task-0001', base_branch: 'main',
    verification: { attempts: 2, max_attempts: 3, last_verdict: '' }, ...extra });
  return git(f.wt, ['rev-parse', 'HEAD']);
}
async function cleanup(f) {
  pipeline.forgetProject(f.project.name); await pipeline.killAllChildren({ graceMs: 100 });
  clearFakeAgent(); scheduler.resetState();
}
const parked = f => readCard(f.repo, 'task-0001').data.status === 'Needs Human' && !pipeline.hasLiveRun(f.project.name, 'task-0001');

for (const kind of ['clean', 'conflict', 'dirty']) {
  test(`Build base refresh: ${kind} candidate preserves work and spends no attempt on a conflict`, async () => {
    const f = setup();
    const calls = path.join(f.dir, 'agents'); useFakeAgent({ build: 'noop', argv_log: calls });
    const head = await candidate(f, { recovery_stage: '', status: 'Queue' });
    fs.writeFileSync(path.join(f.repo, kind === 'conflict' ? 'candidate.txt' : 'registry.txt'), 'base addition\n');
    git(f.repo, ['add', '-A']); git(f.repo, ['commit', '-qm', 'advance base']);
    const base = git(f.repo, ['rev-parse', 'HEAD']);
    if (kind === 'dirty') fs.appendFileSync(path.join(f.wt, 'candidate.txt'), 'uncommitted\n');
    try {
      pipeline.kickQueue(f.project);
      await until(() => parked(f), { timeout: BUDGET.chain });
      const card = readCard(f.repo, 'task-0001');
      if (kind === 'clean') {
        assert.equal(git(f.wt, ['merge-base', '--is-ancestor', base, 'HEAD']), '');
        assert.equal(fs.readFileSync(path.join(f.wt, 'registry.txt'), 'utf8'), 'base addition\n');
        assert.equal(card.data.verification.attempts, 3);
        assert.ok(fs.existsSync(calls));
      } else {
        assert.equal(card.data.needs_human_reason, kind === 'dirty' ? 'base_sync_dirty' : 'base_sync_conflict');
        assert.equal(card.data.verification.attempts, 2);
        assert.equal(fs.existsSync(calls), false);
        assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
        assert.equal(fs.readFileSync(path.join(f.wt, 'candidate.txt'), 'utf8'), kind === 'dirty' ? 'candidate\nuncommitted\n' : 'candidate\n');
        assert.doesNotMatch(git(f.wt, ['status', '--porcelain']), /^UU/m);
      }
    } finally { await cleanup(f); }
  });
}

test('board-only base updates do not churn source or overwrite dirty candidate work', async () => {
  const f = setup(); await candidate(f);
  fs.appendFileSync(path.join(f.wt, 'candidate.txt'), 'pending\n');
  git(f.repo, ['add', '.todomd']); git(f.repo, ['commit', '-qm', 'board bookkeeping']);
  const head = git(f.wt, ['rev-parse', 'HEAD']);
  try {
    assert.deepEqual(await refreshWorktreeBase(f.wt, 'todomd/task-0001', 'main'), { ok: true, changed: false });
    assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
  } finally { await cleanup(f); }
});

for (const route of ['human', 'persisted']) {
  test(`${route} re-queue honours CI recovery without modifying source or increasing attempts`, async () => {
    const f = setup(); const calls = path.join(f.dir, 'agents'); useFakeAgent({ argv_log: calls });
    const cfg = path.join(f.repo, '.todomd/config.yml');
    fs.appendFileSync(cfg, 'ci:\n  execution: remote\n');
    git(f.repo, ['add', cfg]); git(f.repo, ['commit', '-qm', 'remote gate']);
    const head = await candidate(f, { status: route === 'persisted' ? 'Queue' : 'Needs Human',
      needs_human_reason: route === 'persisted' ? '' : 'ci_failed' });
    // The fixture verifier exits nonzero; it must park this same attempt.
    try {
      if (route === 'human') assert.equal((await pipeline.humanMove(f.project, 'task-0001', 'Queue')).ok, true);
      else pipeline.kickQueue(f.project);
      await until(() => parked(f), { timeout: BUDGET.chain });
      assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, 2);
      assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.existsSync(calls), false, 'no Build or Verify agent runs after failed CI');
    } finally { await cleanup(f); }
  });
}

for (const attempts of [3, 6]) {
  test(`Build refuses persisted attempt ${attempts} at a cap of three`, async () => {
    const f = setup(); const calls = path.join(f.dir, 'agents'); useFakeAgent({ argv_log: calls });
    const head = await candidate(f, { status: 'Queue', recovery_stage: '', verification: { attempts, max_attempts: 3 } });
    try {
      pipeline.kickQueue(f.project); await until(() => parked(f), { timeout: BUDGET.stage });
      assert.equal(readCard(f.repo, 'task-0001').data.needs_human_reason, 'attempts_exhausted');
      assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, attempts, 'historical count is preserved');
      assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.existsSync(calls), false);
      assert.equal((await pipeline.humanMove(f.project, 'task-0001', 'Queue')).ok, false,
        'ordinary re-queue cannot silently extend an exhausted budget');
      assert.equal(readCard(f.repo, 'task-0001').data.verification.max_attempts, 3);
    } finally { await cleanup(f); }
  });
}

test('structured remote status requires one candidate-bound receipt and a run ID for terminal/live jobs', () => {
  const head = 'a'.repeat(40);
  const format = value => 'TODOMD_CI_STATUS ' + JSON.stringify({ head, ...value });
  assert.equal(remoteCiStatus(format({ state: 'running', run_id: 'test-run' }), head).state, 'running');
  assert.equal(remoteCiStatus(format({ state: 'passed' }), head), null);
  assert.equal(remoteCiStatus(format({ state: 'passed', run_id: 'test-run', head: 'b'.repeat(40) }), head), null);
  assert.equal(remoteCiStatus(format({ state: 'blocked', reason: 'guess' }), head), null);
  assert.equal(remoteCiStatus(format({ state: 'running', run_id: 'test-run' }) + '\n' + format({ state: 'passed', run_id: 'test-run' }), head), null);
});

for (const interruption of ['disconnect', 'timeout', 'cancel']) {
  test(`remote ${interruption} reconciles the running job without a second submission or repair`, async () => {
    const f = setup(); const calls = path.join(f.dir, 'agents'); useFakeAgent({ build: 'good', verdict: 'pass', argv_log: calls });
    const cfg = path.join(f.repo, '.todomd/config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('Build, Verify', 'Build, CI, Verify') +
      'ci:\n  execution: remote\n  quick: node adapter.mjs\n  status_command: node status.mjs\n  poll_seconds: 1\n  timeout_seconds: 1\n');
    fs.writeFileSync(path.join(f.repo, 'adapter.mjs'), `import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(path.join(f.dir, 'submits'))}, 'submit\\n');
      ${interruption === 'timeout' ? 'setInterval(() => {}, 100);' : 'process.exit(2);'}`);
    fs.writeFileSync(path.join(f.repo, 'status.mjs'), `import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(path.join(f.dir, 'polls'))}, process.env.TODOMD_CI_MODE + '\\n');
      console.log('TODOMD_CI_STATUS ' + JSON.stringify({ head: process.env.TODOMD_CI_HEAD,
        run_id: 'test-run', state: fs.existsSync(${JSON.stringify(path.join(f.dir, 'done'))}) ? 'passed' : 'running' }));`);
    git(f.repo, ['add', '-A']); git(f.repo, ['commit', '-qm', 'status-only adapter fixture']);
    try {
      await pipeline.humanMove(f.project, 'task-0001', 'Queue');
      await until(() => readCard(f.repo, 'task-0001').data.ci_remote?.state === 'running', { timeout: BUDGET.chain });
      const head = git(f.wt, ['rev-parse', 'HEAD']);
      assert.equal(readCard(f.repo, 'task-0001').data.status, 'CI');
      assert.equal(pipeline.hasLiveRun(f.project.name, 'task-0001'), true);
      assert.ok(readPriorRuns().some(run => run.project === f.project.name && run.card === 'task-0001' && run.stage === 'CI'),
        'remote waiting remains visible in durable live-run metadata between status probes');
      assert.equal((await pipeline.retryVerification(f.project, 'task-0001')).ok, false);
      assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, 1);
      if (interruption === 'cancel') {
        await until(() => readPriorRuns().some(run => run.project === f.project.name && run.remote && run.pid === null));
        assert.equal((await pipeline.cancel(f.project, 'task-0001')).ok, true);
        await until(() => parked(f), { timeout: BUDGET.stage });
        assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
        assert.equal(fs.readFileSync(path.join(f.dir, 'submits'), 'utf8'), 'submit\n');
        assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, 1);
        return;
      }
      fs.writeFileSync(path.join(f.dir, 'done'), 'done');
      await until(() => readCard(f.repo, 'task-0001').data.status === 'Done' && !pipeline.hasLiveRun(f.project.name, 'task-0001'), { timeout: BUDGET.chain });
      assert.equal(fs.readFileSync(path.join(f.dir, 'submits'), 'utf8'), 'submit\n');
      assert.ok(fs.readFileSync(path.join(f.dir, 'polls'), 'utf8').split('\n').filter(Boolean).every(mode => mode === 'status'));
      const card = readCard(f.repo, 'task-0001');
      assert.equal(card.data.ci_evidence.head, head);
      assert.equal(card.data.verification.attempts, 1);
      assert.doesNotMatch(card.raw, /ci_blocked|Build attempt 2/);
    } finally { await cleanup(f); }
  });
}

for (const reason of ['approval_required', 'approval_stale', 'admission_contention']) {
  test(`remote ${reason} has actionable metadata and never spends another candidate attempt`, async () => {
    const f = setup(); useFakeAgent({ build: 'good' });
    const cfg = path.join(f.repo, '.todomd/config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('Build, Verify', 'Build, CI, Verify') +
      'ci:\n  execution: remote\n  quick: node adapter.mjs\n');
    fs.writeFileSync(path.join(f.repo, 'adapter.mjs'), `console.log('TODOMD_CI_STATUS ' + JSON.stringify({
      head: process.env.TODOMD_CI_HEAD, state: 'blocked', reason: ${JSON.stringify(reason)} })); process.exit(2);`);
    git(f.repo, ['add', '-A']); git(f.repo, ['commit', '-qm', 'blocked adapter fixture']);
    try {
      await pipeline.humanMove(f.project, 'task-0001', 'Queue'); await until(() => parked(f), { timeout: BUDGET.chain });
      const head = git(f.wt, ['rev-parse', 'HEAD']);
      assert.equal(readCard(f.repo, 'task-0001').data.ci_remote.reason, reason);
      await pipeline.humanMove(f.project, 'task-0001', 'Queue'); await until(() => parked(f), { timeout: BUDGET.chain });
      assert.equal(git(f.wt, ['rev-parse', 'HEAD']), head);
      assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, 1);
    } finally { await cleanup(f); }
  });
}

test('Build receives the latest uncommitted board instructions, excluding old run history', async () => {
  const f = setup(); const calls = path.join(f.dir, 'agents'); useFakeAgent({ build: 'noop', argv_log: calls });
  await candidate(f, { status: 'Queue', recovery_stage: '' });
  const file = path.join(f.repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Run Log', '## Coordinator note\n\nKeep the permission revoked.\n\n## Run Log\n\nOld diagnostic noise.'));
  try {
    pipeline.kickQueue(f.project); await until(() => parked(f), { timeout: BUDGET.chain });
    const args = fs.readFileSync(calls, 'utf8');
    assert.match(args, /Keep the permission revoked/);
    assert.doesNotMatch(args, /Old diagnostic noise/);
  } finally { await cleanup(f); }
});

for (const changedSource of [false, true]) test(`uncertain remote status cannot pass or resubmit with source changed=${changedSource}`, async () => {
  const f = setup(); useFakeAgent({ build: 'good', verdict: 'pass' });
  const cfg = path.join(f.repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('Build, Verify', 'Build, CI, Verify') +
    'ci:\n  execution: remote\n  quick: node adapter.mjs\n  status_command: node status.mjs\n  poll_seconds: 1\n');
  fs.writeFileSync(path.join(f.repo, 'adapter.mjs'), `import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(path.join(f.dir, 'submits'))}, 'submit\\n');
    console.log('TODOMD_CI_STATUS ' + JSON.stringify({head: process.env.TODOMD_CI_HEAD, state: 'running', run_id: 'test-run'})); process.exit(2);`);
  fs.writeFileSync(path.join(f.repo, 'status.mjs'), `import fs from 'node:fs';
    const valid = fs.existsSync(${JSON.stringify(path.join(f.dir, 'valid'))});
    console.log('TODOMD_CI_STATUS ' + JSON.stringify({ head: valid ? process.env.TODOMD_CI_HEAD : 'b'.repeat(40),
      state: 'passed', run_id: 'test-run' }));`);
  git(f.repo, ['add', '-A']); git(f.repo, ['commit', '-qm', 'uncertain status fixture']);
  try {
    await pipeline.humanMove(f.project, 'task-0001', 'Queue'); await until(() => parked(f), { timeout: BUDGET.chain });
    const held = readCard(f.repo, 'task-0001');
    assert.equal(held.data.ci_remote.reason, 'remote_state_unknown');
    assert.equal(held.data.ci_remote.run_id, 'test-run');
    assert.deepEqual(held.data.ci_evidence, {});
    if (changedSource) {
      fs.writeFileSync(path.join(f.wt, 'followup.txt'), 'new candidate\n');
      git(f.wt, ['add', 'followup.txt']); git(f.wt, ['commit', '-qm', 'source changed after interruption']);
    }
    fs.writeFileSync(path.join(f.dir, 'valid'), 'valid');
    assert.equal((await pipeline.humanMove(f.project, 'task-0001', 'Queue')).ok, true);
    if (changedSource) {
      await until(() => parked(f), { timeout: BUDGET.chain });
      const card = readCard(f.repo, 'task-0001');
      assert.equal(card.data.ci_remote.reason, 'approval_stale');
      assert.deepEqual(card.data.ci_evidence, {}, 'the old job cannot attest new source');
      assert.equal(fs.readFileSync(path.join(f.dir, 'submits'), 'utf8'), 'submit\n');
      return;
    }
    await until(() => readCard(f.repo, 'task-0001').data.status === 'Done' && !pipeline.hasLiveRun(f.project.name, 'task-0001'), { timeout: BUDGET.chain });
    assert.equal(fs.readFileSync(path.join(f.dir, 'submits'), 'utf8'), 'submit\n');
    assert.equal(readCard(f.repo, 'task-0001').data.verification.attempts, 1);
  } finally { await cleanup(f); }
});
