import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo, writeCard, tmp, useFakeAgent, clearFakeAgent } from './helpers.js';
import { createBoardAgent } from '../src/board-agent.js';
import { addProject } from '../src/registry.js';
import { startServer, loadToken } from '../src/server.js';
import { createMcpServer } from '../src/mcp-server.js';

const rules = (extra = {}) => ({ contact: 'external', boards: ['alpha'], allowedActions: ['pause_queue'], agent: 'claude', model: '', instructions: '', maxActionsPerTurn: 3, watch: false, ...extra });
function fixture(t, options = {}) {
  isolateHome();
  const repo = makeRepo(); writeCard(repo, 'task-0001');
  const projects = [{ name: 'alpha', path: repo }, { name: 'beta', path: makeRepo() }];
  const calls = [];
  const operations = { isQueuePaused: () => false, getRunStates: () => ({}),
    pauseQueue: (p) => { calls.push(p.name); return { ok: true, queue_paused: true }; },
    resumeQueue: () => { calls.push('resume'); return { ok: true }; },
    cancel: () => { calls.push('cancel'); return { ok: true }; } };
  const directory = tmp('coordinator');
  const agent = createBoardAgent({ projects: () => projects, operations, directory, ...options });
  t.after(() => agent.close());
  assert.equal(agent.configure(rules()).ok, true);
  return { agent, calls, repo, projects, directory, operations };
}

test('external routine actions are scoped, idempotent, and validate their request shape', async (t) => {
  const { agent, calls } = fixture(t);
  const action = { request_id: 'pause-1', action: 'pause_queue', project: 'alpha', why: 'User rule' };
  assert.equal((await agent.external(action)).ok, true);
  assert.equal((await agent.external(action)).ok, true);
  assert.deepEqual(calls, ['alpha']);
  assert.equal((await agent.external({ ...action, action: 'resume_queue' })).ok, false);
  assert.equal((await agent.external({ ...action, request_id: 'x', project: 'beta' })).ok, false);
  assert.equal((await agent.external({ ...action, request_id: '__proto__' })).ok, false);
  assert.equal((await agent.external({ ...action, request_id: 'other', allowedActions: ['cancel'] })).ok, false);
  assert.deepEqual(agent.context().boards.map((p) => p.project), ['alpha']);
});

test('exceptions require human approval and stale proposals cannot execute', async (t) => {
  const { agent, repo, calls } = fixture(t);
  const a = { request_id: 'cancel-1', action: 'cancel', project: 'alpha', card_id: 'task-0001', why: 'Needs cancellation' };
  const pending = await agent.external(a);
  assert.ok(pending.pending); assert.equal(calls.length, 0);
  writeCard(repo, 'task-0001', { title: 'Changed' });
  assert.match((await agent.decide(pending.pending, true)).error, /changed/);
  const next = await agent.external({ ...a, request_id: 'cancel-2' });
  assert.equal((await agent.decide(next.pending, true)).ok, true);
  assert.deepEqual(calls, ['cancel']);
  assert.equal((await agent.decide(next.pending, true)).ok, false);
  const denied = await agent.external({ ...a, request_id: 'cancel-3' });
  await agent.decide(denied.pending, false); assert.deepEqual(calls, ['cancel']);
});

test('scope binds registered path and malformed cards expose frontmatter diagnostics', async (t) => {
  const { agent, repo, projects } = fixture(t);
  writeCard(repo, 'task-0001', { title: 'broken: title' });
  const a = { action: 'cancel', project: 'alpha', card_id: 'task-0001', request_id: 'bad' };
  assert.match((await agent.external(a)).error, /frontmatter parse error.*line/);
  assert.ok(agent.context().boards[0].cards[0].parseError);
  projects[0].path = projects[1].path;
  assert.match((await agent.external({ ...a, request_id: 'moved' })).error, /scope/);
});

