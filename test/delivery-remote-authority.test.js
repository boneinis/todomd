import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard, tmp } from './helpers.js';
import { deliveryRuntimeStatus } from '../src/delivery-runtime.js';
import { readCard } from '../src/board.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryAuthority } from '../src/delivery-authority.js';
import { createDeliverySession } from '../src/delivery-session.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { executionRef } from '../src/delivery-execution-state.js';
import { provisionRemoteDeliveryWorker } from '../src/delivery-remote-state.js';
import { createRemoteDeliveryWorker } from '../src/delivery-remote-worker.js';
import { registeredRemoteBackend, registeredRemoteAuthority } from '../src/delivery-remote-authority.js';
import { admissionStatus, recoverAdmission, withAdmission } from '../src/delivery-admission.js';
import { recoverProjectAdmission } from '../src/delivery-launch-recovery.js';
import { pause, refKey } from '../src/delivery-local-state.js';
import { startServer } from '../src/server.js';
import { addProject } from '../src/registry.js';
import * as scheduler from '../src/scheduler.js';
import * as pipeline from '../src/pipeline.js';

afterEach(async () => { scheduler.resetState(); await pipeline.killAllChildren({ graceMs: 100 }); });
const supported = ['darwin', 'linux'].includes(process.platform), id = 'task-0001';
const facts = { job_approved: true, writers_fenced: true, busy: false, dependencies_satisfied: true };
const request = owner => ({ epoch: owner.epoch, nonce: owner.nonce });
const moduleUrl = name => new URL(`../src/${name}.js`, import.meta.url).href;
async function until(fn) {
  for (let i = 0; i < 600; i++) { if (fn()) return; await pause(25); }
  throw new Error('Remote authority fixture timed out');
}
async function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()), cwd = tmp('remote-authority-job'), root = tmp('registered-worker');
  const directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  writeCard(repo, id, { status: 'Planned', body: 'Untrusted command and provider instructions.' });
  const source = createHash('sha256').update(readCard(repo, id).raw).digest('hex');
  const store = createDeliveryStore(directory, { enabled: true, resolveContext: () => ({ actor_id: 'human:lead', busy: false,
    grants: ['delivery:initialize', 'delivery:ready'], facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])) } }) });
  assert.equal(store.execute(id, { action: 'initialize', expected_revision: 0, idempotency_key: 'init', source_revision: source,
    task: { id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' },
      ownership: { delivery_lead: 'human:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer' } } }).ok, true);
  assert.equal(store.execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready' }).ok, true);
  const marker = path.join(cwd, 'candidate.txt');
  const job = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'candidate preserved');setInterval(()=>{},1000)`], cwd, containment: 'local_process_group' };
  const authority = provisionRemoteDeliveryWorker(root, { projectId: 'a'.repeat(64), job });
  let credentialAvailable = true, hook = () => {}, dropStart = false, startPolicy = () => true;
  const startToken = 'fixture-implementation-worker-token', recoveryToken = 'fixture-recovery-worker-token';
  const worker = createRemoteDeliveryWorker(root, { enabled: true, expectedAuthority: authority.authority_id, job,
    authenticate: token => [startToken, recoveryToken].includes(token), authorizeStart: (ref, token) => token === startToken && startPolicy(ref),
    localOptions: { graceMs: 50, closeTimeoutMs: 3000 } });
  const pending = [];
  const server = http.createServer((req, res) => {
    const end = res.end.bind(res);
    res.end = (body, ...args) => {
      if (dropStart && typeof body === 'string' && JSON.parse(body).action === 'start') { pending.push(res); return res; }
      return end(body, ...args);
    };
    worker(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { version, ...workerBinding } = authority;
  const binding = { ...workerBinding, endpoint: `http://127.0.0.1:${server.address().port}/v1/delivery/execution`, credential_key: 'worker-one' };
  const calls = [];
  const remoteCredential = q => {
    assert.equal(q.repository, repo); assert.equal(q.backend, authority.backend); assert.equal(q.credential_key, 'worker-one');
    assert.ok(Object.isFrozen(q)); assert.ok(Object.isFrozen(q.execution)); calls.push(q.action); hook(q);
    return credentialAvailable ? q.action === 'start' ? startToken : recoveryToken : null;
  };
  const access = createDeliveryAccess(repo, { enabled: true });
  const issue = actor_id => access.issue({ expected_revision: access.status().revision, actor_id, ttl_ms: 120000 });
  const builder = issue('agent-role:builder'), lead = issue('human:lead'), reviewer = issue('agent-role:reviewer');
  const allow = backends => { const result = access.setJobs({ expected_revision: access.status().revision, backends }); assert.equal(result.ok, true); return result; };
  const session = (token = builder.token, extra = {}) => createDeliverySession(repo, { enabled: true, credential: token,
    remoteJobs: { build: binding }, remoteCredential, resolveAdmission: () => facts, ...extra });
  const service = session(); let n = 0;
  const command = extra => ({ ...executionRef(store.read(id)), expected_revision: store.read(id).revision, idempotency_key: `command-${++n}`, ...extra });
  const reserve = (s = service, extra = {}) => s.reserve(id, { expected_revision: store.read(id).revision, idempotency_key: `reserve-${++n}`, profile: 'build', run_id: `run-${n}`, ttl_ms: 60000, ...extra });
  const finish = async () => {
    credentialAvailable = true; hook = () => {}; dropStart = false;
    for (const res of pending) res.destroy();
    try {
      const owner = admissionStatus(gate).owner;
      if (owner) assert.equal((await recoverProjectAdmission(repo, request(owner), { remoteCredential })).ok, true);
      if (store.read(id).lease) {
        const s = session(lead.token, { remoteJobs: {} });
        assert.equal((await s.stop(id, command())).ok, true);
        assert.equal((await s.reconcile(id, command())).ok, true);
        assert.equal(s.release(id, command({ handoff: { evidence: 'candidate preserved', next_action: 'review' } })).ok, true);
      }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
  return { repo, directory, gate, marker, store, binding, access, builder, lead, reviewer, session, service, calls, allow, reserve, command, finish, remoteCredential,
    set credentialAvailable(v) { credentialAvailable = v; }, set hook(v) { hook = v; }, set dropStart(v) { dropStart = v; }, set startPolicy(v) { startPolicy = v; } };
}

test('remote job admission requires owner, private allowlist, source and writer fencing', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.reserve().ok, false);
    assert.equal(f.allow([f.binding.backend]).ok, true);
    assert.equal(f.reserve(f.session(f.lead.token)).code, 'not_authorized');
    for (const extra of [{ endpoint: f.binding.endpoint }, { credential_key: 'other' }, { command: '/bin/sh' }, { remoteCredential: 'token' }]) assert.equal(f.reserve(f.service, extra).code, 'invalid_request');
    for (const changed of [{ writers_fenced: false }, { dependencies_satisfied: false }, { busy: true }]) assert.equal(f.reserve(f.session(f.builder.token, { resolveAdmission: () => ({ ...facts, ...changed }) })).ok, false);
    writeCard(f.repo, 'task-0002', { status: 'Done', extra: 'ci_execution: remote\n' });
    assert.equal(f.reserve().ok, false);
    writeCard(f.repo, 'task-0002', { status: 'Done' });
    assert.equal(f.reserve().ok, true);
    writeCard(f.repo, id, { status: 'Planned', body: 'Changed scope' });
    assert.equal((await f.service.dispatch(id, f.command())).ok, false);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.marker), false);
  } finally { await f.finish(); }
});

