import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, tmp, useFakeAgent, clearFakeAgent, git, until, BUDGET } from './helpers.js';
import { createBoardAgent } from '../src/board-agent.js';
import { savePublicationPolicies, agentPublicationPolicy } from '../src/board-agent-policy.js';
import { commitPaths, mergeBranch, addWorktree } from '../src/git.js';
import { readCard, patchFrontmatter } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';

after(async () => { await pipeline.killAllChildren({ graceMs: 1000 }); });
const settings = (boards = ['alpha', 'beta']) => ({ boards, contact: 'external', agent: 'claude', model: '', maxActionsPerTurn: 3, watch: false, instructions: '' });
function fixture(t, options = {}) {
  isolateHome();
  const projects = [{ name: 'alpha', path: makeRepo() }, { name: 'beta', path: makeRepo() }], directory = tmp('agent-v2');
  for (const p of projects) writeCard(p.path, 'task-0001', { status: 'Planned' });
  const calls = [];
  const operations = { isQueuePaused: () => false, getRunStates: () => ({}), pauseQueue: (p) => { calls.push(p.name); return { ok: true }; }, ...options.operations };
  const agent = createBoardAgent({ projects: () => projects, operations, directory, ...options }); t.after(() => agent.close());
  assert.equal(agent.configure(settings()).ok, true);
  const [alpha, beta] = agent.overview().boards.map((b) => b.board_id);
  return { agent, alpha, beta, projects, directory, operations, calls };
}
const grant = (agent, id, patch = {}) => agent.configureBoard({ board_id: id, policy: { contact: 'external', allowedActions: ['pause_queue'], ...patch } });
const act = (board_id, extra = {}) => ({ board_id, action: 'pause_queue', request_id: 'pause', ...extra });

test('selection grants no operations; board policies and durable conversations are independent', async (t) => {
  const { agent, alpha, beta, calls, directory, projects, operations } = fixture(t);
  assert.deepEqual(agent.overview().boards.map((b) => b.policy.allowedActions), [[], []]);
  assert.equal(grant(agent, alpha).ok, true);
  assert.equal((await agent.external(act(alpha))).ok, true);
  assert.ok((await agent.external(act(beta))).pending);
  assert.deepEqual(calls, ['alpha']);
  await agent.message({ board_id: alpha, text: 'Alpha must preserve its business rules.' });
  agent.reply({ board_id: alpha, text: 'Alpha decision saved.', request_id: 'alpha-reply' });
  await agent.message({ board_id: beta, text: 'Beta has a different priority.' });
  assert.doesNotMatch(JSON.stringify(agent.context({ board_id: beta })), /Alpha decision|business rules/);
  assert.doesNotMatch(JSON.stringify(agent.context({ board_id: alpha })), /different priority/);
  agent.close();
  const reopened = createBoardAgent({ directory, projects: () => projects, operations }); t.after(() => reopened.close());
  assert.match(JSON.stringify(reopened.context({ board_id: alpha })), /Alpha decision saved/);
  assert.doesNotMatch(JSON.stringify(reopened.context({ board_id: beta })), /Alpha decision saved/);
});

test('every board has a summary and focused pages detect revision changes', (t) => {
  const { agent, alpha, beta, projects } = fixture(t);
  for (let i = 1; i <= 15; i++) writeCard(projects[0].path, `task-${String(i).padStart(4, '0')}`, { body: 'a'.repeat(9000) });
  const overview = agent.overview(); assert.equal(overview.boards.length, 2); assert.equal(overview.boards[1].total, 1);
  const small = agent.context({ board_id: beta }); assert.equal(small.cards.length, 1);
  const large = agent.context({ board_id: alpha, limit: 2 }); assert.equal(large.cards.length, 2); assert.equal(large.next_cursor, '2');
  const rest = agent.context({ board_id: alpha, card_id: 'task-0001', detail_cursor: large.cards[0].next_detail_cursor });
  assert.equal(rest.cards[0].detailsTruncated, false);
  writeCard(projects[0].path, 'task-0001', { title: 'Changed while reading' });
  assert.match(agent.context({ board_id: alpha, cursor: large.next_cursor, revision: large.card_revision }).error, /changed/);
});

