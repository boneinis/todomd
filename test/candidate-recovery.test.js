import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, patchFrontmatter } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';
import { ChildProcess } from 'node:child_process';
import { runs, runKey } from '../src/runstore.js';
import { signalChild } from '../src/process-lifecycle.js';

function fixture(script) {
  isolateHome(); scheduler.resetState(); pipeline.init({ broadcast: () => {} });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('Build, Verify', 'Build, CI, Verify') +
    'ci:\n  enabled: true\n  execution: remote\n  quick: node remote.mjs\n');
  fs.writeFileSync(path.join(repo, 'remote.mjs'), script);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'remote fixture policy']);
  const project = { name: path.basename(repo), path: repo };
  writeCard(repo, 'task-0001', { status: 'Planned' });
  return { repo, project, wt: path.join(repo, '.todomd/worktrees/task-0001') };
}
async function cleanup(project) {
  pipeline.forgetProject(project.name);
  await pipeline.killAllChildren({ graceMs: 100 });
  clearFakeAgent(); scheduler.resetState();
  delete process.env.TODOMD_KILL_GRACE_MS;
}
const parked = (repo, p) => readCard(repo, 'task-0001').data.status === 'Needs Human' && !pipeline.hasLiveRun(p.name, 'task-0001');

async function seedCandidate(repo, wt, reason = 'ci_failed') {
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '-qm', 'record task']);
  git(repo, ['worktree', 'add', '-b', 'todomd/task-0001', wt]);
  fs.writeFileSync(path.join(wt, 'implementation.txt'), 'reviewed implementation\n');
  git(wt, ['add', 'implementation.txt']); git(wt, ['commit', '-qm', 'reviewed candidate']);
  const head = git(wt, ['rev-parse', 'HEAD']);
  await patchFrontmatter(repo, 'task-0001', { status: 'Needs Human', worktree: 'todomd/task-0001',
    needs_human_reason: reason, recovery_stage: reason === 'agent_error' ? 'Build' : 'CI',
    verification: { attempts: 2, max_attempts: 3, last_verdict: 'fail' } });
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '-qm', 'unpushed bookkeeping on main']);
  return head;
}

for (const owner of ['queued', 'prompt-claim']) {
  test(`reset and recovery consistently reject ${owner} without changing the candidate`, async () => {
    const { repo, project: p, wt } = fixture('process.exit(0);\n');
    const head = await seedCandidate(repo, wt);
    try {
      pipeline.pauseQueue(p);
      if (owner === 'queued') {
        scheduler.schedule(p, 'task-0001', 'Build', () => assert.fail('blocked work must not start'), { blocked: () => true });
      } else {
        assert.equal((await pipeline.promptCard(p, 'task-0001', 'Inspect the candidate')).ok, true);
        // Exercise the claim-only window independently of scheduler tracking.
        scheduler.dequeue(p.name, 'task-0001');
        assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
      }
      const before = readCard(repo, 'task-0001').raw;
      const actions = await pipeline.recoveryActions(p, 'task-0001');
      for (const key of ['resume_build', 'restart_build', 'retry_verification', 'return_to_build', 'reset_attempts']) {
        assert.equal(actions[key], false, key);
      }
      assert.equal((await pipeline.humanMove(p, 'task-0001', 'Planned')).ok, false);
      assert.equal((await pipeline.returnToBuild(p, 'task-0001')).ok, false);
      assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, false);
      assert.equal(readCard(repo, 'task-0001').raw, before);
      assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.readFileSync(path.join(wt, 'implementation.txt'), 'utf8'), 'reviewed implementation\n');
    } finally { await cleanup(p); }
  });
}

test('a recovery admission owns the card before asynchronous worktree validation', async () => {
  const { repo, project: p, wt } = fixture('process.exit(0);\n');
  const head = await seedCandidate(repo, wt, 'merge_conflict');
  try {
    pipeline.pauseQueue(p);
    const first = pipeline.returnToBuild(p, 'task-0001');
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.equal(pipeline.projectHasLiveRun(p.name), true);
    const competing = await Promise.all([
      pipeline.returnToBuild(p, 'task-0001'),
      pipeline.retryVerification(p, 'task-0001'),
      pipeline.humanMove(p, 'task-0001', 'Planned'),
      pipeline.promptCard(p, 'task-0001', 'competing prompt'),
    ]);
    assert.ok(competing.every((result) => !result.ok));
    assert.equal((await first).ok, true);
    assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Queue');
    assert.equal(scheduler.queuedEntries(p.name).filter(e => e.card === 'task-0001').length, 1);
    assert.match(readCard(repo, 'task-0001').raw, /Repair the preserved candidate after merge_conflict/);
  } finally { await cleanup(p); }
});

