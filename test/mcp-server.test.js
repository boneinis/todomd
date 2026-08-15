import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeRepo, writeCard, useFakeAgent, clearFakeAgent, until, tmp, git, BUDGET } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer, loadToken } from '../src/server.js';
import { resolveTier, resolveStartupCredential, discoverVerifiedBaseUrl, createMcpServer } from '../src/mcp-server.js';
import { enableControlApproval, disableControlApproval } from '../src/control-approval.js';
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
  const control = loadToken('token-control');
  return { full, viewer, control };
}

function writeServerIdentity(srv) {
  const file = path.join(process.env.TODOMD_HOME, '.todomd', 'server.pid');
  fs.writeFileSync(file, `${process.pid} ${srv.port} ${srv.instanceNonce}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function spawnMcp(args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/todomd-mcp.js'), ...args], {
    env: { ...process.env, TODOMD_HOME: process.env.TODOMD_HOME, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const errors = [];
  let nextId = 1;
  const out = readline.createInterface({ input: child.stdout });
  const err = readline.createInterface({ input: child.stderr });
  out.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  });
  err.on('line', (line) => errors.push(line));
  return {
    child,
    errors,
    async request(method, params = {}) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      await until(() => responses.has(id), { timeout: BUDGET.stage, label: `MCP response ${id} (${method})` });
      return responses.get(id);
    },
    async call(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, `JSON-RPC error for ${name}: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    close() {
      child.stdin.end();
      child.kill();
      out.close();
      err.close();
    },
  };
}

function resultJson(result) {
  return JSON.parse(result.content[0].text);
}

function seedPreservedVerification(repo, id) {
  const base = git(repo, ['branch', '--show-current']);
  const branch = `todomd/${id}`;
  const worktree = path.join(repo, '.todomd/worktrees', id);
  writeCard(repo, id, {
    status: 'Needs Human',
    extra: `needs_human_reason: bad_verdict\nsession_id: fake-session\nworktree: ${branch}\nbase_branch: ${base}\n`,
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `seed preserved verification ${id}`]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-q', worktree, '-b', branch]);
  return { branch, worktree };
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

test('--access viewer reads only the viewer token and ignores an inherited full token', () => {
  const home = isolateHome();
  const tokenDir = path.join(home, '.todomd');
  const viewer = '1'.repeat(32);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'token-viewer'), `${viewer}\n`, { mode: 0o600 });

  const credential = resolveStartupCredential({ access: 'viewer', envToken: '2'.repeat(32) });

  assert.deepEqual(credential, { token: viewer, tier: 'viewer' });
  assert.equal(fs.existsSync(path.join(tokenDir, 'token')), false, 'viewer startup must not read or mint the full token');
});

test('--access full reads only the dedicated control token file', () => {
  const home = isolateHome();
  const tokenDir = path.join(home, '.todomd');
  const control = '3'.repeat(32);
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'token-control'), `${control}\n`, { mode: 0o600 });

  const credential = resolveStartupCredential({ access: 'full' });

  assert.deepEqual(credential, { token: control, tier: 'full' });
  assert.equal(fs.existsSync(path.join(tokenDir, 'token')), false, 'full MCP startup must not read or mint the primary browser token');
  assert.equal(fs.existsSync(path.join(tokenDir, 'token-viewer')), false, 'full startup must not read or mint the viewer token');
});

test('--access fails closed for conflicts, invalid tiers, missing files, and malformed token files', () => {
  const home = isolateHome();
  const tokenDir = path.join(home, '.todomd');
  fs.mkdirSync(tokenDir, { recursive: true });

  assert.throws(
    () => resolveStartupCredential({ access: 'viewer', token: '4'.repeat(32) }),
    /either --access or --token/,
  );
  assert.throws(() => resolveStartupCredential({ access: 'admin' }), /viewer or full/);
  assert.throws(() => resolveStartupCredential({ access: 'viewer' }), /couldn't read viewer token file/);

  const malformed = 'do-not-leak-this-value';
  fs.writeFileSync(path.join(tokenDir, 'token-viewer'), `${malformed}\n`, { mode: 0o600 });
  assert.throws(
    () => resolveStartupCredential({ access: 'viewer' }),
    (error) => /invalid viewer token file/.test(error.message) && !error.message.includes(malformed),
  );
});

test('legacy --token and TODOMD_MCP_TOKEN credential paths remain compatible', () => {
  isolateHome();
  const { full, viewer } = tokens();

  assert.deepEqual(resolveStartupCredential({ token: full, envToken: '' }), { token: full, tier: 'full' });
  assert.deepEqual(resolveStartupCredential({ envToken: viewer }), { token: viewer, tier: 'viewer' });
});

test('stdio --access viewer hides write tools even when the inherited environment token is full', async () => {
  isolateHome();
  const { full } = tokens();
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/todomd-mcp.js'), '--access', 'viewer'], {
    env: { ...process.env, TODOMD_HOME: process.env.TODOMD_HOME, TODOMD_MCP_TOKEN: full },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) responses.set(msg.id, msg);
  });

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await until(() => responses.has(1), { timeout: BUDGET.stage });
    const names = responses.get(1).result.tools.map((tool) => tool.name);
    assert.ok(names.includes('get_board'));
    assert.ok(!names.includes('create_card'));
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('stdio rejects --access combined with --token before starting', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin/todomd-mcp.js'), '--access', 'viewer', '--token', '5'.repeat(32)],
    { encoding: 'utf8', env: { ...process.env, TODOMD_HOME: isolateHome() } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /either --access or --token/);
  assert.ok(!result.stderr.includes('5'.repeat(32)), 'the rejected token value must not be logged');
});