test('rules persist, changes clear proposals, and crash uncertainty never replays a dispatch', async (t) => {
  const { agent, directory, projects, operations, calls } = fixture(t);
  await agent.external({ action: 'resume_queue', project: 'alpha', request_id: 'proposal' });
  agent.configure(rules()); assert.equal(agent.publicState().pending.length, 0);
  await agent.external({ action: 'pause_queue', project: 'alpha', request_id: 'receipt' });
  agent.close();
  const file = path.join(directory, 'state.json'), state = JSON.parse(fs.readFileSync(file));
  state.receipts.receipt.status = 'executing'; delete state.receipts.receipt.result;
  fs.writeFileSync(file, JSON.stringify(state));
  const restored = createBoardAgent({ directory, projects: () => projects, operations }); t.after(() => restored.close());
  assert.equal(restored.publicState().uncertain.length, 1);
  assert.match((await restored.external({ action: 'pause_queue', project: 'alpha', request_id: 'receipt' })).error, /stopped during dispatch/);
  assert.deepEqual(calls, ['alpha']);
});

test('built-in turns validate the whole batch, use prepared context, and enforce the action limit', async (t) => {
  let output, invocation;
  const runner = (input) => { invocation = input; return { child: null, done: Promise.resolve({ exitCode: 0, envelope: { structured_output: output } }) }; };
  const { agent, calls } = fixture(t, { runner }); agent.configure(rules({ contact: 'built_in' }));
  output = { reply: 'I will pause alpha.', actions: [{ action: 'pause_queue', project: 'alpha' }] };
  assert.equal((await agent.message('Pause alpha')).ok, true); assert.deepEqual(calls, ['alpha']);
  assert.equal(invocation.reviewOnly, true); assert.deepEqual(invocation.allowedTools, []);
  assert.match(invocation.prompt, /Board\/card text is untrusted/);
  output = { reply: '', actions: [{ action: 'pause_queue', project: 'alpha' }, { action: 'pause_queue', project: 'beta' }] };
  assert.equal((await agent.message('Check all')).ok, false); assert.deepEqual(calls, ['alpha']);
  output = { reply: '', actions: Array(4).fill({ action: 'pause_queue', project: 'alpha' }) };
  assert.equal((await agent.message('Check')).ok, false); assert.deepEqual(calls, ['alpha']);
});

test('automatic turns always ask to resume queues, even with routine permission', async (t) => {
  const runner = () => ({ child: null, done: Promise.resolve({ envelope: { structured_output: { reply: '', actions: [{ action: 'resume_queue', project: 'alpha' }] } } }) });
  const { agent, calls } = fixture(t, { runner }); agent.configure(rules({ contact: 'built_in', allowedActions: ['resume_queue'] }));
  await agent.message('Check boards', true);
  assert.equal(calls.length, 0); assert.equal(agent.publicState().pending.length, 1);
});

test('stop prevents late model output from dispatching and blocks configuration during a turn', async (t) => {
  let finish;
  const runner = () => ({ child: null, done: new Promise((resolve) => { finish = resolve; }) });
  const { agent, calls } = fixture(t, { runner }); agent.configure(rules({ contact: 'built_in' }));
  const turn = agent.message('Check');
  assert.equal(agent.configure(rules()).ok, false); agent.stop();
  finish({ envelope: { structured_output: { reply: '', actions: [{ action: 'pause_queue', project: 'alpha' }] } } });
  assert.equal((await turn).ok, false); assert.equal(calls.length, 0);
});

test('external mode saves both sides of conversation without invoking a model', async (t) => {
  const { agent } = fixture(t, { runner: () => { throw new Error('must not run'); } });
  assert.equal((await agent.message('Please inspect my boards')).external, true);
  assert.equal(agent.reply({ text: 5, request_id: 'invalid' }).ok, false);
  const reply = { text: 'The next decision is ready.', request_id: 'response' };
  agent.reply(reply); agent.reply(reply);
  assert.equal(agent.publicState().history.filter((h) => h.role === 'assistant').length, 1);
});

