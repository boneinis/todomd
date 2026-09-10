import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { startServer } from '../src/server.js';
import { addProject } from '../src/registry.js';

async function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('delivery-lifecycle: full end-to-end delivery workflow API lifecycle', async () => {
  const home = isolateHome();
  const repo = makeRepo();
  const pname = path.basename(repo);
  addProject(repo);

  writeCard(repo, 'task-001', { status: 'Plan', title: 'Feature task' });
  writeCard(repo, 'task-002', { status: 'Review', title: 'Investigation task' });

  const port = await freePort();
  const server = await startServer({ port });
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();

  const api = async (endpoint, options = {}) => {
    const res = await fetch(`${base}${endpoint}${endpoint.includes('?') ? '&' : '?'}project=${encodeURIComponent(pname)}&token=${token}`, {
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
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

    // 6. Transition task-001 to ready
    const transReady = await api('/api/cards/task-001/delivery-transition', {
      method: 'POST',
      body: JSON.stringify({ to: 'ready', reason: 'Refinement complete' }),
    });
    assert.equal(transReady.status, 200);

    // 7. Assign implementation role
    const assign = await api('/api/cards/task-001/delivery-assign', {
      method: 'POST',
      body: JSON.stringify({ role: 'implementation', owner: 'agent-role:todomd-maintainer' }),
    });
    assert.equal(assign.status, 200);

    // 8. Declare a blocker on task-001
    const block = await api('/api/cards/task-001/delivery-blocker', {
      method: 'POST',
      body: JSON.stringify({
        category: 'product_decision',
        reason: 'Need UI confirmation',
        owner: 'human:project-owner',
      }),
    });
    assert.equal(block.status, 200);
    assert.equal(block.data.blocker.category, 'product_decision');

    // 9. Resolve the blocker
    const resolve = await api('/api/cards/task-001/delivery-blocker', {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve' }),
    });
    assert.equal(resolve.status, 200);

    // 10. Transition to in_review
    const transReview = await api('/api/cards/task-001/delivery-transition', {
      method: 'POST',
      body: JSON.stringify({ to: 'in_review', reason: 'Implementation ready for review' }),
    });
    assert.equal(transReview.status, 200);

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
    assert.equal(transReleased.status, 200);

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
    assert.equal(board.data.columns.released.length, 1);
    assert.equal(board.data.columns.released[0].id, 'task-001');
    assert.equal(board.data.releases.length, 1);
  } finally {
    server.close();
  }
});