test('published candidate remains recoverable after a remote CI interruption', async () => {
  useFakeAgent({ verdict: 'pass' });
  const blocked = path.join(tmp('published-ci'), 'blocked');
  const { repo, project: p, wt } = fixture(`import fs from 'node:fs'; process.exit(fs.existsSync(${JSON.stringify(blocked)}) ? 2 : 0);\n`);
  await seedCandidate(repo, wt, 'publication_review_required');
  await patchFrontmatter(repo, 'task-0001', { base_branch: git(repo, ['branch', '--show-current']),
    verification: { attempts: 2, max_attempts: 3, last_verdict: 'pass' } });
  git(repo, ['merge', '--no-ff', '--no-verify', 'todomd/task-0001', '-m', 'external publication']);
  fs.writeFileSync(blocked, '1');
  try {
    assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, true);
    await until(() => parked(repo, p), { timeout: BUDGET.chain });
    assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'ci_blocked');
    fs.unlinkSync(blocked);
    assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, true);
    await until(() => readCard(repo, 'task-0001').data.status === 'Done' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2);
  } finally { await cleanup(p); }
});

for (const reason of ['merge_conflict', 'merge_noop', 'base_branch_moved', 'base_branch_unknown']) {
  test(`${reason} can recover through verification without rebuilding or resetting attempts`, async () => {
    useFakeAgent({ verdict: 'pass' });
    const { repo, project: p, wt } = fixture('process.exit(0);\n');
    const head = await seedCandidate(repo, wt, reason);
    const target = git(repo, ['branch', '--show-current']);
    await patchFrontmatter(repo, 'task-0001', { recovery_stage: 'Verify',
      base_branch: reason === 'base_branch_unknown' ? 'unknown' : target,
      verification: { attempts: 3, max_attempts: 3, last_verdict: 'pass' } });
    try {
      const actions = await pipeline.recoveryActions(p, 'task-0001');
      assert.equal(actions.retry_verification, true);
      assert.equal(actions.return_to_build, ['merge_conflict', 'merge_noop'].includes(reason));
      assert.equal(actions.reset_attempts, true);
      if (reason === 'base_branch_unknown') {
        const before = readCard(repo, 'task-0001').raw;
        for (const baseBranch of ['', 'not-checked-out', 'todomd/task-0001', '--help']) {
          assert.equal((await pipeline.retryVerification(p, 'task-0001', { baseBranch })).ok, false);
          assert.equal(readCard(repo, 'task-0001').raw, before);
        }
      } else if (reason === 'base_branch_moved') {
        git(repo, ['checkout', '-b', 'wrong-target']);
        const before = readCard(repo, 'task-0001').raw;
        assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, false);
        assert.equal((await pipeline.retryVerification(p, 'task-0001', { baseBranch: 'wrong-target' })).ok, false);
        assert.equal(readCard(repo, 'task-0001').raw, before);
        assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
        git(repo, ['checkout', target]);
      }
      const result = await pipeline.retryVerification(p, 'task-0001', reason === 'base_branch_unknown' ? { baseBranch: target } : {});
      assert.equal(result.ok, true, result.error);
      await until(() => readCard(repo, 'task-0001').data.status === 'Done' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
      const card = readCard(repo, 'task-0001');
      assert.equal(card.data.verification.attempts, 3);
      assert.equal(card.data.verification.max_attempts, 3);
      assert.doesNotMatch(card.raw, /Return to Build|Build attempt 4/);
      assert.equal(git(repo, ['merge-base', '--is-ancestor', head, 'HEAD']), '');
      assert.equal(fs.readFileSync(path.join(repo, 'implementation.txt'), 'utf8'), 'reviewed implementation\n');
    } finally { await cleanup(p); }
  });
}

