import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmp, isolateHome, makeRepo, writeCard } from './helpers.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryExecutionCoordinator } from '../src/delivery-execution.js';
import { executionRef } from '../src/delivery-execution-state.js';
import { stopChild } from '../src/process-lifecycle.js';
import { deliveryRuntimeStatus, deliveryStoreDirectory } from '../src/delivery-runtime.js';

const id = 'task-0001', source = 'a'.repeat(64);
const task = { id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' },
  ownership: { delivery_lead: 'human:owner', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer' } };
function authority() {
  return { actor_id: 'human:owner', busy: false,
    grants: ['initialize', 'ready', 'in_progress', 'acquire', 'dispatch', 'request_stop', 'observe_execution', 'release', 'assign'].map(a => `delivery:${a}`),
    execution_admission: { backend: 'test', source_revision: source, fenced: true },
    facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])),
      admission: { authorized: true, dependencies_satisfied: true, owner: 'agent-role:builder' } } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const directory = path.join(tmp('delivery-execution'), 'private');
  let context = authority(), counter = 0, time = 1000, starts = 0, closes = 0;
  const jobs = new Map();
  const backend = {
    async start(ref) { starts++; if (!jobs.has(ref.lease_id)) jobs.set(ref.lease_id, 'running'); },
    async close(ref) { closes++; jobs.set(ref.lease_id, 'stopped'); },
    async inspect(ref) { const state = jobs.get(ref.lease_id) || 'unknown';
      return { ...ref, state, closed: state === 'stopped', reference: 'backend:receipt' }; },
  };
  const options = () => ({ enabled: true, now: () => time, resolveContext: () => context, backends: { test: backend } });
  const store = createDeliveryStore(directory, options());
  const coordinator = () => createDeliveryExecutionCoordinator(directory, options());
  const command = (fields = {}) => ({ expected_revision: store.read(id)?.revision || 0, idempotency_key: `key-${++counter}`,
    ...(store.read(id)?.execution && store.read(id).lease ? executionRef(store.read(id)) : {}), ...fields });
  assert.equal(store.execute(id, command({ action: 'initialize', task, source_revision: source })).ok, true);
  assert.equal(store.execute(id, command({ action: 'transition', to: 'ready' })).ok, true);
  const reserve = (fields = {}) => coordinator().reserve(id, command({ run_id: `run-${counter}`, ttl_ms: 1000,
    execution: { backend: 'test', source_revision: source }, ...fields }));
  const release = () => coordinator().release(id, command({ handoff: { evidence: 'candidate:preserved', next_action: 'Review the candidate' } }));
  return { directory, store, coordinator, backend, command, reserve, release, jobs,
    get starts() { return starts; }, get closes() { return closes; },
    get context() { return context; }, set context(v) { context = v; }, set time(v) { time = v; } };
}

test('disabled coordinator cannot reserve, start, close or inspect a backend', async () => {
  let calls = 0;
  const backend = { start() { calls++; }, close() { calls++; }, inspect() { calls++; } };
  const directory = path.join(tmp('execution-disabled'), 'absent');
  const c = createDeliveryExecutionCoordinator(directory, { backends: { test: backend } });
  for (const method of ['reserve', 'dispatch', 'stop', 'reconcile', 'release']) {
    assert.equal((await c[method](id, {})).code, 'disabled');
  }
  assert.equal(calls, 0); assert.equal(fs.existsSync(directory), false);
});

test('admission and dispatch recheck fenced source authority before any external start', async () => {
  const f = fixture();
  f.context.execution_admission.fenced = false;
  assert.equal(f.reserve().code, 'admission_required');
  f.context.execution_admission.fenced = true;
  assert.equal(f.reserve({ execution: { backend: 'test', source_revision: 'b'.repeat(64) } }).code, 'admission_required');
  assert.equal(f.reserve().ok, true);
  assert.equal(f.store.read(id).execution.phase, 'reserved');
  f.context.execution_admission.source_revision = 'b'.repeat(64);
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'admission_required');
  f.context.execution_admission.source_revision = source;
  f.context.facts.admission.dependencies_satisfied = false;
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'admission_required');
  f.context.facts.admission.dependencies_satisfied = true;
  f.context.facts.admission.authorized = false;
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'admission_required');
  f.context.facts.admission.authorized = true;
  f.context.facts.admission.owner = 'agent-role:other';
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'admission_required');
  f.context.facts.admission.owner = 'agent-role:builder';
  f.context.busy = true;
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'admission_required');
  assert.equal(f.starts, 0);
});

