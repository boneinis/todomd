import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeRepo, writeCard, useFakeAgent, clearFakeAgent, until, tmp, BUDGET } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer, loadToken } from '../src/server.js';
import { resolveTier, createMcpServer } from '../src/mcp-server.js';
import * as pipeline from '../src/pipeline.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// loadToken() mints the token file on first read (same helper server.js uses).
function tokens() {
  const full = loadToken('token');
  const viewer = loadToken('token-viewer');
  return { full, viewer };
}

// budget mode: a move/status change just updates the board, it doesn't spawn
// a live agent run — keeps the write-tool round trip below free of a real
// `claude`/`codex` CLI dependency (same pattern test/server-routes.test.js uses)
function budgetRepo() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}

async function boot(makeFn = budgetRepo) {
  const repo = makeFn();
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  return { repo, name, srv, baseUrl, project: { name, path: repo } };
}

test('resolveTier: unauthenticated/unknown tokens are rejected', () => {
  isolateHome();
  tokens();
  assert.equal(resolveTier('not-a-real-token'), null);
  assert.equal(resolveTier(''), null);
});

test('resolveTier: full and viewer tokens map to their tiers', () => {
  isolateHome();
  const { full, viewer } = tokens();
  assert.equal(resolveTier(full), 'full');
  assert.equal(resolveTier(viewer), 'viewer');
});

test('initialize/tools/list JSON-RPC round trip', async () => {
  isolateHome();
  const { full } = tokens();
  const server = createMcpServer({ token: full, baseUrl: 'http://127.0.0.1:1' });
  const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'todomd');
  const list = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some((t) => t.name === 'get_board'));
  // a notification (no id) gets no reply
  const notified = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified, null);
});

test('get_run_state preserves the board transport diagnostic when the server is unreachable', async () => {
  isolateHome();
  const { full } = tokens();
  const server = createMcpServer({ token: full, baseUrl: 'http://127.0.0.1:1' });

  const result = await server.callTool('get_run_state', { project: 'missing-server' });

  assert.equal(result.isError, true);
  const diagnostic = JSON.parse(result.content[0].text);
  assert.match(diagnostic.error, /connect|fetch|refused|failed/i);
});

test('viewer tier: read tools work against the running server, write tools are hidden and refused', async () => {
  isolateHome();
  tokens();
  const { name, srv, baseUrl } = await boot();
  try {
    const server = createMcpServer({ token: loadToken('token-viewer'), baseUrl });

    const names = server.listTools().map((t) => t.name);
    assert.ok(names.includes('get_board'));
    assert.ok(!names.includes('create_card'), 'write tool must not be advertised to a viewer session');

    const board = await server.callTool('get_board', { project: name });
    assert.equal(board.isError, false);
    const boardResult = JSON.parse(board.content[0].text);
    assert.ok(Array.isArray(boardResult.cards));

    // hidden from tools/list, but still refused if called directly — the
    // client-side filter is UX, not the actual boundary
    const denied = await server.callTool('create_card', { project: name, title: 'nope' });
    assert.equal(denied.isError, true);
    assert.match(JSON.parse(denied.content[0].text).error, /full access required/);
  } finally { srv.close(); }
});

test('full tier: create, move, assign, retry-verify guard, cancel, and archive round-trip against the running server', async () => {
  isolateHome();
  const { full } = tokens();
  const { name, srv, baseUrl } = await boot();
  try {
    const server = createMcpServer({ token: full, baseUrl });

    const created = await server.callTool('create_card', { project: name, title: 'MCP round trip', description: 'covers the write tools' });
    const createResult = JSON.parse(created.content[0].text);
    assert.equal(createResult.ok, true);
    const id = createResult.id;

    // POST /api/cards kicks off maybeTriage() fire-and-forget, and that claims
    // the card *before* it reads config — so even with triage disabled there's
    // a window where humanMove() answers "run in progress". Wait it out with
    // the helper the drawer uses for the same race (pipeline.js:1780), rather
    // than smuggling an off-schema `triaged` field past the tool's contract.
    await pipeline.waitForTriage(name, id);

    const moved = await server.callTool('move_card', { project: name, id, status: 'Plan' });
    assert.equal(JSON.parse(moved.content[0].text).ok, true);

    const assigned = await server.callTool('assign_card', { project: name, id, assignee: 'alice' });
    assert.equal(JSON.parse(assigned.content[0].text).ok, true);

    const card = await server.callTool('get_card', { project: name, id });
    assert.equal(JSON.parse(card.content[0].text).data.assignee, 'alice');

    // no run in flight — retry-verify is expected to fail cleanly, not throw
    const retried = await server.callTool('retry_verify', { project: name, id });
    assert.equal(retried.isError, true);

    const cancelled = await server.callTool('cancel_card', { project: name, id });
    assert.equal(cancelled.isError, true); // nothing running to cancel — same clean failure

    const archived = await server.callTool('archive_card', { project: name, id, archived: true });
    assert.equal(JSON.parse(archived.content[0].text).ok, true);
  } finally { srv.close(); }
});