test('remote sessions recover removed profiles and revoked launch policy without losing candidate or lease evidence', { skip: !supported }, async () => {
  const f = await fixture(), card = readCard(f.repo, id).raw;
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    const dispatch = f.command(); assert.equal((await f.service.dispatch(id, dispatch)).ok, true);
    assert.equal((await f.service.dispatch(id, dispatch)).replayed, true);
    await until(() => fs.existsSync(f.marker));
    assert.equal(f.calls.filter(x => x === 'start').length, 1);
    f.allow([]);
    const removed = f.session(f.lead.token, { remoteJobs: {} });
    assert.equal((await f.session(f.reviewer.token, { remoteJobs: {} }).stop(id, f.command())).code, 'not_authorized');
    assert.equal(removed.release(id, f.command({ handoff: { evidence: 'early', next_action: 'review' } })).code, 'stop_unconfirmed');
    assert.equal((await removed.stop(id, f.command())).ok, true);
    assert.ok(f.store.read(id).lease);
    assert.equal((await removed.reconcile(id, f.command())).ok, true);
    assert.equal(removed.release(id, f.command({ handoff: { evidence: 'candidate preserved', next_action: 'review' } })).ok, true);
    assert.equal(f.store.read(id).lease, null);
    assert.equal(readCard(f.repo, id).raw, card);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'candidate preserved');
    const registration = fs.readFileSync(path.join(f.directory, 'remote-authorities', `${f.binding.backend}.json`), 'utf8');
    assert.equal(registration.includes('fixture-implementation-worker-token'), false);
    assert.equal(registration.includes(f.builder.token), false);
  } finally { await f.finish(); }
});

