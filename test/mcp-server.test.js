import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';
import { addProject } from '../src/registry.js';
import { loadToken } from '../src/server.js';
import { resolveTier, createMcpServer } from '../src/mcp-server.js';

// budget mode: a move/status change just updates the board, it doesn't spawn
// a live agent run — keeps the write-tool round trip below free of a real
// `claude`/`codex` CLI dependency (same pattern test/server-routes.test.js uses)
function budgetRepo() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}

// loadToken() mints the token file on first read (same helper server.js uses).
function tokens() {
  const full = loadToken('token');
  const viewer = loadToken('token-viewer');
  return { full, viewer };
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
  tokens();
  const server = createMcpServer('full');
  const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'todomd');
  const list = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some((t) => t.name === 'get_board'));
  // a notification (no id) gets no reply
  const notified = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified, null);
});

test('viewer tier: read tools work, write tools are hidden and refused', async () => {
  isolateHome();
  tokens();
  const repo = makeRepo();
  addProject(repo);
  const name = path.basename(repo);
  const server = createMcpServer('viewer');

  const names = server.listTools().map((t) => t.name);
  assert.ok(names.includes('get_board'));
  assert.ok(!names.includes('create_card'), 'write tool must not be advertised to a viewer session');

  const board = await server.callTool('get_board', { project: name });
  assert.equal(board.isError, false);
  const boardResult = JSON.parse(board.content[0].text);
  assert.ok(Array.isArray(boardResult.cards));

  const denied = await server.callTool('create_card', { project: name, title: 'nope' });
  assert.equal(denied.isError, true);
  assert.match(JSON.parse(denied.content[0].text).error, /full access required/);
});

test('full tier: create, move, assign, retry-verify guard, cancel, and archive round-trip', async () => {
  isolateHome();
  tokens();
  const repo = budgetRepo();
  addProject(repo);
  const name = path.basename(repo);
  const server = createMcpServer('full');

  // triaged: set so the fire-and-forget maybeTriage() claim (same one server.js's
  // POST /api/cards kicks off) doesn't race the very next move_card call below
  const created = await server.callTool('create_card', { project: name, title: 'MCP round trip', description: 'covers the write tools', triaged: 'test' });
  const createResult = JSON.parse(created.content[0].text);
  assert.equal(createResult.ok, true);
  const id = createResult.id;

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
});

test('cross-project access is blocked for an unregistered project name', async () => {
  isolateHome();
  tokens();
  const server = createMcpServer('full');
  const result = await server.callTool('get_board', { project: 'not-a-registered-project' });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /unknown project/);
});