test('--access rejects explicit endpoints and verified discovery fails closed', async () => {
  const home = isolateHome();
  tokens();
  const combined = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin/todomd-mcp.js'), '--access', 'full', '--url', 'http://127.0.0.1:7337'],
    { encoding: 'utf8', env: { ...process.env, TODOMD_HOME: home } },
  );
  assert.equal(combined.status, 1);
  assert.match(combined.stderr, /cannot be combined with --url or --port/);

  await assert.rejects(() => discoverVerifiedBaseUrl(), /verify a running todomd server/);
  const identity = path.join(home, '.todomd', 'server.pid');
  fs.writeFileSync(identity, `${process.pid} 7337 ${'a'.repeat(32)}\n`, { mode: 0o644 });
  await assert.rejects(() => discoverVerifiedBaseUrl(), /verify a running todomd server/);
  fs.chmodSync(identity, 0o600);
  await assert.rejects(
    () => discoverVerifiedBaseUrl({ fetchImpl: async () => ({ ok: true, json: async () => ({ instanceNonce: 'b'.repeat(32) }) }) }),
    /identity did not match/,
  );
});

test('server identity uses a challenge proof without disclosing its protected nonce', async () => {
  isolateHome();
  tokens();
  const { srv, baseUrl } = await boot();
  try {
    const challenge = 'c'.repeat(64);
    const response = await fetch(`${baseUrl}/api/health?challenge=${challenge}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.proof, /^[a-f0-9]{64}$/);
    assert.equal(body.instanceNonce, undefined);
    assert.ok(!JSON.stringify(body).includes(srv.instanceNonce));
  } finally { srv.close(); }
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

test('legacy full token: create, move, assign, archive, and unarchive round-trip', async () => {
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

    const beforeMove = resultJson(await server.callTool('get_card', { project: name, id }));
    assert.equal(beforeMove.data.status, 'Review');
    const moved = await server.callTool('move_card', { project: name, id, status: 'Plan' });
    assert.equal(JSON.parse(moved.content[0].text).ok, true);
    const afterMove = resultJson(await server.callTool('get_card', { project: name, id }));
    assert.equal(afterMove.data.status, 'Plan');

    const beforeAssign = resultJson(await server.callTool('get_card', { project: name, id }));
    assert.equal(beforeAssign.data.assignee, null);
    const assigned = await server.callTool('assign_card', { project: name, id, assignee: 'alice' });
    assert.equal(JSON.parse(assigned.content[0].text).ok, true);

    const card = await server.callTool('get_card', { project: name, id });
    assert.equal(JSON.parse(card.content[0].text).data.assignee, 'alice');

    const archived = await server.callTool('archive_card', { project: name, id, archived: true });
    assert.equal(JSON.parse(archived.content[0].text).ok, true);
    const withArchived = resultJson(await server.callTool('get_board', { project: name, includeArchived: true }));
    assert.ok(withArchived.cards.find((item) => item.id === id)?.archived);

    const unarchived = await server.callTool('archive_card', { project: name, id, archived: false });
    assert.equal(resultJson(unarchived).ok, true);
    const afterUnarchive = resultJson(await server.callTool('get_board', { project: name }));
    assert.ok(afterUnarchive.cards.some((item) => item.id === id));
  } finally { srv.close(); }
});

test('installed stdio full access is lease-gated, ignores inherited endpoints, and verifies each board mutation', async () => {
  isolateHome();
  const { full } = tokens();
  const { name, srv } = await boot();
  writeServerIdentity(srv);
  const mcp = spawnMcp(['--access', 'full'], {
    // File-sourced access must ignore these inherited values and discover the
    // nonce-authenticated loopback process before sending token-control.
    TODOMD_MCP_URL: 'http://127.0.0.1:1',
    TODOMD_MCP_PORT: '1',
    TODOMD_MCP_TOKEN: full,
  });
  try {
    const listed = await mcp.request('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    for (const tool of ['create_card', 'move_card', 'assign_card', 'retry_verify', 'cancel_card', 'archive_card']) {
      assert.ok(names.includes(tool), `${tool} should be advertised for full access`);
    }

    const preBoard = resultJson(await mcp.call('get_board', { project: name }));
    assert.deepEqual(preBoard.cards, []);
    const gated = await mcp.call('create_card', { project: name, title: 'blocked without a lease' });
    assert.equal(gated.isError, true);
    assert.match(resultJson(gated).error, /control is disabled/);
    assert.deepEqual(resultJson(await mcp.call('get_board', { project: name })).cards, []);

    enableControlApproval({ minutes: 5 });
    const created = resultJson(await mcp.call('create_card', {
      project: name,
      title: 'Stdio mutation coverage',
      description: 'Every mutation has a before and after read.',
    }));
    assert.equal(created.ok, true);
    const id = created.id;
    await pipeline.waitForTriage(name, id);
    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.title, 'Stdio mutation coverage');

    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.status, 'Review');
    assert.equal(resultJson(await mcp.call('move_card', { project: name, id, status: 'Plan' })).ok, true);
    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.status, 'Plan');

    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.assignee, null);
    assert.equal(resultJson(await mcp.call('assign_card', { project: name, id, assignee: 'alice' })).ok, true);
    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.assignee, 'alice');

    const beforeArchive = resultJson(await mcp.call('get_board', { project: name }));
    assert.ok(beforeArchive.cards.some((card) => card.id === id));
    assert.equal(resultJson(await mcp.call('archive_card', { project: name, id, archived: true })).ok, true);
    const archived = resultJson(await mcp.call('get_board', { project: name, includeArchived: true }));
    assert.ok(archived.cards.find((card) => card.id === id)?.archived);

    assert.equal(resultJson(await mcp.call('archive_card', { project: name, id, archived: false })).ok, true);
    const afterUnarchive = resultJson(await mcp.call('get_board', { project: name }));
    assert.ok(afterUnarchive.cards.some((card) => card.id === id));

    disableControlApproval();
    const regated = await mcp.call('assign_card', { project: name, id, assignee: 'mallory' });
    assert.equal(regated.isError, true);
    assert.match(resultJson(regated).error, /control is disabled/);
    assert.equal(resultJson(await mcp.call('get_card', { project: name, id })).data.assignee, 'alice');
    assert.deepEqual(mcp.errors, []);
  } finally {
    disableControlApproval();
    mcp.close();
    srv.close();
  }
});

test('installed stdio full access successfully retries verification and cancels the live run with pre/post reads', async () => {
  isolateHome();
  tokens();
  useFakeAgent({ hang: 'verify' });
  const repo = makeRepo();
  const id = 'task-0001';
  seedPreservedVerification(repo, id);
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  writeServerIdentity(srv);
  enableControlApproval({ minutes: 5 });
  const mcp = spawnMcp(['--access', 'full']);
  const project = { name, path: repo };
  try {
    const beforeRetry = resultJson(await mcp.call('get_card', { project: name, id }));
    assert.equal(beforeRetry.data.status, 'Needs Human');
    assert.equal(beforeRetry.data.needs_human_reason, 'bad_verdict');

    const retried = resultJson(await mcp.call('retry_verify', { project: name, id }));
    assert.equal(retried.ok, true);
    await until(() => pipeline.hasLiveRun(name, id), { timeout: BUDGET.stage, label: 'retry verification live run' });
    const afterRetry = resultJson(await mcp.call('get_run_state', { project: name }));
    assert.equal(afterRetry.runStates[id]?.stage, 'Verify');

    const beforeCancel = resultJson(await mcp.call('get_card', { project: name, id }));
    assert.equal(beforeCancel.data.status, 'Verify');
    const cancelled = resultJson(await mcp.call('cancel_card', { project: name, id }));
    assert.equal(cancelled.ok, true);
    const afterCancel = resultJson(await mcp.call('get_card', { project: name, id }));
    assert.ok(['Verify', 'Queue'].includes(afterCancel.data.status));
  } finally {
    disableControlApproval();
    mcp.close();
    await pipeline.humanMove(project, id, 'Review').catch(() => {});
    await pipeline.killAllChildren({ graceMs: 1000 });
    srv.close();
    clearFakeAgent();
  }
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
    await rejected('archive_card', { project: name, id: 'task-0001' }, /missing required property: archived/);
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

test('attachment responses are capped before base64 expansion', async () => {
  isolateHome();
  const { full } = tokens();
  const { name, repo, srv, baseUrl } = await boot();
  const rel = '.todomd/attachments/task-0001/large.bin';
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  try {
    const server = createMcpServer({ token: full, baseUrl });
    const result = await server.callTool('get_card_file', { project: name, path: rel });
    assert.equal(result.isError, true);
    assert.match(resultJson(result).error, /2097152 byte MCP limit/);
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