for (const lastVerdict of ['', 'fail']) {
  test(`CI-failed candidate offers a preserved repair Build with ${lastVerdict || 'no'} verifier verdict`, async () => {
    useFakeAgent({ build: 'good', verdict: 'pass' });
    const { repo, project: p, wt } = fixture('process.exit(0);\n');
    await seedCandidate(repo, wt, 'ci_failed');
    await patchFrontmatter(repo, 'task-0001', {
      recovery_stage: '', verification: { attempts: 3, max_attempts: 3, last_verdict: lastVerdict },
    });
    try {
      const actions = await pipeline.recoveryActions(p, 'task-0001');
      assert.equal(actions.return_to_build, true);
      assert.equal(actions.retry_verification, true, 'CI-only retry remains an alternative');
      const returned = await pipeline.humanMove(p, 'task-0001', 'Build', { instruction: 'Repair the failing CI check without discarding implementation.txt.' });
      assert.equal(returned.ok, true, returned.error);
      assert.equal(returned.attempt, 4);
      assert.equal(returned.max_attempts, 4);
      await until(() => readCard(repo, 'task-0001').data.status === 'Done' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
      assert.equal(fs.readFileSync(path.join(repo, 'implementation.txt'), 'utf8'), 'reviewed implementation\n');
      assert.match(readCard(repo, 'task-0001').raw, /Return to Build.*human approved repair attempt 4\/4/);
    } finally { await cleanup(p); }
  });
}

test('CI-failed repair still requires the preserved task branch', async () => {
  const { repo, project: p, wt } = fixture('process.exit(0);\n');
  await seedCandidate(repo, wt, 'ci_failed');
  try {
    git(wt, ['checkout', '-b', 'unrelated-fixture-branch']);
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).return_to_build, false);
    assert.equal((await pipeline.returnToBuild(p, 'task-0001')).ok, false);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Needs Human');
  } finally { await cleanup(p); }
});

for (const reason of ['ci_failed', 'agent_error']) {
  test(`retry verification after ${reason}: one-second silent adapter exit 1 parks the same candidate and attempt`, async () => {
    const calls = path.join(tmp('retry-ci'), 'agent-calls');
    useFakeAgent({ argv_log: calls });
    const { repo, project: p, wt } = fixture('setTimeout(() => process.exit(1), 1000);\n');
    const head = await seedCandidate(repo, wt, reason);
    try {
      assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true);
      assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, true);
      await until(() => parked(repo, p), { timeout: BUDGET.stage });
      const card = readCard(repo, 'task-0001');
      assert.equal(card.data.needs_human_reason, 'ci_failed');
      assert.equal(card.data.verification.attempts, 2);
      assert.equal(card.data.verification.max_attempts, 3);
      assert.deepEqual(card.data.ci_evidence, {});
      assert.equal(fs.existsSync(calls), false, 'no Build or Verify agent spawned');
      assert.doesNotMatch(card.raw, /retrying after a failed CI gate/);
      assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.readFileSync(path.join(wt, 'implementation.txt'), 'utf8'), 'reviewed implementation\n');
    } finally { await cleanup(p); }
  });
}

