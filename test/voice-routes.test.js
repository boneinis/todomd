import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';
import { readCard } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';

after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const deviceToken = (name) => fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', name), 'utf8').trim();

// budget mode: approving Planned -> Queue never spawns a real agent, so the
// HTTP-layer tests stay fast and side-effect-free like server-routes.test.js's boot().
function budgetRepo() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}
async function boot() {
  const repo = budgetRepo();
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${srv.port}`;
  return { repo, name, base, srv, q: `?project=${encodeURIComponent(name)}` };
}

test('GET /api/voice/summary and /api/voice/cards/:id are viewer-readable', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const viewer = deviceToken('token-viewer');
  try {
    writeCard(repo, 'task-0001', { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\n' });

    let r = await fetch(`${base}/api/voice/summary${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 200);
    const summary = await r.json();
    assert.match(summary.text, /task-0001 \(bad_verdict\)/);
    assert.deepEqual(summary.needsHuman.map((n) => n.id), ['task-0001']);

    r = await fetch(`${base}/api/voice/cards/task-0001${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 200);
    assert.match((await r.json()).text, /Needs Human/);

    r = await fetch(`${base}/api/voice/cards/task-9999${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 404);

    // no token at all → 401, same as every other API route
    assert.equal((await fetch(`${base}/api/voice/summary${q}`)).status, 401);
  } finally { srv.close(); }
});

test('voice actions require the PRIMARY desktop session, not just full access', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const tok = srv.token, mobile = deviceToken('token-mobile'), viewer = deviceToken('token-viewer');
  const h = (t) => ({ 'x-todomd-token': t, 'content-type': 'application/json', origin: base });
  try {
    writeCard(repo, 'task-0001', { status: 'Planned' });

    // viewer is read-only generically → 403 before even reaching the route
    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h(viewer), body: JSON.stringify({ cardId: 'task-0001', action: 'retriage' }) });
    assert.equal(r.status, 403);

    // mobile has full mutation access elsewhere, but not for voice
    r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h(mobile), body: JSON.stringify({ cardId: 'task-0001', action: 'retriage' }) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /primary desktop session/);

    // the primary desktop token may prepare
    r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h(tok), body: JSON.stringify({ cardId: 'task-0001', action: 'retriage' }) });
    assert.equal(r.status, 200);
    const { proposalId } = await r.json();

    // confirm/reject are gated the same way
    r = await fetch(`${base}/api/voice/actions/${proposalId}/confirm${q}`, { method: 'POST', headers: h(mobile), body: JSON.stringify({ confirmation: 'Yes To-do' }) });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/voice/actions/${proposalId}/reject${q}`, { method: 'POST', headers: h(mobile), body: '{}' });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('full prepare → confirm round trip over HTTP moves the card exactly once', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const tok = srv.token;
  const h = { 'x-todomd-token': tok, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned' });

    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'retriage' }) });
    assert.equal(r.status, 200);
    const prep = await r.json();
    assert.equal(prep.confirmation.tier, 'reversible');
    assert.equal(prep.cardId, 'task-0001');

    // The filename slug is a readCard alias for the same physical card; the
    // HTTP API canonicalizes it and refuses a concurrent second proposal.
    r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001-card', action: 'retriage' }) });
    assert.equal(r.status, 409);

    // wrong phrase → 400, board untouched
    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'nah' }) });
    assert.equal(r.status, 400);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Planned');
    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ confirmation: { toString: null, valueOf: null } }),
    });
    assert.equal(r.status, 400, 'hostile non-string confirmation is refused without HTTP 500');

    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'Yes To-do' }) });
    assert.equal(r.status, 200);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Review');

    // replay over HTTP → 404 (already used)
    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'Yes To-do' }) });
    assert.equal(r.status, 404);

    // unknown/disallowed action → 400, never routed to a card mutation
    r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'delete' }) });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

test('voice action routes reject null and prototype-property actions without HTTP 500', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Build' });
    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: 'null' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/voice/actions${q}`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ cardId: 'task-0001', action: 'toString' }),
    });
    assert.equal(r.status, 400);
    for (const hostile of [
      { cardId: { toString: null, valueOf: null }, action: 'retriage' },
      { cardId: 'task-0001', action: { toString: null, valueOf: null } },
    ]) {
      r = await fetch(`${base}/api/voice/actions${q}`, {
        method: 'POST', headers: h, body: JSON.stringify(hostile),
      });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /must be strings/);
    }
  } finally { srv.close(); }
});

