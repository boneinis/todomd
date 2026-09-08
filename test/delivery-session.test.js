import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard, tmp } from './helpers.js';
import { readCard } from '../src/board.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryAuthority } from '../src/delivery-authority.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { createDeliverySession } from '../src/delivery-session.js';
import { executionRef } from '../src/delivery-execution-state.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { startServer, loadToken } from '../src/server.js';
import { addProject } from '../src/registry.js';
import { pause } from '../src/delivery-local-state.js';
import * as scheduler from '../src/scheduler.js';
import * as pipeline from '../src/pipeline.js';

afterEach(async () => { scheduler.resetState(); await pipeline.killAllChildren({ graceMs: 100 }); });
const supported = ['darwin', 'linux'].includes(process.platform), id = 'task-0001';
function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()), cwd = tmp('delivery-session'), directory = deliveryStoreDirectory(repo);
  writeCard(repo, id, { status: 'Planned' });
  const source = createHash('sha256').update(readCard(repo, id).raw).digest('hex');
  const store = createDeliveryStore(directory, { enabled: true, resolveContext: () => ({ actor_id: 'human:lead', busy: false,
    grants: ['delivery:initialize', 'delivery:ready'], facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])) } }) });
  assert.equal(store.execute(id, { action: 'initialize', expected_revision: 0, idempotency_key: 'init', source_revision: source,
    task: { id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' },
      ownership: { delivery_lead: 'human:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer' } } }).ok, true);
  assert.equal(store.execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready' }).ok, true);
  const access = createDeliveryAccess(repo, { enabled: true });
  const issue = (actor_id, operator = false) => {
    const r = access.issue({ expected_revision: access.status().revision, actor_id, operator, ttl_ms: 60000 });
    assert.equal(r.ok, true); return r;
  };
  const builder = issue('agent-role:builder'), lead = issue('human:lead'), reviewer = issue('agent-role:reviewer');
  const marker = path.join(cwd, 'candidate.txt');
  const jobs = { build: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'candidate');setInterval(()=>{},1000)`], cwd, containment: 'local_process_group' } };
  createDeliveryAuthority(repo, { enabled: true, jobs }); // trusted configuration installs its exact identity
  const backend = fs.readdirSync(path.join(directory, 'job-authorities'))[0].slice(0, -5);
  const allow = backends => access.setJobs({ expected_revision: access.status().revision, backends });
  const session = (credential = builder.token, extra = {}) => createDeliverySession(repo, { enabled: true, credential, jobs,
    resolveAdmission: () => ({ job_approved: true, writers_fenced: true, busy: false, dependencies_satisfied: true }),
    localOptions: { graceMs: 50, closeTimeoutMs: 3000 }, ...extra });
  let key = 0;
  const command = fields => ({ expected_revision: store.read(id).revision, idempotency_key: `command-${++key}`,
    ...(store.read(id).lease ? executionRef(store.read(id)) : {}), ...fields });
  const reserve = s => s.reserve(id, { expected_revision: store.read(id).revision, idempotency_key: `reserve-${++key}`, profile: 'build', run_id: `run-${key}`, ttl_ms: 30000 });
  const finish = async () => {
    if (!store.read(id).lease) return;
    const s = session(lead.token, { jobs: {} });
    assert.equal((await s.stop(id, command())).ok, true);
    assert.equal((await s.reconcile(id, command())).ok, true);
    assert.equal(s.release(id, command({ handoff: { evidence: 'candidate preserved', next_action: 'review' } })).ok, true);
  };
  return { repo, directory, store, access, issue, builder, lead, reviewer, marker, backend, allow, session, command, reserve, finish };
}
async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await pause(25); }
  throw new Error('Session fixture timed out');
}
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

test('a request session needs both private job approval and current admission evidence', { skip: !supported }, async () => {
  const f = fixture(), s = f.session();
  assert.equal(f.reserve(s).ok, false);
  assert.equal(f.allow([f.backend]).ok, true);
  assert.equal(f.reserve(f.session(f.builder.token, { resolveAdmission: () => ({ job_approved: true, busy: false, dependencies_satisfied: true }) })).ok, false);
  assert.equal(f.reserve(f.session(f.builder.token, { resolveAdmission: () => ({ job_approved: false, writers_fenced: true, busy: false, dependencies_satisfied: true }) })).ok, false);
  assert.equal(f.reserve(s).ok, true);
  try {
    f.allow([]);
    assert.equal((await s.dispatch(id, f.command())).ok, false, 'old sessions re-read policy');
    assert.equal(fs.existsSync(f.marker), false);
  } finally { await f.finish(); }
});

test('credentials are request-bound and revoked credentials cannot commit asynchronous observations', { skip: !supported }, async () => {
  const f = fixture(), s = f.session(), review = f.session(f.reviewer.token);
  f.allow([f.backend]); assert.equal(f.reserve(s).ok, true);
  try {
    assert.equal((await s.dispatch(id, f.command())).ok, true);
    await until(() => fs.existsSync(f.marker));
    const revision = f.store.read(id).revision;
    const observation = s.reconcile(id, f.command());
    assert.equal(f.access.revoke({ expected_revision: f.access.status().revision, credential_id: f.builder.credential_id }).ok, true);
    assert.equal((await observation).code, 'not_authorized');
    assert.equal(f.store.read(id).revision, revision);
    assert.equal((await review.stop(id, f.command())).code, 'not_authorized');
    assert.equal(review.read(id).ok, true);
    assert.equal(s.read(id).code, 'not_authorized');
    assert.equal(f.session(f.lead.token).read(id).ok, true);
  } finally { await f.finish(); }
});

test('HTTP recovery rejects legacy credentials and launch, then stops and releases the exact job', { skip: !supported }, async () => {
  const f = fixture(), s = f.session(), card = readCard(f.repo, id).raw;
  f.allow([f.backend]); assert.equal(f.reserve(s).ok, true);
  assert.equal((await s.dispatch(id, f.command())).ok, true);
  addProject(f.repo); const port = await freePort(), server = await startServer({ port });
  const base = `http://127.0.0.1:${port}`, endpoint = `/api/delivery/executions/${id}`;
  const request = (action = '', token = f.lead.token, body, extra = {}) => fetch(`${base}${endpoint}${action}?project=${encodeURIComponent(path.basename(f.repo))}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-todomd-delivery-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra });
  try {
    await until(() => fs.existsSync(f.marker));
    for (const name of ['token', 'token-viewer', 'token-mobile', 'token-board-agent']) assert.equal((await request('', loadToken(name))).status, 401);
    assert.equal((await request('', '')).status, 401);
    assert.equal((await request('', f.lead.token, undefined, { headers: { 'x-todomd-token': f.lead.token } })).status, 401);
    assert.equal((await request('', f.lead.token, undefined, { headers: { 'x-todomd-delivery-token': f.lead.token, origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(`${base}${endpoint}?project=${path.basename(f.repo)}&token=${f.lead.token}`)).status, 400);
    assert.equal((await fetch(`${base}/api/projects`, { headers: { 'x-todomd-delivery-token': f.lead.token } })).status, 401);
    assert.equal((await request('/dispatch', f.builder.token, f.command())).status, 404);
    assert.equal((await request('/stop', f.reviewer.token, f.command())).status, 403);
    assert.equal((await request('/stop', f.lead.token, f.command({ grants: ['admin'] }))).status, 400);
    const read = await request(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
    const state = await read.json(); assert.equal(state.execution.backend, f.backend); assert.equal(state.revision, f.store.read(id).revision);
    assert.equal(JSON.stringify(state).includes(f.lead.token), false);
    assert.equal((await request('/release', f.lead.token, f.command({ handoff: { evidence: 'early', next_action: 'review' } }))).status, 409);
    f.allow([]); // policy removal cannot disable recovery
    assert.equal((await request('/stop', f.lead.token, f.command())).status, 200);
    assert.equal((await request('/reconcile', f.lead.token, f.command())).status, 200);
    assert.equal((await request('/release', f.lead.token, f.command({ handoff: { evidence: 'candidate preserved', next_action: 'review' } }))).status, 200);
    const released = await (await request()).json(); assert.equal(released.execution.phase, 'stopped');
    assert.equal(Object.hasOwn(released.execution, 'evidence'), false);
    assert.equal(f.store.read(id).lease, null);
    assert.equal(readCard(f.repo, id).raw, card);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'candidate');
  } finally { server.close(); await f.finish(); }
});

test('HTTP rechecks credentials after reading a request body and rejects duplicate credential headers', { skip: !supported }, async () => {
  const f = fixture(); f.allow([f.backend]); assert.equal(f.reserve(f.session()).ok, true);
  addProject(f.repo); const port = await freePort(), server = await startServer({ port });
  const body = JSON.stringify(f.command());
  const url = `http://127.0.0.1:${port}/api/delivery/executions/${id}/stop?project=${path.basename(f.repo)}`;
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'x-todomd-delivery-token': f.builder.token,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.write(body.slice(0, 1));
      // Hold the body so revocation happens after initial transport auth and
      // before the mutation. A subsequent session must re-read private state.
      setTimeout(() => {
        f.access.revoke({ expected_revision: f.access.status().revision, credential_id: f.builder.credential_id });
        req.end(body.slice(1));
      }, 50);
    });
    assert.ok([401, 403].includes(status));
    assert.equal(f.store.read(id).execution.phase, 'reserved');
    const duplicate = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'x-todomd-delivery-token': [f.lead.token, f.lead.token], 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(duplicate, 401);
  } finally { server.close(); await f.finish(); }
});
