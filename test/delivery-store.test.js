import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmp, makeRepo, writeCard, isolateHome } from './helpers.js';
import { createDeliveryStore } from '../src/delivery-store.js';

const id = 'task-0001';
const head = 'a'.repeat(40);
const baseTask = () => ({ id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'released', target_environment: 'production' },
  ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' } });
const authority = () => ({ actor_id: 'human:owner', busy: false,
  grants: ['initialize', 'assign', 'acquire', 'renew', 'release', 'block', 'resolve', 'ready', 'in_progress', 'in_review', 'backlog', 'cancelled', 'released', 'ready_to_release'].map(a => `delivery:${a}`),
  facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])),
    admission: { authorized: true, dependencies_satisfied: true, owner: 'agent-role:builder' },
    candidate: { head, preserved: true, clean: true, run_id: 'run-1' } } });
function fixture() {
  const dir = path.join(tmp('delivery-store'), 'private');
  let time = 1000, context = authority(), counter = 0;
  const store = () => createDeliveryStore(dir, { enabled: true, now: () => time, resolveContext: () => context });
  const send = (action, fields = {}) => store().execute(id, { action, idempotency_key: `key-${++counter}`, expected_revision: store().read(id)?.revision || 0, ...fields });
  const init = () => send('initialize', { task: baseTask(), source_revision: 'a'.repeat(64) });
  const ready = () => send('transition', { to: 'ready' });
  const acquire = (fields = {}) => send('acquire', { run_id: `run-${counter + 1}`, ttl_ms: 1000, ...fields });
  const ref = lease => ({ lease_id: lease.id, fence: lease.fence, run_id: lease.run_id });
  const release = lease => {
    context.stopped = { ...ref(lease), confirmed: true, reference: 'runner:confirmed-stopped' };
    return send('release', { ...ref(lease), handoff: { evidence: 'candidate:abc', next_action: 'Review the preserved candidate' } });
  };
  return { dir, store, send, init, ready, acquire, release, ref,
    get context() { return context; }, set context(value) { context = value; },
    get time() { return time; }, set time(value) { time = value; } };
}

test('disabled store performs no writes; invalid requests cannot escape its directory', () => {
  const f = fixture();
  assert.equal(createDeliveryStore(f.dir).execute(id, {}).code, 'disabled');
  assert.equal(fs.existsSync(f.dir), false);
  for (const bad of ['../escape', '/tmp/task', '..', '']) {
    assert.equal(f.store().execute(bad, { action: 'initialize', expected_revision: 0, idempotency_key: 'key' }).code, 'invalid_request');
  }
  assert.equal(fs.existsSync(f.dir), false);
  f.context.grants = [];
  assert.equal(f.init().code, 'not_authorized');
  assert.equal(f.store().read(id), null);
});

test('initialization accepts Backlog intent only, leaving Markdown unchanged', () => {
  isolateHome(); const repo = makeRepo(); writeCard(repo, id, { status: 'Needs Human' });
  const card = path.join(repo, '.todomd/tasks/task-0001-card.md');
  const before = fs.readFileSync(card);
  const f = fixture(), task = baseTask(); task.delivery.state = 'released';
  assert.equal(f.send('initialize', { task, source_revision: 'a'.repeat(64) }).code, 'initial_state');
  assert.equal(f.init().ok, true);
  const record = f.store().read(id);
  assert.equal(record.revision, 1);
  assert.equal(record.events.length, 1);
  assert.equal(record.task.status, undefined, 'runtime columns are not copied into the new authority');
  assert.deepEqual(fs.readFileSync(card), before);
  assert.equal(fs.statSync(path.join(f.dir, `${id}.json`)).mode & 0o777, 0o600);
});