test('stable identity survives a rename; replacing a path requires a desktop rebind', async (t) => {
  const { agent, alpha, projects, calls } = fixture(t); grant(agent, alpha);
  projects[0].name = 'renamed';
  assert.equal(agent.overview().boards[0].board_id, alpha); assert.equal(agent.overview().boards[0].project, 'renamed');
  assert.equal((await agent.external(act(alpha))).ok, true);
  projects[0].path = makeRepo();
  assert.equal(agent.overview().boards[0].available, false);
  assert.equal((await agent.external(act(alpha, { request_id: 'new' }))).ok, false);
  assert.equal(agent.rebind({ board_id: alpha, project: 'renamed' }).ok, true);
  assert.equal(agent.publicState({ board_id: alpha }).stopped, true);
  grant(agent, alpha);
  assert.equal((await agent.external(act(alpha, { request_id: 'new' }))).ok, true);
  assert.deepEqual(calls, ['renamed', 'renamed']);
});

test('only affected policy changes invalidate proposals; audit survives', async (t) => {
  const { agent, alpha, beta } = fixture(t);
  const a = await agent.external(act(alpha)); const b = await agent.external(act(beta));
  assert.equal(agent.configureBoard({ board_id: beta, policy: { model: '' } }).ok, true);
  assert.equal(agent.publicState().pending.length, 2);
  grant(agent, beta);
  assert.deepEqual(agent.publicState().pending.map((p) => p.id), [a.pending]);
  assert.equal(agent.publicState().proposals.find((p) => p.id === b.pending).status, 'invalidated');
  assert.equal((await agent.decide(b.pending, true)).ok, false);
});