test('credential lookup cannot bypass a fresh launch check; unavailability retains ownership for recovery', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    f.hook = q => { if (q.action === 'start') f.allow([]); };
    assert.equal((await f.service.dispatch(id, f.command())).code, 'dispatch_uncertain');
    assert.equal(fs.existsSync(f.marker), false);
    f.hook = () => {}; f.credentialAvailable = false;
    assert.equal((await f.service.stop(id, f.command())).ok, false);
    assert.ok(f.store.read(id).lease);
    f.credentialAvailable = true;
  } finally { await f.finish(); }
});

test('owner revocation during a remote observation prevents committing its evidence', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    const revision = f.store.read(id).revision;
    f.hook = q => { if (q.action === 'inspect') f.access.revoke({ expected_revision: f.access.status().revision, credential_id: f.builder.credential_id }); };
    assert.equal((await f.service.reconcile(id, f.command())).code, 'not_authorized');
    assert.equal(f.store.read(id).revision, revision);
  } finally { await f.finish(); }
});

test('worker policy remains mandatory even when the coordinator grants a remote launch', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true); f.startPolicy = () => false;
    assert.equal((await f.service.dispatch(id, f.command())).code, 'dispatch_uncertain');
    assert.equal(fs.existsSync(f.marker), false); assert.ok(f.store.read(id).lease);
  } finally { await f.finish(); }
});

test('registration rejects endpoint/provider rebinding, project copying, corruption and caller configuration', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    for (const change of [{ endpoint: 'https://other.example/v1/delivery/execution' }, { credential_key: 'another-provider' }, { project_id: 'b'.repeat(64) }, { token: 'secret' }, { backend: `remote-job-${'0'.repeat(64)}` }]) assert.throws(() => f.session(f.builder.token, { remoteJobs: { build: { ...f.binding, ...change } } }));
    assert.throws(() => f.session(f.builder.token, { remoteJobs: { first: f.binding, second: f.binding } }));
    assert.throws(() => registeredRemoteAuthority(f.directory, f.binding.backend, '/another-project'));
    const file = path.join(f.directory, 'remote-authorities', `${f.binding.backend}.json`), good = fs.readFileSync(file);
    fs.writeFileSync(file, '{bad');
    try {
      assert.equal((await f.service.stop(id, f.command())).code, 'backend_unavailable');
      assert.equal(fs.readFileSync(file, 'utf8'), '{bad'); assert.ok(f.store.read(id).lease);
    } finally { fs.writeFileSync(file, good); }
    // The constructed service has a copied binding, even if its source object changes.
    f.binding.endpoint = 'https://changed.example/v1/delivery/execution';
    assert.equal((await f.service.dispatch(id, f.command())).ok, true);
  } finally { await f.finish(); }
});

test('disabled remote registration is inert and ambiguous launch bindings are rejected', { skip: !supported }, async () => {
  const f = await fixture();
  try {
    const repo = makeRepo(), directory = deliveryStoreDirectory(repo);
    const s = createDeliveryAuthority(repo, { remoteJobs: { build: f.binding }, remoteCredential: () => { throw new Error('must not lookup'); } });
    assert.equal(s.reserve(id, {}).code, 'disabled'); assert.equal(fs.existsSync(directory), false);
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    const ref = executionRef(f.store.read(id));
    await assert.rejects(withAdmission(f.gate, 'launch', id, () => {}, { localExecution: ref, remoteExecution: ref }), /Ambiguous/);
    assert.equal(admissionStatus(f.gate).owner, null);
  } finally { await f.finish(); }
});

