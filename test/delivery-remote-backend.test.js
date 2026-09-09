import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalDeliveryBackend } from '../src/delivery-local-backend.js';
import { provisionRemoteDeliveryWorker } from '../src/delivery-remote-state.js';
import { createRemoteDeliveryWorker } from '../src/delivery-remote-worker.js';
import { createRemoteDeliveryBackend } from '../src/delivery-remote-backend.js';
import { refKey, pause } from '../src/delivery-local-state.js';
import { createDeliveryExecutionCoordinator } from '../src/delivery-execution.js';
import { executionRef } from '../src/delivery-execution-state.js';
import { seedDelivery } from './delivery-fixture.js';
import { tmp, isolateHome, makeRepo } from './helpers.js';

const supported = ['darwin', 'linux'].includes(process.platform);
async function listen(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}/v1/delivery/execution`,
    close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }) };
}
async function fixture() {
  isolateHome(); const work = tmp('remote'), root = path.join(work, 'worker'), pins = path.join(work, 'pins'), cwd = path.join(work, 'job'); fs.mkdirSync(cwd);
  const marker = path.join(cwd, 'candidate'), secret = 'fixture-worker-credential';
  const job = { command: process.execPath, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify('accepted\n')});setInterval(()=>{},1000)`], cwd, containment: 'local_process_group' };
  const identity = provisionRemoteDeliveryWorker(root, { projectId: 'a'.repeat(64), job });
  let authorized = true, policy = true, handler;
  const options = { enabled: true, expectedAuthority: identity.authority_id, job, authenticate: token => authorized && token === secret,
    authorizeStart: () => policy, localOptions: { graceMs: 50, closeTimeoutMs: 3000 } };
  handler = createRemoteDeliveryWorker(root, options);
  const transport = await listen((req, res) => handler(req, res));
  const config = { enabled: true, name: identity.backend, authorityId: identity.authority_id, projectId: identity.project_id,
    endpoint: transport.endpoint, credential: () => secret, timeoutMs: 50000 };
  const client = createRemoteDeliveryBackend(pins, config);
  const ref = { task_id: 'task-0001', lease_id: 'lease-1', run_id: 'run-1', fence: 1, backend: identity.backend, source_revision: 'b'.repeat(64) };
  const request = (action, execution = ref) => ({ version: 1, authority_id: identity.authority_id, project_id: identity.project_id, action, execution });
  const post = (body, headers = {}) => fetch(transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-todomd-worker-token': secret, ...headers }, body: JSON.stringify(body) });
  const close = async () => { authorized = true; handler = createRemoteDeliveryWorker(root, { ...options, job: undefined }); try { await client.close(ref); } finally { await transport.close(); } };
  return { root, pins, job, marker, secret, identity, options, config, client, ref, request, post, transport, close,
    replace: value => { handler = value; }, set authorized(v) { authorized = v; }, set policy(v) { policy = v; } };
}
async function until(fn) {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await pause(25); }
  throw new Error('Remote fixture timed out');
}