test('a second service owner cannot overwrite state or release the first owner lock', (t) => {
  const { agent, directory, projects, operations } = fixture(t);
  const second = createBoardAgent({ directory, projects: () => projects, operations });
  assert.match(second.publicState().storageError, /another Board Agent/);
  assert.equal(second.configure(settings()).ok, false); second.close();
  assert.equal(agent.configure(settings()).ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
  assert.equal(saved.serverId, agent.overview().server_id);
});

test('per-board turns run independently and stopping one rejects only its late output', async (t) => {
  const pending = [];
  const runner = (input) => ({ child: null, done: new Promise((resolve) => pending.push({ input, resolve })) });
  const { agent, alpha, beta, calls } = fixture(t, { runner });
  grant(agent, alpha, { contact: 'built_in' }); grant(agent, beta, { contact: 'built_in' });
  const a = agent.message({ board_id: alpha, text: 'Pause alpha' });
  const b = agent.message({ board_id: beta, text: 'Pause beta' });
  assert.equal(pending.length, 2);
  agent.stop({ board_id: alpha });
  pending[0].resolve({ envelope: { structured_output: { reply: '', actions: [{ board_id: alpha, action: 'pause_queue' }] } } });
  pending[1].resolve({ envelope: { structured_output: { reply: '', actions: [{ board_id: beta, action: 'pause_queue' }] } } });
  assert.equal((await a).ok, false); assert.equal((await b).ok, true); assert.deepEqual(calls, ['beta']);
  assert.equal(agent.publicState({ board_id: beta }).stopped, false);
});

test('external sessions bind focus, action budgets, controller leases, and idempotent retries', async (t) => {
  const { agent, alpha, beta, calls } = fixture(t); grant(agent, alpha, { maxActionsPerTurn: 1 }); grant(agent, beta);
  const session_id = 'codex-one';
  assert.match((await agent.external(act(alpha, { session_id }))).error, /message/);
  const message = { board_id: alpha, session_id, request_id: 'message-1', text: 'Pause alpha' };
  await agent.message(message);
  assert.equal((await agent.external(act(beta, { session_id }))).ok, false);
  assert.equal((await agent.external(act(alpha, { session_id }))).ok, true);
  await agent.message(message); // replay must not reset the budget
  assert.match((await agent.external(act(alpha, { session_id, request_id: 'extra' }))).error, /limit/);
  assert.equal((await agent.external(act(alpha, { session_id }))).ok, true);
  await agent.message({ ...message, session_id: 'codex-two' });
  assert.match((await agent.external(act(alpha, { session_id: 'codex-two' }))).error, /another external session/);
  assert.deepEqual(calls, ['alpha']);
});

test('close retains ownership through dispatch and saved outcomes survive reconnect', async (t) => {
  let finish;
  const { agent, alpha, directory, projects } = fixture(t, { operations: { isQueuePaused: () => false, getRunStates: () => ({}), pauseQueue: () => new Promise((resolve) => { finish = resolve; }) } });
  grant(agent, alpha);
  const run = agent.external(act(alpha)); await until(() => !!finish);
  agent.close();
  const contender = createBoardAgent({ directory, projects: () => projects });
  assert.match(contender.publicState().storageError, /another Board Agent/); contender.close();
  finish({ ok: true, resumed: false }); await run;
  const restored = createBoardAgent({ directory, projects: () => projects }); t.after(() => restored.close());
  assert.equal((await restored.external(act(alpha))).ok, true);
  assert.equal(restored.publicState().uncertain.length, 0);
});

test('v1 migration backs up exact data, preserves grants and receipts, archives mixed history', (t) => {
  isolateHome(); const root = makeRepo(), directory = tmp('v1-migration');
  const saved = { config: { ...settings(['alpha']), boards: [{ name: 'alpha', path: root }], allowedActions: ['pause_queue'] }, stopped: true,
    history: [{ id: 'mixed', role: 'user', content: 'Legacy portfolio text' }, { id: 'action', role: 'action', content: 'Alpha result', action: { project: 'alpha' } }],
    pending: [{ id: 'old', action: { project: 'alpha' } }], receipts: { old: { status: 'executing', action: { project: 'alpha' } } } };
  const original = JSON.stringify(saved); fs.writeFileSync(path.join(directory, 'state.json'), original);
  const operations = { isQueuePaused: () => true, getRunStates: () => ({}) };
  const agent = createBoardAgent({ directory, projects: () => [{ name: 'alpha', path: root }], operations }); t.after(() => agent.close());
  assert.equal(agent.publicState().storageError, '');
  assert.equal(fs.readFileSync(path.join(directory, 'state.v1.backup.json'), 'utf8'), original);
  const board = agent.overview().boards[0]; assert.deepEqual(board.policy.allowedActions, ['pause_queue']); assert.equal(board.policy.publication, 'legacy_auto_merge');
  assert.equal(board.queuePaused, true); assert.equal(board.stopped, true);
  assert.equal(agent.publicState().uncertain.length, 1); assert.equal(agent.publicState().pending.length, 0);
  assert.match(JSON.stringify(agent.context({ board_id: board.board_id }).history), /Alpha result/);
  assert.doesNotMatch(JSON.stringify(agent.context({ board_id: board.board_id })), /Legacy portfolio text/);
});

test('events resume by cursor without copying another board’s conversation', async (t) => {
  const { agent, alpha, beta } = fixture(t);
  await agent.message({ board_id: alpha, text: 'alpha only' });
  const first = agent.events({ board_id: alpha }); assert.match(JSON.stringify(first.events), /alpha only/);
  await agent.message({ board_id: beta, text: 'beta only' });
  const next = agent.events({ board_id: alpha, cursor: first.next_cursor }); assert.equal(next.events.length, 0);
  assert.equal(agent.events({ cursor: 999999 }).reset_required, true);
});

function policyRegistry(repo, publication = 'review_required') {
  savePublicationPolicies(path.join(process.env.TODOMD_HOME, '.todomd', 'board-agent'), [{ path: fs.realpathSync(repo), worktreeRoot: path.join(fs.realpathSync(repo), '.todomd', 'worktrees'), policy: { publication, protectedBranches: ['main', 'master'] } }]);
}
test('publication review prevents metadata staging/commits on protected branches and blocks merges', async () => {
  isolateHome(); const repo = makeRepo(), head = git(repo, ['rev-parse', 'HEAD']);
  policyRegistry(repo);
  const file = '.todomd/tasks/task-0001-card.md'; fs.writeFileSync(path.join(repo, file), 'local metadata');
  const commit = await commitPaths(repo, [file], 'metadata'); assert.equal(commit.reviewRequired, true);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head); assert.equal(git(repo, ['diff', '--cached', '--name-only']), '');
  const worktree = path.join(repo, '.todomd', 'worktrees', 'task-0001');
  await addWorktree(repo, worktree, 'todomd/task-0001');
  assert.equal(agentPublicationPolicy(worktree).publication, 'review_required');
  const merged = await mergeBranch(repo, 'todomd/task-0001', 'merge'); assert.equal(merged.reviewRequired, true);
  assert.equal(fs.existsSync(worktree), true); assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  fs.writeFileSync(path.join(process.env.TODOMD_HOME, '.todomd/board-agent/publication.json'), 'null');
  assert.equal((await commitPaths(repo, [file], 'metadata')).reviewRequired, true);
});

