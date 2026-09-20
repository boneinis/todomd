import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, withRepoLock, normalizeConfig, setStageRouting, loadConfig, patchFrontmatter } from '../src/board.js';
import { createGovernor, resourcesConfig } from '../src/resources.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';

const noop = () => {};
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.js');
function project(repo) { return { name: path.basename(repo), path: repo }; }
const status = (repo, id) => readCard(repo, id).data.status;
const runLog = (repo, id) => readCard(repo, id).raw.split('## Run Log')[1] || '';

after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

// `stages` is an EXEC_KEY, so the chain must be COMMITTED before a run reads it.
function setVerifyChain(repo, links) {
  const cfg = path.join(repo, '.todomd/config.yml');
  const lines = links.map((l) => `      - { ${Object.entries(l).map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('  Verify:\n    command: todomd-verify\n    model: haiku\n',
      `  Verify:\n    command: todomd-verify\n    chain:\n${lines.join('\n')}\n`));
  git(repo, ['commit', '-qam', 'chain']);
}

// verify invocations of the claude fake, by prompt
function claudeVerifyRuns(argvLog) {
  if (!fs.existsSync(argvLog)) return 0;
  return fs.readFileSync(argvLog, 'utf8').split('\n').filter((l) => l.includes('todomd-verify')).length;
}

function setup(chain, fakeOpts = {}) {
  isolateHome();
  const argvLog = path.join(tmp('chain'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', build: 'good', argv_log: argvLog, ...fakeOpts });
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  setVerifyChain(repo, chain);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  return { repo, p: project(repo), argvLog };
}

function teardown() {
  delete process.env.TODOMD_CODEX_BIN;
  delete process.env.FAKE_CODEX_FAIL_ONCE;
  clearFakeAgent();
}

test('chain of two, both pass: two Verify spawns on one candidate, card Done, two pass entries', async () => {
  const { repo, p, argvLog } = setup([
    { agent: 'claude', model: 'haiku', effort: 'low' },
    { agent: 'codex', model: 'gpt-test', effort: 'high' },
  ]);
  try {
    const r = await pipeline.humanMove(p, 'task-0001', 'Queue');
    assert.equal(r.ok, true, r.error);
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/, 'merged');
    assert.equal(card.data.verification.attempts, 1, 'one attempt: no rebuild between links');
    assert.equal(card.data.verification.last_verdict, 'pass');
    const chain = card.data.verification.chain;
    assert.equal(chain.length, 2);
    assert.deepEqual(chain.map((c) => [c.link, c.agent, c.model, c.verdict]),
      [[1, 'claude', 'haiku', 'pass'], [2, 'codex', 'gpt-test', 'pass']]);
    for (const c of chain) assert.match(String(c.at), /^\d{4}-\d{2}-\d{2}T/);
    const log = runLog(repo, 'task-0001');
    assert.equal(claudeVerifyRuns(argvLog), 1, 'link 1 spawned exactly once');
    assert.equal((log.match(/Verify attempt 1 · .*· codex\/gpt-test ·/g) || []).length, 1, 'link 2 spawned exactly once');
    assert.match(log, /verdict: pass — link 1\/2 \(claude\/haiku\); next: link 2\/2 \(codex\/gpt-test\)/);
    assert.match(log, /verdict: pass — link 2\/2 \(codex\/gpt-test\)/);
    assert.equal((log.match(/Build attempt/g) || []).length, 1, 'no rebuild between links');
    assert.equal((log.match(/CI attempt/g) || []).length, 1, 'no re-CI between links');
    // link 2 ran in the same worktree as link 1 (the candidate branch) — the
    // fake codex logs its argv; the cwd is recorded by the runner's log file
    assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), 'worktree pruned after merge');
  } finally { teardown(); }
});

test('chain of two, link 1 fails: one spawn, card back to Build as today, chain has one fail entry', async () => {
  const dir = tmp('chain-fail1');
  const { repo, p, argvLog } = setup([
    { agent: 'codex', model: 'gpt-test' },
    { agent: 'claude', model: 'haiku' },
  ], { hang: 'build', hang_on: 2, hang_counter: path.join(dir, 'builds') });
  process.env.FAKE_CODEX_FAIL_ONCE = path.join(dir, 'failed-once');
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    // attempt 1: codex (link 1) fails → the retry Build (attempt 2) hangs, so
    // the state after the failed link is stable enough to assert on
    await until(() => readCard(repo, 'task-0001').data.verification?.attempts === 2
      && status(repo, 'task-0001') === 'Build', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.last_verdict, 'fail');
    assert.equal(claudeVerifyRuns(argvLog), 0, 'link 2 never spawned after link 1 failed');
    const log = runLog(repo, 'task-0001');
    assert.match(log, /Verify attempt 1 · .*codex\/gpt-test .*verdict: fail — link 1\/2 \(codex\/gpt-test\)/);
    assert.match(log, /retrying with findings \(attempt 2\/3\)/);
    assert.doesNotMatch(log, /link 2\/2/);
    // the failed link's record rides along into the repair Build; it is reset
    // when the next attempt's Verify starts again from link 1
    assert.deepEqual(card.data.verification.chain.map((c) => [c.link, c.agent, c.model, c.verdict]),
      [[1, 'codex', 'gpt-test', 'fail']]);
    // settle the hung repair Build before the next test: a cancelled retry
    // Build preserves the candidate in Needs Human and nothing re-drives it
    assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
    await until(() => status(repo, 'task-0001') === 'Needs Human' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.chain });
  } finally { teardown(); }
});

test('chain of two, link 1 pass then link 2 fails: two spawns, back to Build, chain restarts from link 1', async () => {
  const dir = tmp('chain-fail2');
  const { repo, p, argvLog } = setup([
    { agent: 'claude', model: 'haiku' },
    { agent: 'codex', model: 'gpt-test' },
  ]);
  process.env.FAKE_CODEX_FAIL_ONCE = path.join(dir, 'failed-once');
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.attempts, 2, 'the link-2 fail sent the card back to Build');
    assert.equal(claudeVerifyRuns(argvLog), 2, 'link 1 ran on both attempts — the chain restarts from link 1');
    const log = runLog(repo, 'task-0001');
    assert.match(log, /Verify attempt 1 · .*claude\/haiku .*verdict: pass — link 1\/2/);
    assert.match(log, /Verify attempt 1 · .*codex\/gpt-test .*verdict: fail — link 2\/2/);
    assert.match(log, /retrying with findings \(attempt 2\/3\)/);
    assert.match(log, /Verify attempt 2 · .*claude\/haiku .*verdict: pass — link 1\/2/);
    assert.match(log, /Verify attempt 2 · .*codex\/gpt-test .*verdict: pass — link 2\/2/);
    assert.deepEqual(card.data.verification.chain.map((c) => [c.link, c.verdict]), [[1, 'pass'], [2, 'pass']],
      'the final record holds only the passing attempt');
  } finally { teardown(); }
});

test('a cancel between link 1 pass and link 2 spawn reverts like a pre-spawn cancel', async () => {
  const { repo, p, argvLog } = setup([
    { agent: 'claude', model: 'haiku' },
    { agent: 'codex', model: 'gpt-test' },
  ]);
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    // link 1 is live: its child has been spawned
    await until(() => claudeVerifyRuns(argvLog) === 1, { timeout: BUDGET.chain });
    // Hold the repo lock: link 1's verdict is recorded to the usage store BEFORE
    // its card write needs the lock, so `model_runs` reaching 2 (Build + link 1)
    // proves link 1's child has exited and the chain is parked between links.
    await withRepoLock(repo, async () => {
      await until(() => pipeline.usage(p).model_runs >= 2, { timeout: BUDGET.stage });
      const r = await pipeline.cancel(p, 'task-0001');
      assert.equal(r.ok, true, r.error);
      assert.doesNotMatch(runLog(repo, 'task-0001'), /· codex\/gpt-test ·/, 'link 2 has not spawned');
    });
    // the between-spawns revert: worktree gone, attempt rolled back, requeued;
    // the re-driven attempt runs the whole chain and lands Done
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.attempts, 1, 'the cancelled attempt was rolled back');
    const log = runLog(repo, 'task-0001');
    assert.equal((log.match(/· codex\/gpt-test ·/g) || []).length, 1, 'link 2 spawned only on the re-driven attempt');
    assert.equal(claudeVerifyRuns(argvLog), 2, 'link 1 ran again from the top on the re-driven attempt');
    assert.deepEqual(card.data.verification.chain.map((c) => [c.link, c.verdict]), [[1, 'pass'], [2, 'pass']]);
  } finally { teardown(); }
});

test('config validation rejects an empty chain and a link without agent', async () => {
  assert.equal(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { command: 'todomd-verify' } } })), null,
    'absent chain is fine');
  assert.match(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: [] } } })), /chain.*empty/);
  assert.match(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: 'codex' } } })), /chain.*list/);
  assert.match(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: [{ model: 'haiku' }] } } })),
    /chain\[1\].*agent/);
  assert.match(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: [{ agent: 'claude' }, { agent: 'nope' }] } } })),
    /chain\[2\].*not supported/);
  assert.match(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: [{ agent: 'codex', model: 'haiku' }] } } })),
    /chain\[1\].*belongs to claude/);
  assert.equal(pipeline.verifyChainError(normalizeConfig({ stages: { Verify: { chain: [{ agent: 'claude' }, { agent: 'codex', model: 'gpt-test' }] } } })), null);
});

test('a chain link without agent parks the card in Needs Human (routing_error) instead of running', async () => {
  const { repo, p, argvLog } = setup([{ model: 'haiku' }]);
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
    assert.equal(claudeVerifyRuns(argvLog), 0, 'nothing spawned');
    assert.match(readCard(repo, 'task-0001').raw, /routing_error/);
  } finally { teardown(); }
});

test('stage routing edits leave a block-form chain link alone', async () => {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('  Verify:\n    command: todomd-verify\n    model: haiku\n',
      '  Verify:\n    command: todomd-verify\n    chain:\n      - agent: claude\n        model: haiku\n      - agent: codex\n        model: gpt-test\n'));
  git(repo, ['commit', '-qam', 'chain']);
  const r = await setStageRouting(repo, 'Verify', { model: 'sonnet', effort: 'high' });
  assert.equal(r.ok, true, r.error);
  const verify = loadConfig(repo).stages.Verify;
  assert.equal(verify.model, 'sonnet', 'the column key was set');
  assert.equal(verify.effort, 'high');
  assert.deepEqual(verify.chain, [{ agent: 'claude', model: 'haiku' }, { agent: 'codex', model: 'gpt-test' }],
    'the link models were not mistaken for the column model');
});

// A Needs Human card with a preserved candidate, eligible for Retry Verification
// (mirrors pipeline.test.js's seedPreservedVerification).
function seedPreservedVerification(repo, id) {
  const base = git(repo, ['branch', '--show-current']);
  const branch = `todomd/${id}`;
  const worktree = path.join(repo, '.todomd/worktrees', id);
  writeCard(repo, id, {
    status: 'Needs Human',
    extra: `needs_human_reason: bad_verdict\nsession_id: fake-session\nworktree: ${branch}\nbase_branch: ${base}\n`,
  });
  const cardFile = path.join(repo, '.todomd/tasks', `${id}-card.md`);
  fs.writeFileSync(cardFile, fs.readFileSync(cardFile, 'utf8')
    .replace('verification: { attempts: 0,', 'verification: { attempts: 1,'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `seed preserved verification ${id}`]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-q', worktree, '-b', branch]);
  fs.writeFileSync(path.join(worktree, 'src/preserved-candidate.js'), 'export const candidate = true;\n');
  git(worktree, ['add', 'src/preserved-candidate.js']);
  git(worktree, ['commit', '-qm', 'seed preserved candidate']);
  return { branch, worktree };
}

test('a link admitted light re-enters the scheduler as heavy: link 2 is queued, then runs with the stage tools', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  const argvLog = path.join(tmp('chain-light'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // both links on the claude fake so one argv log shows every reviewer spawn
  setVerifyChain(repo, [{ agent: 'claude', model: 'haiku' }, { agent: 'claude', model: 'sonnet' }]);
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');
  await patchFrontmatter(repo, 'task-0001', {
    ci_evidence: {
      head: git(worktree, ['rev-parse', 'HEAD']), command: 'node --version',
      passed_at: '2026-01-01T00:00:00.000Z', clean: true,
    },
  });
  let sample = { cpuLoad: 0.99 }; // breach: heavy work is deferred, light (tool-less) review is admitted
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick();
  const spawns = () => fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse) : [];

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    // link 1 ran tool-less and passed; link 2 is NOT spawned inline — it waits
    // in the Verify column as a heavy entry the governor is deferring
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.state === 'deferred', { timeout: BUDGET.stage });
    assert.equal(spawns().length, 1, 'only the light link 1 review ran while CPU was high');
    const link1 = spawns()[0];
    assert.match(link1.find((arg) => arg.includes('Resource-aware tool-less review')), /CPU pressure/);
    assert.deepEqual(link1.slice(link1.indexOf('--tools'), link1.indexOf('--tools') + 2), ['--tools', ''], 'link 1 was tool-less');
    assert.match(readCard(repo, 'task-0001').raw, /verdict: pass — link 1\/2 \(claude\/haiku\); next: link 2\/2 \(claude\/sonnet\)/);
    const entry = scheduler.queuedEntries(p.name).find((e) => e.card === 'task-0001');
    assert.equal(entry?.column, 'Verify');
    assert.equal(entry?.resourceClass, 'heavy', 'link 2 is a heavy admission');
    assert.equal(status(repo, 'task-0001'), 'Verify');
    assert.equal(fs.existsSync(worktree), true, 'the candidate is untouched between links');

    sample = { cpuLoad: 0.05 };
    scheduler.tick();
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.quick });
    assert.equal(spawns().length, 2, 'link 2 spawned once, after admission');
    const link2 = spawns()[1];
    assert.equal(link2.some((arg) => arg.includes('Resource-aware tool-less review')), false, 'link 2 was a full review');
    assert.notDeepEqual(link2.slice(link2.indexOf('--tools'), link2.indexOf('--tools') + 2), ['--tools', ''], 'link 2 ran with the stage tools');
    assert.deepEqual(link2.slice(link2.indexOf('--model'), link2.indexOf('--model') + 2), ['--model', 'sonnet']);
    assert.deepEqual(readCard(repo, 'task-0001').data.verification.chain.map((c) => [c.link, c.model, c.verdict]),
      [[1, 'haiku', 'pass'], [2, 'sonnet', 'pass']]);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});
