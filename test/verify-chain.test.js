import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, BUDGET } from './helpers.js';
import { readCard, withRepoLock, normalizeConfig, setStageRouting, loadConfig } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';

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