test('dispatch publishes its claim first and never resubmits on replay or acknowledgement loss', async () => {
  const f = fixture(); f.reserve(); const original = f.backend.start;
  f.backend.start = async ref => {
    assert.equal(f.store.read(id).execution.phase, 'dispatching');
    await original(ref); throw new Error('accepted job, lost acknowledgement');
  };
  const request = f.command();
  assert.equal((await f.coordinator().dispatch(id, request)).code, 'dispatch_uncertain');
  assert.equal((await f.coordinator().dispatch(id, request)).replayed, true);
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'dispatch_claimed');
  assert.equal(f.starts, 1);
  assert.equal((await f.coordinator().reconcile(id, f.command())).ok, true);
  assert.equal(f.store.read(id).execution.phase, 'running');
  assert.equal(f.release().code, 'stop_unconfirmed');
  f.context.grants = [];
  assert.equal((await f.coordinator().dispatch(id, request)).code, 'not_authorized');
  assert.equal(f.starts, 1);
});

test('an expired reservation can close without dispatch and cannot be reopened by an observation', async () => {
  const f = fixture(); f.reserve(); f.time = 5000;
  assert.equal((await f.coordinator().dispatch(id, f.command())).code, 'lease_expired');
  assert.equal(f.starts, 0);
  assert.equal((await f.coordinator().stop(id, f.command())).ok, true);
  assert.equal((await f.coordinator().reconcile(id, f.command())).ok, true);
  const ref = executionRef(f.store.read(id));
  f.backend.inspect = async () => ({ ...ref, state: 'running', reference: 'stale-status' });
  assert.equal((await f.coordinator().reconcile(id, f.command())).code, 'execution_closed');
  assert.equal(f.release().ok, true);
});

test('uncertain publication never starts a job, and an absent lookup never releases its lease', async () => {
  const f = fixture(); f.reserve(); const rename = fs.renameSync;
  fs.renameSync = (...args) => { rename(...args); throw new Error('lost commit acknowledgement'); };
  const request = f.command();
  try { assert.equal((await f.coordinator().dispatch(id, request)).code, 'commit_uncertain'); }
  finally { fs.renameSync = rename; }
  assert.equal((await f.coordinator().dispatch(id, request)).replayed, true);
  assert.equal(f.starts, 0);
  f.time = 5000;
  assert.equal((await f.coordinator().reconcile(id, f.command())).ok, true);
  assert.equal(f.store.read(id).execution.phase, 'dispatching');
  assert.equal(f.release().code, 'stop_unconfirmed');
  assert.equal(f.reserve({ reason: 'recover' }).code, 'active_work');
  assert.equal((await f.coordinator().stop(id, f.command())).ok, true);
  assert.equal((await f.coordinator().reconcile(id, f.command())).ok, true);
  assert.equal(f.release().ok, true);
});

test('caller stop claims, wrapper exit, wrong runs, and unavailable backends cannot release ownership', async () => {
  const f = fixture(); f.reserve(); await f.coordinator().dispatch(id, f.command());
  const ref = executionRef(f.store.read(id));
  f.context.stopped = { ...ref, confirmed: true, reference: 'caller-claim' };
  assert.equal(f.release().code, 'stop_unconfirmed');
  f.backend.inspect = async () => ({ ...ref, state: 'stopped', closed: false, reference: 'wrapper-exited' });
  assert.equal((await f.coordinator().reconcile(id, f.command())).code, 'stop_unconfirmed');
  f.backend.inspect = async () => ({ ...ref, run_id: 'wrong-run', state: 'stopped', closed: true, reference: 'wrong' });
  assert.equal((await f.coordinator().reconcile(id, f.command())).code, 'stop_unconfirmed');
  f.backend.inspect = async () => { throw new Error('offline'); };
  assert.equal((await f.coordinator().reconcile(id, f.command())).code, 'backend_unavailable');
  assert.equal(f.release().code, 'stop_unconfirmed');
});

test('closure fences a delayed start before releasing and preserves candidate handoff on replacement', async () => {
  const f = fixture(); f.reserve(); const delayed = deferred(), entered = deferred();
  const original = f.backend.start;
  f.backend.start = async ref => { entered.resolve(); await delayed.promise; await original(ref); };
  const pending = f.coordinator().dispatch(id, f.command());
  await entered.promise;
  const oldRef = executionRef(f.store.read(id));
  await f.coordinator().stop(id, f.command());
  await f.coordinator().reconcile(id, f.command());
  assert.equal(f.release().ok, true);
  assert.equal(f.store.read(id).last_handoff.evidence, 'candidate:preserved');
  assert.equal(f.reserve({ reason: 'resume preserved candidate' }).ok, true);
  delayed.resolve(); await pending;
  assert.equal(f.jobs.get(oldRef.lease_id), 'stopped', 'late start cannot reopen a closed backend identity');
  assert.equal(f.store.read(id).lease.fence, 2);
  assert.equal((await f.coordinator().stop(id, f.command(oldRef))).code, 'stale_execution');
});