for (const mode of ['before-send', 'after-acceptance']) test(`dead remote launcher recovery ${mode} requires original worker closure`, { skip: !supported }, async () => {
  const f = await fixture(); let child, exited;
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true); f.dropStart = mode === 'after-acceptance';
    const script = `
      import { createDeliveryAuthority } from ${JSON.stringify(moduleUrl('delivery-authority'))};
      import { admissionStatus } from ${JSON.stringify(moduleUrl('delivery-admission'))};
      const [repo, gate, binding, command, mode] = process.argv.slice(1);
      const service = createDeliveryAuthority(repo, { enabled: true, remoteJobs: { build: JSON.parse(binding) },
        remoteTimeoutMs: 60000, remoteCredential: () => 'fixture-implementation-worker-token',
        authenticate: () => { if (mode === 'before-send' && admissionStatus(gate).owner?.kind === 'launch') process.exit(23); return { actor_id: 'agent-role:builder', project: repo }; },
        resolveAdmission: () => (${JSON.stringify(facts)}) });
      await service.dispatch('${id}', JSON.parse(command)); process.exit(24);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, f.repo, f.gate, JSON.stringify(f.binding), JSON.stringify(f.command()), mode], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => stderr += b);
    exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (mode === 'before-send') assert.equal(await exited, 23, stderr);
    else {
      await until(() => fs.existsSync(f.marker));
      const live = admissionStatus(f.gate).owner;
      assert.equal((await recoverProjectAdmission(f.repo, request(live), { remoteCredential: f.remoteCredential })).code, 'owner_alive');
      child.kill('SIGKILL'); await exited;
    }
    const owner = admissionStatus(f.gate).owner, before = f.store.read(id), card = readCard(f.repo, id).raw;
    assert.equal(owner.launch_authority, 'registered-remote-job-v1');
    assert.deepEqual(owner.execution, executionRef(before));
    const status = deliveryRuntimeStatus(f.repo, id);
    assert.equal(status.code, 'delivery_launch_pending');
    assert.match(status.next_action, /original remote worker and credential provider/);
    assert.equal(JSON.stringify(status).includes(f.binding.endpoint), false);
    assert.equal((await recoverAdmission(f.gate, request(owner), { reconcileLaunch: () => { throw new Error('local callback must not run'); } })).code, 'external_reconciliation_required');
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed');
    f.credentialAvailable = false;
    assert.equal((await recoverProjectAdmission(f.repo, request(owner), { remoteCredential: f.remoteCredential })).code, 'stop_unconfirmed');
    f.credentialAvailable = true;
    const ownerFile = path.join(f.gate, `${owner.epoch}.owner.json`), good = fs.readFileSync(ownerFile);
    const { checksum, ...mismatch } = owner; mismatch.execution = { ...owner.execution, fence: owner.execution.fence + 1 };
    fs.writeFileSync(ownerFile, JSON.stringify({ ...mismatch, checksum: refKey(mismatch) }));
    try { assert.equal((await recoverProjectAdmission(f.repo, request(owner), { remoteCredential: f.remoteCredential })).code, 'stop_unconfirmed'); }
    finally { fs.writeFileSync(ownerFile, good); }
    assert.equal((await recoverProjectAdmission(f.repo, request(owner), { remoteCredential: f.remoteCredential })).ok, true);
    assert.equal((await recoverProjectAdmission(f.repo, request(owner), { remoteCredential: f.remoteCredential })).replayed, true);
    assert.deepEqual(f.store.read(id), before); assert.equal(readCard(f.repo, id).raw, card);
    const backend = registeredRemoteBackend(f.directory, f.repo, f.binding.backend, { enabled: true, remoteCredential: f.remoteCredential });
    f.dropStart = false;
    assert.equal((await backend.start(owner.execution)).closed, true);
    assert.equal((await backend.inspect(owner.execution)).closed, true);
    if (mode === 'after-acceptance') assert.equal(fs.readFileSync(f.marker, 'utf8'), 'candidate preserved');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await f.finish();
  }
});

test('HTTP remote recovery uses only registered provider configuration and owner credentials', { skip: !supported }, async () => {
  const f = await fixture(); let server;
  try {
    f.allow([f.binding.backend]); assert.equal(f.reserve().ok, true);
    assert.equal((await f.service.dispatch(id, f.command())).ok, true); await until(() => fs.existsSync(f.marker));
    addProject(f.repo);
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    server = await startServer({ port, deliveryRemoteCredential: f.remoteCredential });
    const base = `http://127.0.0.1:${server.server.address().port}/api/delivery/executions/${id}`;
    const send = (action, command, token = f.lead.token) => fetch(`${base}/${action}?project=${encodeURIComponent(path.basename(f.repo))}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-todomd-delivery-token': token }, body: JSON.stringify(command) });
    assert.equal((await send('dispatch', f.command(), f.builder.token)).status, 404);
    assert.equal((await send('stop', f.command(), f.reviewer.token)).status, 403);
    assert.equal((await send('stop', f.command({ endpoint: 'https://other.example', credential: 'injected' }))).status, 400);
    f.allow([]);
    for (const action of ['stop', 'reconcile', 'release']) {
      const response = await send(action, f.command(action === 'release' ? { handoff: { evidence: 'candidate preserved', next_action: 'review' } } : {}));
      assert.equal(response.status, 200); const body = await response.text();
      assert.equal(body.includes('fixture-recovery-worker-token'), false); assert.equal(body.includes('credential_key'), false);
    }
    assert.equal(f.store.read(id).lease, null);
  } finally { server?.close(); await f.finish(); }
});