test('repair admission and cancel preserve candidate ancestry and running fleet journal; retry polls without resubmitting', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp('repair-journal');
  const calls = path.join(dir, 'agents');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: 'build', hang_on: '2',
    hang_counter: path.join(dir, 'builds'), hang_descendant: dir, argv_log: calls });
  process.env.TODOMD_KILL_GRACE_MS = '400';
  // Emulate the adapter-owned durable journal in the actual per-worktree Git
  // metadata directory. Runtime must leave it opaque and let the adapter poll.
  const { repo, project: p, wt } = fixture(`
    import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
    const dir = ${JSON.stringify(dir)};
    const gitdir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
    const journals = path.join(gitdir, 'fleet-runs'); fs.mkdirSync(journals, { recursive: true });
    const journal = path.join(journals, 'candidate.digest.unit.json');
    if (!fs.existsSync(journal)) {
      fs.writeFileSync(journal, JSON.stringify({ submission_id: '0123456789abcdef0123456789abcdef', run_id: '0123456789abcdef0123456789abcdef', phase: 'running' }));
      fs.appendFileSync(dir + '/submissions', 'submit\\n');
    } else {
      const receipt = JSON.parse(fs.readFileSync(journal));
      fs.appendFileSync(dir + '/polls', 'status ' + receipt.run_id + '\\n');
    }
    fs.writeFileSync(dir + '/ci-started', '1');
    const timer = setInterval(() => {
      if (fs.existsSync(dir + '/fail')) { clearInterval(timer); console.error('FAIL calc.test.js: expected 4, got 3'); process.exit(1); }
      if (fs.existsSync(dir + '/recover')) { clearInterval(timer); process.exit(2); }
    }, 20);
  `);
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(path.join(dir, 'ci-started')), { timeout: BUDGET.chain });
    const head = git(wt, ['rev-parse', 'HEAD']);
    const source = fs.readFileSync(path.join(wt, 'src/calc.js'), 'utf8');
    const gitdir = git(wt, ['rev-parse', '--absolute-git-dir']);
    const journal = path.join(gitdir, 'fleet-runs/candidate.digest.unit.json');
    const journalBytes = fs.readFileSync(journal, 'utf8');
    // Local main diverges with unpushed bookkeeping while approved CI runs.
    fs.writeFileSync(path.join(repo, 'local-bookkeeping.txt'), 'main-only\n');
    git(repo, ['add', 'local-bookkeeping.txt']); git(repo, ['commit', '-qm', 'unpushed local bookkeeping']);
    fs.writeFileSync(path.join(dir, 'fail'), '1');
    await until(() => fs.existsSync(path.join(dir, 'descendant')), { timeout: BUDGET.chain });
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2, 'real failure admitted bounded repair');
    assert.equal(git(wt, ['merge-base', '--is-ancestor', head, 'HEAD']), '');
    assert.equal(git(wt, ['rev-parse', 'HEAD']), head, 'admission performed no base sync');
    assert.equal(fs.readFileSync(journal, 'utf8'), journalBytes);
    const leader = Number(fs.readFileSync(path.join(dir, 'leader')));
    const descendant = Number(fs.readFileSync(path.join(dir, 'descendant')));
    const writes = path.join(wt, '.todomd/runs/writes');
    await until(() => fs.existsSync(writes));
    const cancelling = pipeline.cancel(p, 'task-0001');
    await sleep(100);
    assert.doesNotMatch(readCard(repo, 'task-0001').raw, /Build attempt 2.*cancelled/,
      'leader close must not record cancellation while its TERM-resistant writer survives');
    assert.equal((await cancelling).ok, true);
    assert.throws(() => process.kill(leader, 0), { code: 'ESRCH' });
    // Linux init may retain a killed orphan as Z. It cannot mutate files.
    try { process.kill(descendant, 0); assert.match(gitProcessState(descendant), /^Z/); } catch (err) { assert.equal(err.code, 'ESRCH'); }
    await until(() => parked(repo, p), { timeout: BUDGET.stage });
    const count = fs.readFileSync(writes, 'utf8');
    await sleep(200);
    assert.equal(fs.readFileSync(writes, 'utf8'), count, 'no mutations after cancellation');
    assert.match(readCard(repo, 'task-0001').raw, /Build attempt 2.*cancelled/);
    assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'build_cancelled');
    assert.equal(git(wt, ['merge-base', '--is-ancestor', head, 'HEAD']), '');
    assert.equal(fs.readFileSync(path.join(wt, 'src/calc.js'), 'utf8'), source);
    assert.equal(fs.readFileSync(journal, 'utf8'), journalBytes);
    assert.equal(git(wt, ['rev-parse', '--absolute-git-dir']), gitdir);
    assert.equal(git(wt, ['status', '--porcelain']), '');
    fs.unlinkSync(path.join(dir, 'fail')); fs.writeFileSync(path.join(dir, 'recover'), '1');
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true);
    assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, true);
    await until(() => parked(repo, p), { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'ci_blocked');
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'submissions'), 'utf8'), 'submit\n');
    assert.equal(fs.readFileSync(path.join(dir, 'polls'), 'utf8'), 'status 0123456789abcdef0123456789abcdef\n');
    assert.equal(fs.readFileSync(path.join(dir, 'builds'), 'utf8'), '2');
  } finally { await cleanup(p); }
});

import { execFileSync } from 'node:child_process';
function gitProcessState(pid) { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }

for (const damaged of ['missing', 'wrong-branch']) {
  test(`recorded candidate ${damaged} at Build admission fails closed without recreating from main`, async () => {
    const calls = path.join(tmp('damaged-candidate'), 'agents');
    useFakeAgent({ argv_log: calls });
    const { repo, project: p, wt } = fixture('process.exit(2);\n');
    const head = await seedCandidate(repo, wt);
    if (damaged === 'missing') git(repo, ['worktree', 'remove', wt]);
    else git(wt, ['checkout', '-b', 'operator-inspection']);
    // Model a persisted Queue recovery at boot, not a user-requested Restart.
    await patchFrontmatter(repo, 'task-0001', { status: 'Queue' });
    try {
      pipeline.kickQueue(p);
      await until(() => parked(repo, p), { timeout: BUDGET.stage });
      assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'worktree_failed');
      assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2);
      assert.equal(git(repo, ['rev-parse', 'todomd/task-0001']), head);
      assert.equal(fs.existsSync(calls), false);
      if (damaged === 'missing') assert.equal(fs.existsSync(wt), false);
      else {
        assert.equal(git(wt, ['branch', '--show-current']), 'operator-inspection');
        assert.equal(fs.readFileSync(path.join(wt, 'implementation.txt'), 'utf8'), 'reviewed implementation\n');
      }
    } finally { await cleanup(p); }
  });
}