test('stop request survives restart, retries closure, and retains ownership until an observed terminal result', async () => {
  const f = fixture(); f.reserve(); await f.coordinator().dispatch(id, f.command());
  const close = f.backend.close;
  f.backend.close = async ref => { await close(ref); throw new Error('close acknowledgement lost'); };
  const request = f.command();
  assert.equal((await f.coordinator().stop(id, request)).code, 'stop_unconfirmed');
  assert.equal(f.store.read(id).execution.phase, 'stop_requested');
  assert.equal(f.release().code, 'stop_unconfirmed');
  f.backend.close = close;
  assert.equal((await f.coordinator().stop(id, request)).ok, true);
  assert.equal(f.closes, 2);
  assert.equal((await f.coordinator().reconcile(id, f.command())).ok, true);
  assert.equal(f.release().ok, true);
  const events = f.store.read(id).events;
  assert.equal(events.filter(e => e.action === 'request_stop').length, 1);
  assert.equal(events.at(-1).evidence.stopped.closed, true);
});

test('asynchronous observations cannot overwrite a newer stop request or bypass revoked grants', async () => {
  const f = fixture(); f.reserve(); await f.coordinator().dispatch(id, f.command());
  const observation = deferred(); f.backend.inspect = () => observation.promise;
  const ref = executionRef(f.store.read(id));
  const pending = f.coordinator().reconcile(id, f.command());
  await f.coordinator().stop(id, f.command());
  observation.resolve({ ...ref, state: 'running', reference: 'old-observation' });
  assert.equal((await pending).code, 'stale_revision');
  assert.equal(f.store.read(id).execution.phase, 'stop_requested');
  const next = deferred(); f.backend.inspect = () => next.promise;
  const revoked = f.coordinator().reconcile(id, f.command());
  f.context.grants = [];
  next.resolve({ ...ref, state: 'stopped', closed: true, reference: 'closed' });
  assert.equal((await revoked).code, 'not_authorized');
  assert.equal(f.store.read(id).execution.phase, 'stop_requested');
});

test('confirmed local process-group stop can supply the backend closure receipt', async () => {
  const f = fixture(); let proc, closed = false, stopped = false;
  f.backend.start = async () => {
    if (closed) return;
    proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
  };
  f.backend.close = async () => { closed = true; const result = await stopChild(proc, { graceMs: 50 });
    stopped = result.ok; assert.equal(stopped, true); };
  f.backend.inspect = async ref => ({ ...ref, state: stopped ? 'stopped' : 'running',
    closed, reference: 'local:confirmed-process-group-stop' });
  try {
    f.reserve(); await f.coordinator().dispatch(id, f.command());
    assert.equal(f.release().code, 'stop_unconfirmed');
    await f.coordinator().stop(id, f.command());
    await f.coordinator().reconcile(id, f.command());
    assert.equal(f.release().ok, true);
  } finally { if (proc) await stopChild(proc, { graceMs: 50 }); }
});

test('independent coordinator processes racing dispatch call the backend exactly once', async () => {
  const f = fixture(); f.reserve();
  const log = path.join(tmp('dispatch-race'), 'starts');
  const script = `import fs from 'node:fs';
    import { createDeliveryExecutionCoordinator } from ${JSON.stringify(new URL('../src/delivery-execution.js', import.meta.url).href)};
    const c = createDeliveryExecutionCoordinator(process.argv[1], { enabled: true, now: () => 1000,
      resolveContext: () => JSON.parse(process.argv[2]), backends: { test: {
        start() { fs.appendFileSync(process.argv[4], 'start\\n'); }, close() {}, inspect() {} } } });
    console.log(JSON.stringify(await c.dispatch('${id}', JSON.parse(process.argv[3]))));`;
  const request = f.command();
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, f.directory, JSON.stringify(f.context),
      JSON.stringify({ ...request, idempotency_key: `race-${i}` }), log], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; proc.stdout.on('data', b => out += b); proc.stderr.on('data', b => err += b);
    proc.on('error', reject); proc.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  })));
  assert.equal(outcomes.filter(r => r.ok).length, 1);
  assert.ok(outcomes.filter(r => !r.ok).every(r => ['write_busy', 'stale_revision'].includes(r.code)));
  assert.equal(fs.readFileSync(log, 'utf8'), 'start\n');
  assert.equal(f.store.read(id).events.filter(e => e.action === 'dispatch').length, 1);
});

test('journal phase is readable while legacy writes remain held and tracked candidates stay unchanged', async () => {
  isolateHome(); const repo = makeRepo({ automaticMaintenance: false }); writeCard(repo, id, { status: 'Needs Human' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md'), before = fs.readFileSync(file);
  const f = fixture(); f.reserve(); await f.coordinator().dispatch(id, f.command());
  await f.coordinator().stop(id, f.command());
  const directory = deliveryStoreDirectory(repo);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(f.directory, `${id}.json`), path.join(directory, `${id}.json`));
  const status = deliveryRuntimeStatus(repo, id);
  assert.deepEqual(status.execution, { phase: 'stop_requested' });
  assert.equal(status.legacy_execution_allowed, false);
  assert.doesNotMatch(JSON.stringify(status), /source_revision|lease_id|backend|run_id|receipt|candidate:preserved/);
  assert.deepEqual(fs.readFileSync(file), before);
});