test('verified fake build stops for publication review, preserves work, and never commits to main', async (t) => {
  isolateHome(); useFakeAgent({ build: 'good', verdict: 'pass' }); t.after(clearFakeAgent);
  pipeline.init({ broadcast: () => {} });
  const repo = makeRepo(), project = { path: repo, name: path.basename(repo) };
  t.after(async () => { pipeline.forgetProject(project.name); await pipeline.killAllChildren({ graceMs: 1000 }); });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  const head = git(repo, ['rev-parse', 'HEAD']); policyRegistry(repo);
  assert.equal((await pipeline.humanMove(project, 'task-0001', 'Queue')).ok, true);
  await until(() => readCard(repo, 'task-0001').data.status === 'Needs Human', { timeout: BUDGET.chain });
  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'publication_review_required');
  assert.equal(card.data.verification.last_verdict, 'pass');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), true);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/);
  await until(() => !pipeline.hasLiveRun(project.name, 'task-0001'));
  assert.equal((await pipeline.recoveryActions(project, 'task-0001')).retry_verification, true);
  assert.equal((await pipeline.retryVerification(project, 'task-0001')).ok, true);
  await until(() => readCard(repo, 'task-0001').data.status === 'Needs Human'
    && !pipeline.hasLiveRun(project.name, 'task-0001'), { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'publication_review_required');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head, 'retry cannot authorize publication');

  // Simulate the repository's external human review and merge. The policy
  // stays review_required; the board only recognizes already-landed work.
  git(repo, ['merge', '--no-ff', '--no-verify', card.data.worktree, '-m', 'human reviewed publication']);
  const published = git(repo, ['rev-parse', 'HEAD']);
  await patchFrontmatter(repo, 'task-0001', { ci_evidence: {} });
  assert.equal((await pipeline.retryVerification(project, 'task-0001')).ok, true);
  await until(() => readCard(repo, 'task-0001').data.status === 'Done'
    && !pipeline.hasLiveRun(project.name, 'task-0001'), { timeout: BUDGET.chain });
  assert.equal(git(repo, ['rev-parse', 'HEAD']), published, 'reconciliation creates no new merge');
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, card.data.verification.attempts);
  assert.equal(agentPublicationPolicy(repo).publication, 'review_required');
});

test('duplicate proposals retain both request receipts and revoking scope blocks old reads', async (t) => {
  const { agent, alpha } = fixture(t);
  const first = await agent.external(act(alpha));
  const duplicate = await agent.external(act(alpha, { request_id: 'duplicate' }));
  assert.equal(first.pending, duplicate.pending);
  await agent.decide(first.pending, false);
  assert.equal((await agent.external(act(alpha, { request_id: 'duplicate' }))).status, 'declined');
  agent.configure(settings(['beta']));
  assert.match((await agent.external(act(alpha))).error, /scope/);
});

test('invalid v2 policy data fails closed and preserves saved evidence', (t) => {
  const { agent, directory, projects, operations, alpha } = fixture(t); agent.close();
  const file = path.join(directory, 'state.json'), saved = JSON.parse(fs.readFileSync(file));
  saved.boards[alpha].policy.aliases = null;
  const broken = JSON.stringify(saved); fs.writeFileSync(file, broken);
  const reopened = createBoardAgent({ directory, projects: () => projects, operations }); t.after(() => reopened.close());
  assert.match(reopened.publicState().storageError, /cannot be read/);
  assert.equal(reopened.configure(settings()).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('pipeline publication policy reads the same committed snapshot as coordinator grants', (t) => {
  isolateHome(); const repo = makeRepo(), directory = path.join(process.env.TODOMD_HOME, '.todomd', 'board-agent');
  const agent = createBoardAgent({ directory, projects: () => [{ name: 'alpha', path: repo }] }); t.after(() => agent.close());
  assert.equal(agent.configure(settings(['alpha'])).ok, true);
  policyRegistry(repo, 'legacy_auto_merge'); // a stale projection must never loosen v2 policy
  assert.equal(agentPublicationPolicy(repo).publication, 'review_required');
  const board_id = agent.overview().boards[0].board_id;
  agent.configureBoard({ board_id, policy: { publication: 'legacy_auto_merge' } });
  policyRegistry(repo, 'review_required');
  assert.equal(agentPublicationPolicy(repo).publication, 'legacy_auto_merge');
});