test('tool arguments are validated against the advertised schema before dispatch', async () => {
  isolateHome();
  const { full } = tokens();
  const { name, repo, srv, baseUrl } = await boot();
  writeCard(repo, 'task-0001'); // a real target, so a rejection can't be mistaken for "no such card"
  try {
    const server = createMcpServer({ token: full, baseUrl });
    const rejected = async (tool, args, re) => {
      const r = await server.callTool(tool, args);
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} must be rejected`);
      assert.match(JSON.parse(r.content[0].text).error, re);
    };

    // POST /api/cards is a trusted-caller route that honours internal
    // orchestrator fields for the Plan stage's chunk creator — an MCP caller
    // must not reach them and mint a card that skips triage/build/verify
    await rejected('create_card', { project: name, title: 'born done', status: 'Done' }, /unknown property: status/);
    await rejected('create_card', { project: name, title: 'pre-triaged', triaged: '2026-01-01' }, /unknown property: triaged/);
    await rejected('create_card', { project: name, title: 'as agent', agent: 'codex', plan: 'x' }, /unknown property: (agent|plan)/);
    await rejected('create_card', { project: name, description: 'no title given' }, /missing required property: title/);
    await rejected('move_card', { project: name, id: 'task-0001', status: 'Done', force: true }, /unknown property: force/);

    // types are checked without coercion: the string "false" is not `false`,
    // and archiving a card the caller asked to *un*archive is not a no-op
    await rejected('archive_card', { project: name, id: 'task-0001', archived: 'false' }, /property archived must be a boolean/);
    await rejected('get_board', { project: name, includeArchived: 'yes' }, /property includeArchived must be a boolean/);
    await rejected('create_card', { project: name, title: 'bad labels', labels: 'urgent' }, /property labels must be an array/);
    await rejected('create_card', { project: name, title: 'bad criteria', criteria: [1, 2] }, /property criteria must be an array of strings/);
    await rejected('get_card', { project: name, id: 1 }, /property id must be a string/);
    await rejected('get_board', 'not-an-object', /arguments must be an object/);

    // end state: nothing above reached the board — no card was created, and
    // task-0001 is neither moved nor archived (archived cards drop off here)
    const board = JSON.parse((await server.callTool('get_board', { project: name })).content[0].text);
    assert.deepEqual(board.cards.map((c) => c.id), ['task-0001']);
    assert.equal(board.cards[0].status, 'Review');
  } finally { srv.close(); }
});

test('cross-project access is blocked for an unregistered project name', async () => {
  isolateHome();
  const { full } = tokens();
  const { srv, baseUrl } = await boot();
  try {
    const server = createMcpServer({ token: full, baseUrl });
    const result = await server.callTool('get_board', { project: 'not-a-registered-project' });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /unknown project/);
  } finally { srv.close(); }
});

test('invalid or prefix-matching card ids are rejected by the server, not silently prefix-matched', async () => {
  isolateHome();
  const { full } = tokens();
  const { name, repo, srv, baseUrl } = await boot();
  writeCard(repo, 'task-0001'); // a real card "task" could wrongly prefix-match
  try {
    const server = createMcpServer({ token: full, baseUrl });
    // "task" would prefix-match a real card (e.g. task-0001) if a tool bypassed
    // the HTTP layer's CARD_ID check and called board.js's readCard() directly
    const r = await server.callTool('get_card', { project: name, id: 'task' });
    assert.equal(r.isError, true);
    assert.match(JSON.parse(r.content[0].text).error, /invalid card id/);

    for (const bad of ['..', 'task-0001.md', 'task-']) {
      const move = await server.callTool('move_card', { project: name, id: bad, status: 'Plan' });
      assert.equal(move.isError, true, `id ${bad} should be rejected`);
    }
  } finally { srv.close(); }
});

test('a separate MCP process sees run state and live-run guards owned by the server process', async () => {
  isolateHome();
  const { full } = tokens();
  const marker = path.join(tmp('mcp-stdio'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  const repo = makeRepo(); // launcher mode — humanMove(..., 'Queue') actually spawns a build
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const project = { name, path: repo };
  writeCard(repo, 'task-0001', { status: 'Queue' });
  let child;
  try {
    await pipeline.humanMove(project, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });

    // --port (not TODOMD_MCP_PORT) on purpose: it's the documented flag, and
    // with no server.pid in the isolated home a broken --port would fall back
    // to the default 7337 and fail every call below
    child = spawn(process.execPath, [path.join(ROOT, 'bin/todomd-mcp.js'), '--port', String(srv.port)], {
      env: { ...process.env, TODOMD_HOME: process.env.TODOMD_HOME, TODOMD_MCP_TOKEN: full, TODOMD_MCP_PORT: '', TODOMD_MCP_URL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    });
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_run_state', arguments: { project: name } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assign_card', arguments: { project: name, id: 'task-0001', assignee: 'alice' } } });

    await until(() => responses.has(1) && responses.has(2), { timeout: BUDGET.stage });

    const runStateResult = JSON.parse(responses.get(1).result.content[0].text);
    assert.ok(
      Object.keys(runStateResult.runStates || {}).length > 0,
      'a separate MCP process (its own pipeline.js memory) should still see the live run owned by the running server process',
    );

    const assignResult = responses.get(2);
    assert.equal(assignResult.result.isError, true, 'assigning a card mid-run must be blocked, the same as the HTTP /set route');
    assert.match(JSON.parse(assignResult.result.content[0].text).error, /run in progress/);
  } finally {
    child?.kill();
    await pipeline.humanMove(project, 'task-0001', 'Review').catch(() => {});
    srv.close();
    clearFakeAgent();
  }
});

test('Board Agent STDIO discovers only its scoped credential and revocation denies existing clients', async () => {
  isolateHome(); useFakeAgent();
  const { srv, name, baseUrl } = await boot();
  let child;
  try {
    const headers = { 'x-todomd-token': srv.token };
    await fetch(baseUrl + '/api/board-agent/config', { method: 'POST', headers, body: JSON.stringify({ boards: [name], contact: 'external', agent: 'claude', model: '', maxActionsPerTurn: 3, watch: false, instructions: '' }) });
    child = spawn(process.execPath, [path.join(ROOT, 'bin/todomd-mcp.js'), '--board-agent', '--port', String(srv.port)], {
      env: { ...process.env, TODOMD_MCP_TOKEN: '', TODOMD_MCP_PORT: '', TODOMD_MCP_URL: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => { const msg = JSON.parse(line); responses.set(msg.id, msg); });
    const send = (id, tool, args = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
    send(1, 'board_agent_overview'); await until(() => responses.has(1), { timeout: BUDGET.stage });
    assert.equal(responses.get(1).result.isError, false);
    const board = JSON.parse(responses.get(1).result.content[0].text).boards[0];
    send(2, 'board_agent_context', { board_id: board.board_id, session_id: 'codex-voice-test' });
    await until(() => responses.has(2)); assert.equal(responses.get(2).result.isError, false);
    send(3, 'board_agent_propose', { board_id: board.board_id, session_id: 'test', request_id: 'bad', action: 'deploy', why: 'bad enum' });
    await until(() => responses.has(3)); assert.equal(responses.get(3).result.isError, true);
    const revoke = await fetch(baseUrl + '/api/board-agent/connection/revoke', { method: 'POST', headers, body: '{}' }); assert.equal(revoke.status, 200);
    send(4, 'board_agent_overview'); await until(() => responses.has(4)); assert.equal(responses.get(4).result.isError, true);
    const fresh = createMcpServer({ token: loadToken('token-board-agent'), baseUrl });
    assert.equal(fresh.tier, 'agent'); assert.equal(fresh.listTools().length, 6);
    assert.equal((await fresh.callTool('board_agent_overview', {})).isError, false);
    assert.equal((await fresh.callTool('get_board', { project: name })).isError, true);
  } finally { child?.kill(); srv.close(); clearFakeAgent(); }
});