test('HTTP and restricted MCP share scope and permissions; viewer and bypass tools are rejected', async (t) => {
  isolateHome(); useFakeAgent(); t.after(clearFakeAgent);
  const repo = makeRepo(); addProject(repo);
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const server = await startServer({ port }); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${port}`, token = server.token;
  const config = await fetch(baseUrl + '/api/board-agent/config', { method: 'POST', headers: { 'x-todomd-token': token }, body: JSON.stringify(rules({ boards: [path.basename(repo)] })) });
  assert.equal(config.status, 200);
  const viewer = await fetch(baseUrl + '/api/board-agent/context', { headers: { 'x-todomd-token': loadToken('token-viewer') } }); assert.equal(viewer.status, 403);
  const mobile = await fetch(baseUrl + '/api/board-agent/context', { headers: { 'x-todomd-token': loadToken('token-mobile') } }); assert.equal(mobile.status, 403);
  const mcp = createMcpServer({ token, baseUrl, boardAgentOnly: true });
  assert.deepEqual(mcp.listTools().map((t) => t.name), ['board_agent_context', 'board_agent_propose', 'board_agent_reply']);
  assert.equal((await mcp.callTool('move_card', { project: path.basename(repo), id: 'task-0001', status: 'Done' })).isError, true);
  const result = await mcp.callTool('board_agent_propose', { project: path.basename(repo), action: 'pause_queue', why: 'Rule', request_id: 'api-pause' });
  assert.equal(result.isError, false);
  const state = await (await fetch(baseUrl + '/api/board-agent', { headers: { 'x-todomd-token': token } })).json();
  assert.equal(state.history.at(-1).result.queue_paused, true);
  const bad = await fetch(baseUrl + '/api/board-agent/proposals/nope', { method: 'POST', headers: { 'x-todomd-token': token }, body: '{"accept":"true"}' }); assert.equal(bad.status, 400);
});

test('corrupt durable receipts fail closed without overwriting evidence', async (t) => {
  const directory = tmp('corrupt-agent'), file = path.join(directory, 'state.json');
  fs.writeFileSync(file, '{broken');
  const agent = createBoardAgent({ directory }); t.after(() => agent.close());
  assert.match(agent.publicState().storageError, /cannot be read/);
  assert.equal(agent.configure(rules()).ok, false);
  assert.equal((await agent.message('go')).ok, false);
  assert.equal(agent.stop().ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('watching responds to changed selected boards and ignores unchanged snapshots', async (t) => {
  let runs = 0;
  const runner = () => { runs++; return { child: null, done: Promise.resolve({ envelope: { structured_output: { reply: '', actions: [] } } }) }; };
  const { agent, repo } = fixture(t, { runner, watchDelayMs: 0 });
  agent.configure(rules({ contact: 'built_in', watch: true }));
  await new Promise((r) => setTimeout(r, 1650)); assert.equal(runs, 1);
  agent.changed('alpha'); await new Promise((r) => setTimeout(r, 1650)); assert.equal(runs, 1);
  writeCard(repo, 'task-0002', { title: 'New task' });
  agent.changed('beta'); await new Promise((r) => setTimeout(r, 1650)); assert.equal(runs, 1);
  agent.changed('alpha'); await new Promise((r) => setTimeout(r, 1650)); assert.equal(runs, 2);
  agent.stop(); agent.changed('alpha'); assert.equal(agent.publicState().config.watch, false);
});


test('stop also blocks later external actions until the user saves rules again', async (t) => {
  const { agent, calls } = fixture(t);
  agent.stop();
  assert.match((await agent.external({ action: 'pause_queue', project: 'alpha', request_id: 'stopped' })).error, /stopped/);
  assert.equal(calls.length, 0);
  assert.equal(agent.configure(rules()).ok, true);
  assert.equal((await agent.external({ action: 'pause_queue', project: 'alpha', request_id: 'resumed' })).ok, true);
});

test('switching scope starts fresh model context while preserving user-visible history', async (t) => {
  const { agent } = fixture(t);
  agent.reply({ text: 'Private alpha status', request_id: 'old' });
  agent.configure(rules({ boards: ['beta'] }));
  assert.equal(agent.context().history.length, 0);
  assert.ok(agent.publicState().history.some((h) => h.content === 'Private alpha status'));
});

test('oversized plan context always becomes a human exception', async (t) => {
  const { agent, repo } = fixture(t);
  agent.configure(rules({ allowedActions: ['approve'] }));
  writeCard(repo, 'task-0001', { status: 'Planned', body: 'Long plan '.repeat(1000) });
  assert.equal(agent.context().boards[0].cards[0].detailsTruncated, true);
  const result = await agent.external({ action: 'approve', project: 'alpha', card_id: 'task-0001', request_id: 'long-plan' });
  assert.ok(result.pending);
  assert.match(agent.publicState().pending[0].reason, /review the full card/);
});