test('archived cards must be restored before operational voice actions', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned', extra: 'archived: true\n' });

    let r = await fetch(`${base}/api/voice/actions${q}`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ cardId: 'task-0001', action: 'approve' }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /archived.*restore/);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Planned');

    r = await fetch(`${base}/api/voice/actions${q}`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ cardId: 'task-0001', action: 'unarchive' }),
    });
    assert.equal(r.status, 200);
    const prep = await r.json();
    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, {
      method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'Yes To-do' }),
    });
    assert.equal(r.status, 200);
    assert.equal(readCard(repo, 'task-0001').data.archived, undefined);
  } finally { srv.close(); }
});

test('reject endpoint over HTTP: consumes the proposal, never executes it', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Review' });
    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'archive' }) });
    const prep = await r.json();

    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/reject${q}`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).rejected, true);
    assert.equal(readCard(repo, 'task-0001').data.archived, undefined, 'rejected proposal never archived the card');

    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ visibleApproval: true }) });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});

test('an epic with unfinished children cannot be retriaged, approved, or archived by voice', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned', extra: 'epic: true\n' });
    writeCard(repo, 'task-0002', { status: 'Planned', extra: 'parent: task-0001\n' });

    // Review/archive would clean up the child and approve would release it.
    // Voice must not make any of those multi-card changes.
    for (const action of ['retriage', 'approve', 'archive']) {
      const r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action }) });
      assert.equal(r.status, 400, action);
      const body = await r.json();
      assert.match(body.error, /epic with 1 unfinished child card/);
      assert.equal(body.proposalId, undefined, 'no proposal is handed back at all');
    }
    assert.equal(readCard(repo, 'task-0002').data.status, 'Planned');
    assert.equal(readCard(repo, 'task-0002').data.archived, undefined);
  } finally { srv.close(); }
});

test('the read-back over HTTP describes what this project mode actually does', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot(); // boot() is a budget-mode repo
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned' });
    const r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'approve' }) });
    assert.equal(r.status, 200);
    const prep = await r.json();
    assert.equal(prep.readback, 'approve task-0001 and queue it for the dispatcher',
      'budget mode has no launcher — promising "start the build" would be a false read-back');
    assert.equal(prep.confirmation.tier, 'agent');
  } finally { srv.close(); }
});

test('a preserved worktree raises a move to visible approval and is named in the read-back', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\nworktree: todomd/task-0001\n' });

    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'retry_planned' }) });
    assert.equal(r.status, 200);
    const prep = await r.json();
    assert.match(prep.readback, /discarding its preserved worktree/);
    assert.equal(prep.confirmation.tier, 'visible');

    // the reversible phrase cannot authorize it
    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'Yes To-do' }) });
    assert.equal(r.status, 400);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Needs Human');
  } finally { srv.close(); }
});

test('removing a project invalidates its pending voice proposals, even if the freed name is reused', async () => {
  isolateHome();
  const { repo, name, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned' });
    let r = await fetch(`${base}/api/voice/actions${q}`, { method: 'POST', headers: h, body: JSON.stringify({ cardId: 'task-0001', action: 'retriage' }) });
    assert.equal(r.status, 200);
    const prep = await r.json();

    r = await fetch(`${base}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE', headers: h });
    assert.equal(r.status, 200);

    // re-registering the SAME repository gets the same (freed) name back
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: h, body: JSON.stringify({ path: repo }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).name, name);

    r = await fetch(`${base}/api/voice/actions/${prep.proposalId}/confirm${q}`, { method: 'POST', headers: h, body: JSON.stringify({ confirmation: 'Yes To-do' }) });
    assert.equal(r.status, 404, 'the proposal from before removal must not survive re-registration');
    assert.equal(readCard(repo, 'task-0001').data.status, 'Planned');
  } finally { srv.close(); }
});
