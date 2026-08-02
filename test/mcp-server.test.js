import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isolateHome, makeRepo } from './helpers.js';
import { addProject } from '../src/registry.js';
import { resolveTier, createMcpServer } from '../src/mcp-server.js';

const deviceToken = (name) => fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', name), 'utf8').trim();

// Reading either token file mints it (loadToken()'s side effect) — read the
// full token first so both files exist before a test asks for the tier.
function tokens() {
  const full = deviceToken('token');
  const viewer = deviceToken('token-viewer');
  return { full, viewer };
}

async function connectedClient(tier) {
  const server = createMcpServer(tier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
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

test('viewer tier: read tools work, write tools are hidden and refused', async () => {
  isolateHome();
  tokens();
  const repo = makeRepo();
  addProject(repo);
  const name = path.basename(repo);
  const { client } = await connectedClient('viewer');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('get_board'));
  assert.ok(!names.includes('create_card'), 'write tool must not be advertised to a viewer session');

  const board = await client.callTool({ name: 'get_board', arguments: { project: name } });
  assert.equal(board.isError, undefined);
  const boardResult = JSON.parse(board.content[0].text);
  assert.ok(Array.isArray(boardResult.cards));

  const denied = await client.callTool({ name: 'create_card', arguments: { project: name, title: 'nope' } });
  assert.equal(denied.isError, true);
  assert.match(JSON.parse(denied.content[0].text).error, /full access required/);
});

test('full tier: create, move, assign, retry-verify guard, cancel, and archive round-trip', async () => {
  isolateHome();
  tokens();
  const repo = makeRepo();
  addProject(repo);
  const name = path.basename(repo);
  const { client } = await connectedClient('full');

  const created = await client.callTool({
    name: 'create_card',
    arguments: { project: name, title: 'MCP round trip', description: 'covers the write tools' },
  });
  const createResult = JSON.parse(created.content[0].text);
  assert.equal(createResult.ok, true);
  const id = createResult.id;

  const moved = await client.callTool({ name: 'move_card', arguments: { project: name, id, status: 'Plan' } });
  assert.equal(JSON.parse(moved.content[0].text).ok, true);

  const assigned = await client.callTool({ name: 'assign_card', arguments: { project: name, id, assignee: 'alice' } });
  assert.equal(JSON.parse(assigned.content[0].text).ok, true);

  const card = await client.callTool({ name: 'get_card', arguments: { project: name, id } });
  assert.equal(JSON.parse(card.content[0].text).assignee, 'alice');

  // no run in flight — retry-verify is expected to fail cleanly, not throw
  const retried = await client.callTool({ name: 'retry_verify', arguments: { project: name, id } });
  assert.equal(retried.isError, true);

  const cancelled = await client.callTool({ name: 'cancel_card', arguments: { project: name, id } });
  assert.equal(cancelled.isError, true); // nothing running to cancel — same clean failure

  const archived = await client.callTool({ name: 'archive_card', arguments: { project: name, id, archived: true } });
  assert.equal(JSON.parse(archived.content[0].text).ok, true);
});

test('cross-project access is blocked for an unregistered project name', async () => {
  isolateHome();
  tokens();
  const { client } = await connectedClient('full');
  const result = await client.callTool({ name: 'get_board', arguments: { project: 'not-a-registered-project' } });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /unknown project/);
});
