import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { startServer } from '../src/server.js';
import { addProject } from '../src/registry.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { readCard, patchFrontmatter } from '../src/board.js';
import { migrateDeliveryBoard } from '../src/delivery-migration.js';
import { seedDelivery } from './delivery-fixture.js';
import { createHash } from 'node:crypto';

async function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('delivery-lifecycle: metadata API lifecycle preserves authority and rejects unsupported release claims', async () => {
  const home = isolateHome();
  const repo = makeRepo();
  const pname = path.basename(repo);
  addProject(repo);

  writeCard(repo, 'task-001', { status: 'Review', title: 'Feature task' });
  writeCard(repo, 'task-002', { status: 'Review', title: 'Investigation task' });

  const port = await freePort();
  const server = await startServer({ port });
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();

  const deliveryToken = createDeliveryAccess(repo, { enabled: true }).issue({ expected_revision: 0, actor_id: 'human:project-owner', operator: true, ttl_ms: 60000 }).token;
  let sequence = 0;
  const api = async (endpoint, options = {}) => {
    const taskId = endpoint.match(/^\/api\/cards\/([^/]+)\/delivery-/)?.[1];
    if (taskId && options.body) options.body = JSON.stringify({ ...JSON.parse(options.body), expected_revision: createDeliveryStore(deliveryStoreDirectory(repo)).read(taskId).revision, idempotency_key: `lifecycle-${++sequence}` });
    const res = await fetch(`${base}${endpoint}${endpoint.includes('?') ? '&' : '?'}project=${encodeURIComponent(pname)}&token=${token}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-todomd-delivery-token': deliveryToken,
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, ok: res.ok, data: JSON.parse(text) };
    } catch {
      return { status: res.status, ok: res.ok, text };
    }
  };

  try {
    // 1. Initial preview
    const prev = await api('/api/delivery/preview');
    assert.equal(prev.status, 200);
    assert.equal(prev.data.counts.total, 2);

    // 2. Migrate board to delivery mode
    const mig = await api('/api/delivery/migrate', {
      method: 'POST',
      body: JSON.stringify({ confirmExternalQuiescence: true }),
    });
    assert.equal(mig.status, 200);
    assert.equal(mig.data.ok, true);

    // 3. Verify delivery board projection
    let board = await api('/api/delivery/board');
    assert.equal(board.status, 200);
    assert.equal(board.data.mode, 'delivery');
    assert.ok(board.data.columns.backlog);
    assert.ok(board.data.wip_status);

    // 4. Create a cycle
    const cyc = await api('/api/delivery/cycles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Sprint Alpha',
        goal: 'Deliver first milestone',
        start_date: '2026-09-01T00:00:00Z',
        end_date: '2026-09-08T00:00:00Z',
        scope: ['task-001'],
      }),
    });
    assert.equal(cyc.status, 200);
    const cycleId = cyc.data.cycle.id;

    // 5. Update cycle scope
    const scopeUp = await api(`/api/delivery/cycles/${cycleId}/scope`, {
      method: 'POST',
      body: JSON.stringify({
        add: ['task-002'],
        reason: 'Include investigation in Alpha',
      }),
    });
    assert.equal(scopeUp.status, 200);
    assert.ok(scopeUp.data.cycle.scope.includes('task-002'));

    // 6. Missing planning evidence cannot be invented by the HTTP adapter
    const transReady = await api('/api/cards/task-001/delivery-transition', {
      method: 'POST',
      body: JSON.stringify({ to: 'ready', reason: 'Refinement complete' }),
    });
    assert.equal(transReady.status, 409);

    // 7. Assign implementation role
    const assign = await api('/api/cards/task-001/delivery-assign', {
      method: 'POST',
      body: JSON.stringify({ role: 'implementation', owner: 'agent-role:replacement', handoff: { evidence: 'Reassigned work', next_action: 'Prepare plan' } }),
    });
    assert.equal(assign.status, 200);

    // 8. Declare a blocker on task-001
    const block = await api('/api/cards/task-001/delivery-blocker', {
      method: 'POST',
      body: JSON.stringify({ blocker: { category: 'product_decision', evidence: 'Need UI confirmation', owner: 'human:project-owner', next_action: 'Review UI', since: new Date().toISOString() } }),
    });
    assert.equal(block.status, 200, JSON.stringify(block.data));
    assert.equal(createDeliveryStore(deliveryStoreDirectory(repo)).read('task-001').task.blocker.category, 'product_decision');

    // 9. Resolve the blocker
    const resolve = await api('/api/cards/task-001/delivery-blocker', {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', handoff: { evidence: 'UI approved', next_action: 'Prepare plan' } }),
    });
    assert.equal(resolve.status, 200);

    // 10. Transition to in_review
    const transReview = await api('/api/cards/task-001/delivery-transition', {
      method: 'POST',
      body: JSON.stringify({ to: 'in_review', reason: 'Implementation ready for review' }),
    });
    assert.equal(transReview.status, 409);

    // 11. Record a release
    const dummyCommit = '1111222233334444555566667777888899990000';
    const rel = await api('/api/delivery/releases', {
      method: 'POST',
      body: JSON.stringify({
        schema_version: 2,
        release_id: 'rel-alpha-1',
        environment: 'production',
        tasks: ['task-001'],
        deployed_commit: dummyCommit,
        target_branch: 'main',
        approval: { approver: 'human:project-owner', approved_at: new Date().toISOString() },
        deployment: { deployed: true, result: 'success', reference: 'dep-1' },
        verification: { verified: true, reference: 'verified-1' },
      }),
    });
    assert.equal(rel.status, 200);

    // 12. Transition to released
    const transReleased = await api('/api/cards/task-001/delivery-transition', {
      method: 'POST',
      body: JSON.stringify({ to: 'released', reason: 'Verified in production' }),
    });
    assert.equal(transReleased.status, 409);
    assert.equal(createDeliveryStore(deliveryStoreDirectory(repo)).read('task-001').task.delivery.state, 'backlog');

    // 13. Close cycle
    const close = await api(`/api/delivery/cycles/${cycleId}/close`, {
      method: 'POST',
      body: JSON.stringify({ return_to_backlog: ['task-002'], reason: 'Cycle finished' }),
    });
    assert.equal(close.status, 200);
    assert.equal(close.data.cycle.status, 'closed');

    // 14. Final board projection check
    board = await api('/api/delivery/board');
    assert.equal(board.status, 200);
    assert.equal(board.data.columns.released.length, 0);
    assert.equal(board.data.columns.backlog.find(c => c.id === 'task-001').ownership.implementation, 'agent-role:replacement');
    assert.equal(board.data.releases.length, 1);
  } finally {
    server.close();
  }
});

test('delivery mutations enforce identity, revision, evidence, leases and canonical projection', async () => {
  const home = isolateHome(), repo = makeRepo();
  for (const id of ['task-001', 'task-002']) writeCard(repo, id, { status: 'Review' });
  assert.equal(migrateDeliveryBoard(repo).ok, true);
  addProject(repo);
  const access = createDeliveryAccess(repo, { enabled: true });
  const owner = access.issue({ expected_revision: 0, actor_id: 'human:project-owner', operator: true, ttl_ms: 60000 });
  const outsider = access.issue({ expected_revision: 1, actor_id: 'human:outsider', ttl_ms: 60000 });
  const port = await freePort(), server = await startServer({ port });
  const token = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();
  const store = createDeliveryStore(deliveryStoreDirectory(repo));
  const raw = readCard(repo, 'task-001').raw;
  const read = async endpoint => {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}?project=${encodeURIComponent(path.basename(repo))}`, { headers: { 'x-todomd-token': token } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const post = async (action, body, credential = owner.token, id = 'task-001') => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cards/${id}/delivery-${action}?project=${encodeURIComponent(path.basename(repo))}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-todomd-token': token, 'x-todomd-delivery-token': credential }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    const release = { to: 'released', expected_revision: 1, idempotency_key: 'release' };
    assert.equal((await post('transition', release, '')).status, 401);
    assert.equal((await post('transition', release)).data.code, 'invalid_transition');
    assert.equal((await post('transition', { ...release, to: 'bogus' })).data.code, 'unsupported_transition');
    assert.equal((await post('transition', { to: 'cancelled', reason: 'Withdraw' })).data.code, 'invalid_request');
    const command = { ownership: { implementation: 'agent-role:new-builder', reviewer: 'agent-role:new-reviewer' },
      handoff: { evidence: 'Team changed', next_action: 'Refine task' }, expected_revision: 1, idempotency_key: 'assign' };
    assert.equal((await post('assign', command, outsider.token)).status, 403);
    const assigned = await post('assign', command);
    assert.equal(assigned.status, 200, JSON.stringify(assigned));
    assert.equal(assigned.data.revision, 2);
    assert.equal((await post('assign', command)).data.replayed, true);
    assert.equal((await post('assign', { ...command, idempotency_key: 'stale' })).data.code, 'stale_revision');
    assert.equal((await post('assign', { ...command, ownership: { implementation: 'same', reviewer: 'same' }, expected_revision: 2, idempotency_key: 'invalid-owner' })).status, 409);
    const blocker = { category: 'dependency', evidence: 'Wait for API', next_action: 'Approve contract', owner: 'human:project-owner', since: new Date().toISOString() };
    const blocked = await post('blocker', { blocker, expected_revision: 2, idempotency_key: 'block' });
    assert.equal(blocked.status, 200, JSON.stringify(blocked));
    assert.deepEqual(store.read('task-001').task.blocker, blocker);
    assert.deepEqual((await read('/api/cards/task-001')).data.blocker, blocker);
    assert.equal((await read('/api/delivery/board')).cards.find(c => c.id === 'task-001').ownership.implementation, 'agent-role:new-builder');
    const resolved = await post('blocker', { action: 'resolve', handoff: { evidence: 'API agreed', next_action: 'Implement' }, expected_revision: 3, idempotency_key: 'resolve' });
    assert.equal(resolved.status, 200);
    assert.equal((await read('/api/cards/task-001')).data.blocker, undefined);
    const cancelled = await post('transition', { to: 'cancelled', reason: 'No longer needed', expected_revision: 4, idempotency_key: 'cancel' });
    assert.equal(cancelled.status, 200);
    assert.equal((await read('/api/board')).cards.find(c => c.id === 'task-001').delivery.state, 'cancelled');
    assert.equal(store.read('task-001').revision, 5);
    assert.equal(readCard(repo, 'task-001').raw, raw);
    assert.equal(store.read('task-001').source_revision, createHash('sha256').update(raw).digest('hex'));
    assert.equal((await patchFrontmatter(repo, 'task-001', { delivery: { state: 'released' } })).code, 'delivery_managed');
    assert.equal((await patchFrontmatter(repo, 'task-001', { blocker: null, title: 'bypass' })).code, 'delivery_managed');
    // An expired but unreleased execution still vetoes every metadata action.
    fs.unlinkSync(path.join(deliveryStoreDirectory(repo), 'task-002.json'));
    seedDelivery(repo, 'task-002', { leased: true });
    const held = await post('assign', { ...command, expected_revision: 3 }, owner.token, 'task-002');
    assert.equal(held.data.code, 'active_work');
    assert.equal(store.read('task-002').revision, 3);
    access.revoke({ expected_revision: 2, credential_id: owner.credential_id });
    assert.equal((await post('assign', command)).status, 401);
  } finally { server.close(); }
});

test('release API rejects traversal with a full token and preserves an existing outside JSON file', async () => {
  const home = isolateHome(), repo = makeRepo(); addProject(repo);
  const file = path.join(repo, 'sentinel.json'); fs.writeFileSync(file, 'original');
  const port = await freePort(), server = await startServer({ port });
  try {
    const token = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/delivery/releases?project=${encodeURIComponent(path.basename(repo))}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-todomd-token': token },
      body: JSON.stringify({ schema_version: 2, release_id: '../../sentinel', environment: 'production', tasks: ['task-001'], deployed_commit: 'a'.repeat(40), target_branch: 'main',
        approval: { approver: 'human:owner', approved_at: '2026-09-10T00:00:00Z' }, deployment: { deployed: true, reference: 'fixture' }, verification: { verified: true, reference: 'fixture' } }),
    });
    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  } finally { server.close(); }
});