test('remote jobs start once, survive handler restart, and close before ownership evidence is returned', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.client.inspect(f.ref)).state, 'unknown');
    const started = await Promise.all([f.client.start(f.ref), f.client.start(f.ref)]);
    assert.equal(started.filter(r => r.accepted).length, 1);
    await until(() => fs.existsSync(f.marker));
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
    f.replace(createRemoteDeliveryWorker(f.root, f.options));
    const restarted = createRemoteDeliveryBackend(f.pins, f.config);
    assert.equal((await restarted.inspect(f.ref)).state, 'running');
    await restarted.close(f.ref);
    const observation = await restarted.inspect(f.ref);
    assert.equal(observation.state, 'stopped'); assert.equal(observation.closed, true);
    assert.match(observation.reference, /^remote-execution:/);
    assert.equal((await restarted.start(f.ref)).closed, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'authority.json'), 'utf8') + fs.readFileSync(path.join(f.pins, f.identity.backend + '.json'), 'utf8'), /fixture-worker-credential|appendFileSync/);
  } finally { await f.close(); }
});
test('closing an unsubmitted identity permanently rejects a delayed remote start', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    await f.client.close(f.ref);
    assert.equal((await f.client.start(f.ref)).closed, true);
    assert.equal((await f.client.inspect(f.ref)).closed, true);
    assert.equal(fs.existsSync(f.marker), false);
  } finally { await f.close(); }
});
test('a killed worker service can restart and recover its surviving supervised job', { skip: !supported }, async () => {
  const f = await fixture(); await f.transport.close();
  const port = Number(new URL(f.config.endpoint).port); let child, exited;
  async function boot() {
    child = fork(fileURLToPath(new URL('./fixtures/delivery-remote-worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exited = new Promise(r => child.once('exit', r));
    let ready = false; child.on('message', message => { ready = message.ready === true; });
    child.send({ root: f.root, authority: f.identity.authority_id, job: f.job, credential: f.secret, port });
    await until(() => ready);
  }
  try {
    await boot(); await f.client.start(f.ref); await until(() => fs.existsSync(f.marker));
    child.kill('SIGKILL'); await exited;
    await assert.rejects(f.client.inspect(f.ref), /unavailable/);
    await boot(); assert.equal((await f.client.inspect(f.ref)).state, 'running');
    await f.client.close(f.ref); assert.equal((await f.client.inspect(f.ref)).closed, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
  } finally {
    // Close only this test-owned execution, including if the HTTP host died.
    await createLocalDeliveryBackend(path.join(f.root, 'executions'), { enabled: true, name: f.identity.backend, graceMs: 50, closeTimeoutMs: 3000 }).close(f.ref);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
test('lost start acknowledgement does not cancel accepted work or authorize another submission', { skip: !supported }, async () => {
  const f = await fixture();
  const real = createRemoteDeliveryWorker(f.root, f.options);
  f.replace((req, res) => {
    const end = res.end.bind(res);
    res.end = data => { if (data && JSON.parse(data).action === 'start') { res.destroy(); return res; } return end(data); };
    return real(req, res);
  });
  try {
    await assert.rejects(f.client.start(f.ref), /unavailable/);
    await until(() => fs.existsSync(f.marker));
    assert.equal((await f.client.inspect(f.ref)).state, 'running');
    f.replace(real); await f.client.close(f.ref);
    assert.equal((await f.client.inspect(f.ref)).closed, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
  } finally { await f.close(); }
});
test('timed-out authorization is fenced by close even when the delayed start continues', { skip: !supported }, async () => {
  const f = await fixture(); let unblock, entered = false;
  const barrier = new Promise(r => { unblock = r; });
  f.replace(createRemoteDeliveryWorker(f.root, { ...f.options, authorizeStart: async () => { entered = true; await barrier; return true; } }));
  const short = createRemoteDeliveryBackend(f.pins, { ...f.config, timeoutMs: 500 });
  try {
    const start = assert.rejects(short.start(f.ref), /unavailable/); await until(() => entered); await start;
    await f.client.close(f.ref); unblock();
    await pause(100);
    assert.equal((await f.client.inspect(f.ref)).closed, true); assert.equal(fs.existsSync(f.marker), false);
  } finally { unblock(); await f.close(); }
});
test('lost close acknowledgement can be reconciled without reopening the execution', { skip: !supported }, async () => {
  const f = await fixture(), real = createRemoteDeliveryWorker(f.root, f.options);
  try {
    await f.client.start(f.ref); await until(() => fs.existsSync(f.marker));
    f.replace((req, res) => {
      const end = res.end.bind(res); res.end = data => { if (data && JSON.parse(data).action === 'close') { res.destroy(); return res; } return end(data); };
      return real(req, res);
    });
    await assert.rejects(f.client.close(f.ref), /unavailable/);
    assert.equal((await f.client.inspect(f.ref)).closed, true);
    f.replace(real); assert.equal((await f.client.start(f.ref)).closed, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
  } finally { await f.close(); }
});
test('worker credentials and policy are rechecked after asynchronous authorization; removed jobs retain recovery', { skip: !supported }, async () => {
  const f = await fixture(); let unblock, entered = false;
  const barrier = new Promise(r => { unblock = r; });
  f.replace(createRemoteDeliveryWorker(f.root, { ...f.options, authorizeStart: async () => { entered = true; await barrier; return true; } }));
  try {
    const start = assert.rejects(f.client.start(f.ref), /unavailable/); await until(() => entered); f.authorized = false; unblock(); await start;
    assert.equal(fs.existsSync(f.marker), false);
    await assert.rejects(f.client.inspect(f.ref), /unavailable/);
    f.authorized = true;
    f.replace(createRemoteDeliveryWorker(f.root, { ...f.options, job: undefined }));
    await assert.rejects(f.client.start(f.ref), /unavailable/);
    await f.client.close(f.ref); assert.equal((await f.client.inspect(f.ref)).closed, true);
  } finally { unblock(); await f.close(); }
});
test('untrusted request fields and foreign authority cannot select commands or another execution namespace', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    for (const value of [{ ...f.request('start'), command: '/bin/sh' }, { ...f.request('start'), project_id: 'c'.repeat(64) },
      { ...f.request('start'), authority_id: '00000000-0000-0000-0000-000000000000' }, f.request('start', { ...f.ref, args: ['bad'] }),
      f.request('start', { ...f.ref, backend: 'local' })]) assert.notEqual((await f.post(value)).status, 200);
    assert.equal((await f.post(f.request('inspect'), { Origin: 'https://foreign.invalid' })).status, 401);
    assert.equal((await f.post(f.request('inspect'), { 'x-todomd-worker-token': 'wrong' })).status, 401);
    assert.equal(fs.existsSync(f.marker), false);
  } finally { await f.close(); }
});
test('concurrent recovery and implementation credentials keep distinct start authority', { skip: !supported }, async () => {
  const f = await fixture();
  const operator = createRemoteDeliveryBackend(f.pins, { ...f.config, credential: () => 'fixture-recovery-only' });
  f.replace(createRemoteDeliveryWorker(f.root, { ...f.options,
    authenticate: token => [f.secret, 'fixture-recovery-only'].includes(token),
    authorizeStart: async (ref, token) => { assert.equal(ref.backend, f.identity.backend); await pause(25); return token === f.secret; } }));
  const other = { ...f.ref, run_id: 'operator-must-not-start', lease_id: 'operator-lease' };
  try {
    const requests = await Promise.allSettled([f.client.start(f.ref), operator.start(other)]);
    assert.equal(requests[0].status, 'fulfilled'); assert.equal(requests[1].status, 'rejected');
    await until(() => fs.existsSync(f.marker));
    await operator.close(f.ref); assert.equal((await operator.inspect(f.ref)).closed, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
  } finally { await f.close(); }
});
test('client rejects redirects and malformed, mismatched or oversized closure evidence', { skip: !supported }, async () => {
  const f = await fixture(); let response;
  f.replace((_req, res) => { res.writeHead(response.status || 200, { 'Content-Type': 'application/json', ...(response.headers || {}) }); res.end(response.body); });
  const valid = { ...f.request('inspect'), result: { state: 'stopped', closed: true } };
  try {
    for (const body of [{ ...valid, authority_id: '00000000-0000-0000-0000-000000000000' }, { ...valid, execution: { ...f.ref, run_id: 'other' } },
      { ...valid, result: { state: 'unknown', closed: true } }, { ...valid, result: { state: 'stopped', closed: false } }, { ...valid, extra: 'private-value' }]) {
      response = { body: JSON.stringify(body) }; await assert.rejects(f.client.inspect(f.ref), /unavailable/);
    }
    response = { body: 'x'.repeat(20000) }; await assert.rejects(f.client.inspect(f.ref), /unavailable/);
    response = { status: 302, headers: { Location: 'http://127.0.0.1:1/steal' }, body: '{}' }; await assert.rejects(f.client.inspect(f.ref), /unavailable/);
  } finally { await f.close(); }
});
test('pinned client and worker identities reject reconfiguration, root loss and replacement', { skip: !supported }, async () => {
  const f = await fixture(), saved = f.root + '-saved';
  try {
    assert.throws(() => createRemoteDeliveryBackend(f.pins, { ...f.config, endpoint: 'http://127.0.0.1:1/v1/delivery/execution' }), /authority/);
    assert.throws(() => createRemoteDeliveryWorker(f.root, { ...f.options, job: { ...f.job, args: ['changed'] } }), /authority/);
    assert.throws(() => provisionRemoteDeliveryWorker(f.root, { projectId: f.identity.project_id, job: f.job }), /empty/);
    fs.renameSync(f.root, saved);
    await assert.rejects(f.client.close(f.ref), /unavailable/);
    assert.equal(fs.existsSync(f.root), false);
    const replacement = provisionRemoteDeliveryWorker(f.root, { projectId: f.identity.project_id, job: f.job });
    f.replace(createRemoteDeliveryWorker(f.root, { ...f.options, expectedAuthority: replacement.authority_id }));
    await assert.rejects(f.client.close(f.ref), /unavailable/);
  } finally {
    if (fs.existsSync(saved)) { fs.rmSync(f.root, { recursive: true, force: true }); fs.renameSync(saved, f.root); }
    await f.close();
  }
});
test('disabled clients/workers create no runtime state and unsafe endpoints are rejected', { skip: !supported }, async () => {
  const f = await fixture(), empty = path.join(f.root, 'must-not-exist');
  try {
    const client = createRemoteDeliveryBackend(empty, { ...f.config, enabled: false });
    await assert.rejects(client.inspect(f.ref), /not enabled/); assert.equal(fs.existsSync(empty), false);
    const worker = createRemoteDeliveryWorker(empty); f.replace(worker);
    assert.equal((await f.post(f.request('start'))).status, 503); assert.equal(fs.existsSync(empty), false);
    for (const endpoint of ['http://example.com/v1/delivery/execution', 'https://user:secret@example.com/v1/delivery/execution', 'https://example.com/v1/delivery/execution?token=secret']) {
      assert.throws(() => createRemoteDeliveryBackend(empty, { ...f.config, endpoint }), /configuration/);
    }
  } finally { await f.close(); }
});
test('coordinator retains its lease through lost remote acknowledgement and releases only after reconciled closure', { skip: !supported }, async () => {
  const f = await fixture(), repo = makeRepo(), { directory, store } = seedDelivery(repo, 'task-0001');
  let n = 0;
  const context = { actor_id: 'agent-role:builder', grants: ['ready', 'acquire', 'in_progress', 'dispatch', 'request_stop', 'observe_execution', 'release'].map(g => `delivery:${g}`),
    busy: false, facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])),
      admission: { owner: 'agent-role:builder', authorized: true, dependencies_satisfied: true } },
    execution_admission: { backend: f.identity.backend, source_revision: 'a'.repeat(64), fenced: true } };
  const service = createDeliveryExecutionCoordinator(directory, { enabled: true, now: () => 1000, resolveContext: () => context, backends: { [f.identity.backend]: f.client } });
  const { createDeliveryStore } = await import('../src/delivery-store.js');
  const mapped = createDeliveryStore(directory, { enabled: true, now: () => 1000, resolveContext: () => context });
  assert.equal(mapped.execute('task-0001', { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready' }).ok, true);
  assert.equal(service.reserve('task-0001', { expected_revision: 2, idempotency_key: 'reserve', run_id: 'run-coordinator', ttl_ms: 10000,
    execution: { backend: f.identity.backend, source_revision: 'a'.repeat(64) } }).ok, true);
  const ref = executionRef(store.read('task-0001'));
  const command = () => ({ ...ref, expected_revision: store.read('task-0001').revision, idempotency_key: `op-${++n}` });
  const real = createRemoteDeliveryWorker(f.root, f.options);
  f.replace((req, res) => { const end = res.end.bind(res); res.end = data => { if (data && JSON.parse(data).action === 'start') { res.destroy(); return res; } return end(data); }; return real(req, res); });
  try {
    const dispatch = command(); assert.equal((await service.dispatch('task-0001', dispatch)).code, 'dispatch_uncertain');
    assert.equal((await service.dispatch('task-0001', dispatch)).replayed, true);
    await until(() => fs.existsSync(f.marker));
    assert.equal((await service.reconcile('task-0001', command())).ok, true);
    assert.equal(service.release('task-0001', { ...command(), handoff: { evidence: 'candidate:preserved', next_action: 'review' } }).code, 'stop_unconfirmed');
    f.replace(real); assert.equal((await service.stop('task-0001', command())).ok, true);
    assert.equal((await service.reconcile('task-0001', command())).ok, true);
    assert.equal(service.release('task-0001', { ...command(), handoff: { evidence: 'candidate:preserved', next_action: 'review' } }).ok, true);
    assert.equal(store.read('task-0001').lease, null);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'accepted\n');
  } finally { f.replace(real); await f.client.close(ref); await f.close(); }
});