test('idempotency survives restart and changed state but never bypasses current permissions', () => {
  const f = fixture(); f.init();
  const command = { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready-once' };
  const result = f.store().execute(id, command);
  assert.equal(result.ok, true);
  f.acquire();
  assert.deepEqual(f.store().execute(id, command), { ...result, replayed: true });
  assert.equal(f.store().read(id).events.length, 3);
  assert.equal(f.store().execute(id, { ...command, to: 'cancelled' }).code, 'idempotency_conflict');
  f.context.actor_id = 'human:other';
  assert.equal(f.store().execute(id, command).code, 'idempotency_conflict');
  f.context.grants = [];
  assert.equal(f.store().execute(id, command).code, 'not_authorized');
});

test('stale revisions, active legacy work and invalid assignments cannot mutate durable state', () => {
  const f = fixture(); f.init();
  const before = f.store().read(id);
  assert.equal(f.send('transition', { to: 'ready', expected_revision: 0 }).code, 'stale_revision');
  f.context.busy = true;
  assert.equal(f.ready().code, 'active_work');
  f.context.busy = false;
  assert.equal(f.send('assign', { role: 'reviewer', owner: 'agent-role:builder', handoff: { evidence: 'scope', next_action: 'review' } }).code, 'invalid_schema');
  assert.deepEqual(f.store().read(id), before);
});

test('admission atomically changes delivery state and records one fenced execution lease', () => {
  const f = fixture(); f.init(); f.ready();
  assert.equal(f.send('transition', { to: 'in_progress' }).code, 'admission_required');
  f.context.facts.admission.authorized = false;
  assert.equal(f.acquire().code, 'admission_required');
  f.context.facts.admission.authorized = true;
  const result = f.acquire();
  assert.equal(result.ok, true);
  const r = f.store().read(id);
  assert.equal(r.task.delivery.state, 'in_progress');
  assert.equal(r.lease.fence, 1);
  assert.equal(r.lease.owner, 'agent-role:builder');
  assert.equal(r.events.at(-1).action, 'acquire');
  assert.equal(f.acquire().code, 'active_work');
  assert.equal(f.send('transition', { to: 'in_review' }).code, 'active_work');
});

test('expiry, restart and reassignment never enable a second writer before stopped confirmation', () => {
  const f = fixture(); f.init(); f.ready(); const { lease } = f.acquire();
  f.time = 5000;
  assert.equal(f.acquire({ reason: 'recover' }).code, 'active_work');
  assert.equal(f.send('assign', { role: 'implementation', owner: 'agent-role:replacement', handoff: { evidence: 'candidate', next_action: 'resume' } }).code, 'active_work');
  assert.equal(f.send('release', { ...f.ref(lease), handoff: { evidence: 'candidate', next_action: 'review' } }).code, 'stop_unconfirmed');
  f.context.stopped = { ...f.ref(lease), fence: 0, confirmed: true, reference: 'old-run' };
  assert.equal(f.send('release', { ...f.ref(lease) }).code, 'stop_unconfirmed');
  assert.equal(f.release(lease).ok, true);
  assert.equal(f.store().read(id).last_handoff.evidence, 'candidate:abc');
  assert.equal(f.acquire({ run_id: lease.run_id, reason: 'resume' }).code, 'run_reused');
  const replacement = f.acquire({ reason: 'resume preserved work' });
  assert.equal(replacement.lease.fence, 2);
  assert.equal(f.release(lease).code, 'stale_lease');
});

test('only the current owner can renew a live lease; expired and stale writers are fenced', () => {
  const f = fixture(); f.init(); f.ready(); const { lease } = f.acquire();
  const request = { ...f.ref(lease), ttl_ms: 2000 };
  assert.equal(f.send('renew', request).code, 'not_owner');
  f.context.actor_id = lease.owner;
  assert.equal(f.send('renew', { ...request, fence: 9 }).code, 'stale_lease');
  assert.equal(f.send('renew', request).ok, true);
  assert.equal(f.store().read(id).lease.expires_at, 3000);
  f.time = 4000;
  assert.equal(f.send('renew', request).code, 'lease_expired');
});

test('handoffs and blockers survive reopening without deleting prior evidence', () => {
  const f = fixture(); f.init(); f.ready(); const { lease } = f.acquire(); f.release(lease);
  f.send('transition', { to: 'in_review' });
  const blocker = { category: 'publication', owner: 'human:owner', since: '2026-09-08T12:00:00Z', evidence: 'review pending', next_action: 'Review PR 19' };
  assert.equal(f.send('block', { blocker }).ok, true);
  assert.equal(f.send('transition', { to: 'ready_to_release' }).code, 'blocked');
  assert.equal(f.send('resolve', { handoff: { evidence: 'review accepted', next_action: 'integrate' } }).ok, true);
  assert.equal(f.send('assign', { role: 'implementation', owner: 'agent-role:replacement', handoff: { evidence: 'candidate:abc', next_action: 'repair findings' } }).ok, true);
  const r = f.store().read(id);
  assert.equal(r.task.ownership.implementation, 'agent-role:replacement');
  assert.equal(r.last_handoff.evidence, 'candidate:abc');
  assert.ok(r.events.some(e => e.action === 'release' && e.command.handoff.evidence === 'candidate:abc'));
  assert.equal(r.events.find(e => e.action === 'release').evidence.stopped.reference, 'runner:confirmed-stopped');
  assert.equal(f.send('transition', { to: 'backlog', reason: 'new scope' }).ok, true);
  assert.equal(f.store().read(id).events.length, r.events.length + 1);
});

test('advanced transitions still require reconciled evidence and cannot accept merge-only release', () => {
  const f = fixture(); f.init(); f.ready(); const { lease } = f.acquire(); f.release(lease);
  assert.equal(f.send('transition', { to: 'in_review' }).ok, true);
  assert.equal(f.send('transition', { to: 'ready_to_release' }).code, 'candidate_required');
  f.context.facts.policy_revision = 'policy-1';
  assert.equal(f.send('transition', { to: 'ready_to_release' }).code, 'evidence_required');
  assert.equal(f.store().read(id).task.delivery.state, 'in_review');
});

test('corrupt state and abandoned transaction locks fail closed, regardless of age', () => {
  const f = fixture(); f.init();
  const file = path.join(f.dir, `${id}.json`), good = fs.readFileSync(file);
  fs.writeFileSync(file, '{bad');
  assert.equal(f.store().execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'corrupt' }).code, 'corrupt_store');
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  fs.writeFileSync(file, good);
  const damaged = JSON.parse(good); damaged.next_fence = 99;
  fs.writeFileSync(file, JSON.stringify(damaged));
  assert.equal(f.store().execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'corrupt' }).code, 'corrupt_store');
  fs.writeFileSync(file, good);
  const lock = path.join(f.dir, `${id}.lock`); fs.mkdirSync(lock);
  const old = new Date(0); fs.utimesSync(lock, old, old);
  assert.equal(f.ready().code, 'write_busy');
  assert.equal(fs.existsSync(lock), true);
  assert.deepEqual(fs.readFileSync(file), good);
});