test('shutdown retains the CI process-group barrier after the shell exits', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp('shutdown-ci-writer');
  useFakeAgent({ build: 'good' });
  const { repo, project: p, wt } = fixture(`
    import fs from 'node:fs'; import { spawn } from 'node:child_process';
    const dir = ${JSON.stringify(dir)};
    fs.mkdirSync('.todomd/runs', { recursive: true });
    spawn(process.execPath, ['-e', \`
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(\${JSON.stringify(dir + '/pid')}, String(process.pid));
      setInterval(() => fs.appendFileSync('.todomd/runs/writes', 'x'), 15);
    \`], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `);
  let pid;
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(path.join(dir, 'pid')), { timeout: BUDGET.stage });
    pid = Number(fs.readFileSync(path.join(dir, 'pid')));
    const writes = path.join(wt, '.todomd/runs/writes');
    await until(() => fs.existsSync(writes));
    const stopping = pipeline.killAllChildren({ graceMs: 400, preserveWorktrees: true });
    await sleep(100);
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true, 'CI stays tracked until the writer stops');
    assert.doesNotMatch(readCard(repo, 'task-0001').raw, /CI attempt 1.*cancelled/);
    await stopping;
    await until(() => parked(repo, p));
    assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'ci_blocked');
    const count = fs.readFileSync(writes, 'utf8');
    await sleep(250);
    assert.equal(fs.readFileSync(writes, 'utf8'), count, 'shutdown returned only after descendant stopped');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already reaped */ } }
    await cleanup(p);
  }
});

test('dirty cancelled repair offers Resume Build and preserves its candidate and attempt', async () => {
  const dir = tmp('dirty-repair');
  const marker = path.join(dir, 'hanging');
  useFakeAgent({ build: 'noop', hang: 'build', hang_marker: marker, require_file: 'unfinished.txt' });
  const { repo, project: p, wt } = fixture('process.exit(2);\n');
  const head = await seedCandidate(repo, wt, 'ci_evidence_invalid');
  try {
    assert.equal((await pipeline.returnToBuild(p, 'task-0001', 'Continue the preserved implementation')).ok, true);
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
    fs.writeFileSync(path.join(wt, 'unfinished.txt'), 'unfinished repair\n');
    assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
    await until(() => parked(repo, p));
    let card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'build_cancelled');
    assert.equal(card.data.recovery_stage, 'Build');
    assert.equal(card.data.verification.attempts, 3);
    const actions = await pipeline.recoveryActions(p, 'task-0001');
    assert.equal(actions.resume_build, true);
    assert.equal(actions.retry_verification, true);
    assert.equal((await pipeline.resumeBuild(p, 'task-0001')).ok, true);
    await until(() => parked(repo, p));
    card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'uncommitted_build', 'resumed no-op Build leaves dirty work for the operator');
    assert.equal(card.data.verification.attempts, 3, 'resume did not spend another attempt');
    assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
    assert.equal(fs.readFileSync(path.join(wt, 'unfinished.txt'), 'utf8'), 'unfinished repair\n');
    assert.match(card.raw, /Resume Build · continuing attempt 3 after build_cancelled/);
  } finally { await cleanup(p); }
});