test('an uncertain acknowledgement retries the committed receipt without another event', () => {
  const f = fixture(); f.init();
  const rename = fs.renameSync;
  fs.renameSync = (...args) => { rename(...args); throw new Error('lost acknowledgement after rename'); };
  const command = { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'uncertain' };
  try { assert.equal(f.store().execute(id, command).code, 'commit_uncertain'); }
  finally { fs.renameSync = rename; }
  assert.equal(f.store().read(id).revision, 2);
  assert.equal(f.store().execute(id, command).replayed, true);
  assert.equal(f.store().read(id).events.length, 2);
});

test('a failure before publishing leaves the old complete record and can retry the same key', () => {
  const f = fixture(); f.init();
  const before = f.store().read(id), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk unavailable before publish'); };
  const command = { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'disk-retry' };
  try { assert.equal(f.store().execute(id, command).code, 'commit_uncertain'); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(f.store().read(id), before);
  assert.equal(f.store().execute(id, command).ok, true);
  assert.equal(f.store().read(id).events.length, 2);
});

function child(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    proc.stdout.on('data', b => stdout += b); proc.stderr.on('data', b => stderr += b);
    proc.on('error', reject); proc.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
const moduleUrl = new URL('../src/delivery-store.js', import.meta.url).href;

test('separate processes racing admission persist exactly one lease and one accepted event', async () => {
  const f = fixture(); f.init(); f.ready();
  const script = `import { createDeliveryStore } from ${JSON.stringify(moduleUrl)};
    const context = JSON.parse(process.argv[2]);
    const store = createDeliveryStore(process.argv[1], { enabled: true, resolveContext: () => context });
    console.log(JSON.stringify(store.execute('task-0001', { action: 'acquire', expected_revision: 2,
      idempotency_key: process.argv[3], run_id: process.argv[3], ttl_ms: 1000 })));`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(script, [f.dir, JSON.stringify(authority()), `race-${i}`])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const outcomes = results.map(r => JSON.parse(r.stdout));
  assert.equal(outcomes.filter(r => r.ok).length, 1);
  assert.ok(outcomes.filter(r => !r.ok).every(r => ['write_busy', 'stale_revision'].includes(r.code)));
  const r = f.store().read(id);
  assert.equal(r.revision, 3); assert.equal(r.next_fence, 2);
  assert.equal(r.events.filter(e => e.action === 'acquire').length, 1);
});

test('process death after atomic rename preserves complete state and receipt, with no automatic lock theft', async () => {
  const f = fixture(); f.init();
  const script = `import fs from 'node:fs'; import { createDeliveryStore } from ${JSON.stringify(moduleUrl)};
    const rename = fs.renameSync; fs.renameSync = (...args) => { rename(...args); process.exit(23); };
    const store = createDeliveryStore(process.argv[1], { enabled: true, resolveContext: () => JSON.parse(process.argv[2]) });
    store.execute('task-0001', { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'crash' });`;
  const result = await child(script, [f.dir, JSON.stringify(authority())]);
  assert.equal(result.code, 23, result.stderr);
  const r = f.store().read(id);
  assert.equal(r.revision, 2); assert.equal(r.events.length, 2);
  assert.equal(r.receipts.crash.result.revision, 2);
  assert.equal(f.acquire().code, 'write_busy');
});