for (const stage of ['Build', 'CI', 'Verify']) {
  test(`failed ${stage} stop confirmation releases tracking and parks the preserved candidate`, async (t) => {
    const dir = tmp('failed-stop');
    const marker = path.join(dir, 'hanging');
    const spawned = [];
    const emit = ChildProcess.prototype.emit;
    t.mock.method(ChildProcess.prototype, 'emit', function (event, ...args) {
      if (event === 'spawn') spawned.push(this);
      return emit.call(this, event, ...args);
    });
    useFakeAgent({ build: 'good', hang: stage.toLowerCase(), hang_marker: marker });
    const { repo, project: p, wt } = fixture(stage === 'CI'
      ? `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`
      : 'process.exit(0);');
    let child;
    try {
      await pipeline.humanMove(p, 'task-0001', 'Queue');
      await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
      const run = runs.get(runKey(p.name, 'task-0001'));
      assert.equal(run.stage, stage);
      child = spawned.find((entry) => entry.pid === run.pid);
      assert.ok(child);
      const head = git(wt, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(wt, 'unfinished.txt'), 'preserved work');
      // Inject the same barrier stopChild returns on failed confirmation. The
      // fixture process really exits; only confirmation is simulated to fail.
      let finishStop;
      child.todomdStop = new Promise((resolve) => { finishStop = resolve; });
      const cancelling = pipeline.cancel(p, 'task-0001');
      await until(() => run.cancelled);
      signalChild(child, 'SIGTERM');
      const error = `could not confirm process group ${child.pid} stopped; cancellation is incomplete`;
      finishStop({ ok: false, error });
      assert.deepEqual(await cancelling, { ok: false, error });
      await until(() => parked(repo, p), { timeout: BUDGET.stage });
      const card = readCard(repo, 'task-0001');
      assert.equal(card.data.needs_human_reason, stage === 'CI' ? 'ci_blocked' : 'build_cancelled');
      assert.equal(card.data.recovery_stage, stage);
      assert.match(card.raw, new RegExp(`cancellation incomplete: could not confirm process group ${child.pid} stopped`));
      assert.doesNotMatch(card.raw, /pipeline_error|attempt 1.*cancelled/);
      assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false);
      const actions = await pipeline.recoveryActions(p, 'task-0001');
      assert.equal(actions.retry_verification, true);
      assert.equal(actions.resume_build, stage === 'Build');
      assert.equal(card.data.verification.attempts, 1);
      assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
      assert.equal(fs.readFileSync(path.join(wt, 'unfinished.txt'), 'utf8'), 'preserved work');
      assert.equal((await pipeline.humanMove(p, 'task-0001', 'Planned')).ok, true,
        'the runtime remains responsive and no tracking entry wedges human moves');
    } finally {
      if (child) signalChild(child, 'SIGKILL');
      await cleanup(p);
    }
  });
}

for (const stage of ['Build', 'Verify']) {
  test(`first-attempt ${stage} cancel honors committed remote policy and reports deliberate cancellation`, async () => {
    const marker = path.join(tmp('remote-cancel'), 'hanging');
    useFakeAgent({ build: 'good', hang: stage.toLowerCase(), hang_marker: marker });
    const { repo, project: p, wt } = fixture('process.exit(0);');
    // An uncommitted policy edit must not disable candidate preservation.
    const cfg = path.join(repo, '.todomd/config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('execution: remote', 'execution: local'));
    try {
      await pipeline.humanMove(p, 'task-0001', 'Queue');
      await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
      const head = git(wt, ['rev-parse', 'HEAD']);
      assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
      await until(() => parked(repo, p), { timeout: BUDGET.stage });
      const card = readCard(repo, 'task-0001');
      assert.equal(card.data.needs_human_reason, 'build_cancelled');
      assert.equal(card.data.recovery_stage, stage);
      assert.equal(card.data.verification.attempts, 1);
      assert.doesNotMatch(card.raw, /server stopped|orphaned_run/);
      assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
      assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true);
    } finally { await cleanup(p); }
  });
}

test('archive and unarchive clear the candidate record and admit a fresh Queue Build', async () => {
  const calls = path.join(tmp('archive-candidate'), 'agents');
  useFakeAgent({ build: 'good', argv_log: calls });
  const { repo, project: p, wt } = fixture('process.exit(2);');
  await seedCandidate(repo, wt);
  await patchFrontmatter(repo, 'task-0001', { status: 'Queue', base_branch: 'main' });
  try {
    assert.equal((await pipeline.archiveCard(p, 'task-0001', true)).ok, true);
    const archived = readCard(repo, 'task-0001');
    for (const field of ['worktree', 'base_branch', 'recovery_stage']) assert.ok(!archived.data[field], `${field} is cleared`);
    assert.equal(fs.existsSync(wt), false);
    assert.equal((await pipeline.archiveCard(p, 'task-0001', false)).ok, true);
    pipeline.kickQueue(p);
    await until(() => parked(repo, p), { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'ci_blocked', 'fresh Build reached CI');
    assert.equal(card.data.verification.attempts, 3);
    assert.equal(fs.existsSync(calls), true, 'a fresh Build agent ran');
    assert.equal(fs.existsSync(wt), true);
    assert.equal(fs.existsSync(path.join(wt, 'implementation.txt')), false, 'archived candidate was released');
    assert.doesNotMatch(card.raw, /worktree_failed/);
  } finally { await cleanup(p); }
});
