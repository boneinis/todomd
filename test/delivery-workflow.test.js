import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard, tmp } from './helpers.js';
import { readCard } from '../src/board.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { createDeliverySession } from '../src/delivery-session.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { admissionHeld } from '../src/delivery-admission.js';
import { pause } from '../src/delivery-local-state.js';

const id = 'task-0001', supported = ['linux', 'darwin'].includes(process.platform);
const ready = Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true]));
const handoff = { evidence: 'Preserved candidate and validation notes', next_action: 'Continue from recorded candidate' };
function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()), directory = deliveryStoreDirectory(repo), cwd = tmp('workflow-job');
  writeCard(repo, id, { status: 'Planned' });
  const original = readCard(repo, id).raw, source_revision = createHash('sha256').update(original).digest('hex');
  let time = Date.now(), n = 0;
  const store = createDeliveryStore(directory), access = createDeliveryAccess(repo, { enabled: true, now: () => time });
  const issue = (actor_id, operator = false) => {
    const result = access.issue({ expected_revision: access.status().revision, actor_id, operator, ttl_ms: 600000 });
    assert.equal(result.ok, true); return result;
  };
  const operator = issue('human:operator', true), lead = issue('agent-role:lead'), builder = issue('agent-role:builder'),
    reviewer = issue('agent-role:reviewer'), replacement = issue('agent-role:replacement'), outsider = issue('agent-role:outsider');
  let facts = { writers_fenced: true, busy: false, ready };
  const marker = path.join(cwd, 'candidate.txt');
  const jobs = { build: { command: process.execPath, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n'); setInterval(()=>{},1000)`], cwd, containment: 'local_process_group' } };
  const session = (who = lead, extra = {}) => createDeliverySession(repo, { enabled: true, credential: who.token, now: () => time, jobs,
    resolveWorkflow: () => { assert.equal(admissionHeld(path.join(directory, 'admission')), true); return facts; },
    resolveAdmission: () => ({ writers_fenced: true, busy: false, job_approved: true, dependencies_satisfied: true }),
    localOptions: { graceMs: 50, closeTimeoutMs: 3000 }, ...extra });
  const command = fields => ({ expected_revision: store.read(id)?.revision || 0, idempotency_key: `command-${++n}`, ...fields });
  const initialize = extra => command({ source_revision, task: { id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' }, ownership: { delivery_lead: 'agent-role:lead' } }, ...extra });
  const prepare = () => {
    assert.equal(session(operator).initialize(id, initialize()).ok, true);
    for (const [role, owner] of [['implementation', 'agent-role:builder'], ['reviewer', 'agent-role:reviewer']]) {
      assert.equal(session().assign(id, command({ role, owner, handoff })).ok, true);
    }
    assert.equal(session().transition(id, command({ to: 'ready' })).ok, true);
  };
  const executionCommand = fields => command({ ...session(operator).read(id).execution, phase: undefined, ...fields });
  // Only execution reference fields are sent, not the presentation phase.
  const exec = fields => { const c = executionCommand(fields); delete c.phase; return c; };
  const close = async () => {
    if (!store.read(id)?.lease) return;
    const s = session(operator, { jobs: {}, resolveWorkflow: undefined });
    assert.equal((await s.stop(id, exec())).ok, true);
    assert.equal((await s.reconcile(id, exec())).ok, true);
    assert.equal(s.release(id, exec({ handoff })).ok, true);
  };
  return { repo, directory, original, store, access, source_revision, operator, lead, builder, reviewer, replacement, outsider,
    session, command, initialize, prepare, exec, close, marker, set facts(v) { facts = v; }, set time(v) { time = v; } };
}
async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await pause(25); }
  throw new Error('Local workflow did not progress');
}

test('preparation is disabled by default and accepts neither caller grants nor execution commands', () => {
  const f = fixture(), s = f.session(f.operator, { enabled: false });
  for (const method of ['initialize', 'assign', 'block', 'resolve', 'transition']) assert.equal(s[method](id, {}).code, 'disabled');
  assert.equal(f.store.read(id), null);
  for (const extra of [{ grants: ['delivery:initialize'] }, { facts: { ready } }, { command: 'arbitrary' }, { actor_id: 'human:operator' }]) {
    assert.equal(f.session(f.operator).initialize(id, f.initialize(extra)).code, 'invalid_request');
  }
  assert.equal(f.session(f.builder).initialize(id, f.initialize()).code, 'not_authorized');
  assert.equal(f.session(f.operator).initialize(id, f.initialize({ source_revision: '0'.repeat(64) })).code, 'active_work');
  assert.equal(f.store.read(id), null);
});

test('fresh trusted readiness, fencing, and owner authority are required for preparation', () => {
  const f = fixture(), s = f.session(f.operator);
  for (const facts of [null, { busy: false, ready }, { writers_fenced: true, busy: true, ready }, Promise.resolve({ writers_fenced: true, busy: false, ready })]) {
    f.facts = facts; assert.equal(s.initialize(id, f.initialize()).ok, false);
  }
  f.facts = { writers_fenced: true, busy: false, ready };
  writeCard(f.repo, 'task-0002', { status: 'Build' });
  assert.equal(s.initialize(id, f.initialize()).ok, false);
  writeCard(f.repo, 'task-0002', { status: 'Done' });
  const init = f.initialize(); assert.equal(s.initialize(id, init).ok, true); assert.equal(s.initialize(id, init).replayed, true);
  const lead = f.session();
  assert.equal(lead.transition(id, f.command({ to: 'ready' })).code, 'invalid_destination');
  assert.equal(f.session(f.outsider).assign(id, f.command({ role: 'implementation', owner: 'agent-role:outsider', handoff })).code, 'not_authorized');
  assert.equal(lead.assign(id, f.command({ role: 'implementation', owner: 'agent-role:builder', handoff })).ok, true);
  assert.equal(lead.assign(id, f.command({ role: 'reviewer', owner: 'agent-role:builder', handoff })).code, 'invalid_schema');
  assert.equal(lead.assign(id, f.command({ role: 'reviewer', owner: 'agent-role:reviewer', handoff })).ok, true);
  f.facts = { writers_fenced: true, busy: false };
  assert.equal(lead.transition(id, f.command({ to: 'ready' })).code, 'not_ready');
  f.facts = { writers_fenced: true, busy: false, ready };
  assert.equal(lead.transition(id, f.command({ to: 'ready' })).ok, true);
  for (const to of ['in_progress', 'completed', 'ready_to_release', 'released']) assert.equal(lead.transition(id, f.command({ to })).code, 'unsupported_transition');
  assert.equal(readCard(f.repo, id).raw, f.original);
});

test('blocker ownership, stale revisions, source drift and revoked credentials preserve history', () => {
  const f = fixture(); f.prepare(); const lead = f.session(), builder = f.session(f.builder), reviewer = f.session(f.reviewer);
  const block = f.command({ blocker: { category: 'implementation', owner: 'agent-role:builder', since: new Date().toISOString(), evidence: 'Candidate needs correction', next_action: 'Inspect recorded finding' } });
  assert.equal(reviewer.block(id, block).code, 'not_authorized');
  assert.equal(builder.block(id, block).ok, true);
  assert.equal(reviewer.resolve(id, f.command({ handoff })).code, 'not_authorized');
  assert.equal(lead.assign(id, { ...f.command({ role: 'implementation', owner: 'agent-role:replacement', handoff }), expected_revision: 1 }).code, 'stale_revision');
  assert.equal(builder.resolve(id, f.command({ handoff })).ok, true);
  const read = builder.readTask(id); assert.equal(read.handoff.next_action, handoff.next_action);
  read.task.ownership.implementation = 'agent-role:outsider';
  assert.equal(builder.readTask(id).task.ownership.implementation, 'agent-role:builder');
  assert.equal(f.session(f.outsider).readTask(id).code, 'not_authorized');
  const file = path.join(f.repo, '.todomd/tasks', readCard(f.repo, id).file); fs.appendFileSync(file, '\nChanged scope\n');
  assert.equal(lead.assign(id, f.command({ role: 'implementation', owner: 'agent-role:replacement', handoff })).code, 'active_work');
  fs.writeFileSync(file, f.original);
  const assign = f.command({ role: 'implementation', owner: 'agent-role:replacement', handoff });
  assert.equal(lead.assign(id, assign).ok, true); assert.equal(lead.assign(id, assign).replayed, true);
  assert.equal(builder.readTask(id).code, 'not_authorized');
  f.access.revoke({ expected_revision: f.access.status().revision, credential_id: f.lead.credential_id });
  assert.equal(lead.assign(id, assign).code, 'not_authorized');
  assert.equal(f.store.read(id).events.some(e => e.action === 'block'), true);
});

test('revocation inside the trusted workflow resolver prevents the transaction', () => {
  const f = fixture();
  const s = f.session(f.operator, { resolveWorkflow: () => {
    f.access.revoke({ expected_revision: f.access.status().revision, credential_id: f.operator.credential_id });
    return { writers_fenced: true, busy: false, ready };
  } });
  assert.equal(s.initialize(id, f.initialize()).code, 'not_authorized');
  assert.equal(f.store.read(id), null);
});

test('a prepared assignment runs locally, survives restart, and hands its candidate to a replacement', { skip: !supported }, async () => {
  const f = fixture(); f.prepare();
  const backend = fs.readdirSync(path.join(f.directory, 'job-authorities'))[0].slice(0, -5);
  assert.equal(f.access.setJobs({ expected_revision: f.access.status().revision, backends: [backend] }).ok, true);
  const reserve = run_id => f.command({ profile: 'build', run_id, ttl_ms: 1000, reason: 'Continue preserved work' });
  let s = f.session(f.builder);
  try {
    assert.equal(s.reserve(id, reserve('first-run')).ok, true);
    assert.equal((await s.dispatch(id, f.exec())).ok, true);
    await until(() => fs.existsSync(f.marker) && fs.readFileSync(f.marker, 'utf8') === 'run\n');
    const fence = f.store.read(id).lease.fence;
    f.time = Date.now() + 2000;
    s = f.session(f.builder); // simulate a fresh request/controller after expiry
    assert.equal(s.readTask(id).execution_held, true);
    assert.equal(f.session().assign(id, f.command({ role: 'implementation', owner: 'agent-role:replacement', handoff })).code, 'active_work');
    assert.equal(f.session(f.replacement).reserve(id, reserve('premature')).code, 'not_authorized');
    await f.close();
    assert.equal(f.session().assign(id, f.command({ role: 'implementation', owner: 'agent-role:replacement', handoff })).ok, true);
    const next = f.session(f.replacement);
    assert.equal(next.readTask(id).handoff.evidence, handoff.evidence);
    assert.equal(s.reserve(id, reserve('old-owner')).code, 'not_authorized');
    assert.equal(next.reserve(id, reserve('second-run')).ok, true);
    assert.ok(f.store.read(id).lease.fence > fence);
    assert.equal((await next.dispatch(id, f.exec())).ok, true);
    await until(() => fs.readFileSync(f.marker, 'utf8') === 'run\nrun\n');
    await f.close();
    assert.equal(next.transition(id, f.command({ to: 'in_review' })).code, 'candidate_required');
    f.facts = { writers_fenced: true, busy: false, candidate: { head: 'a'.repeat(40), clean: true, preserved: true } };
    assert.equal(next.transition(id, f.command({ to: 'in_review' })).ok, true);
    assert.equal(f.store.read(id).task.delivery.state, 'in_review');
    assert.equal(readCard(f.repo, id).raw, f.original);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'run\nrun\n');
  } finally { await f.close(); }
});

test('a designated blocker owner can resolve its decision without gaining implementation authority', () => {
  const f = fixture(); f.prepare();
  const blocker = { category: 'product_decision', owner: 'agent-role:outsider', since: new Date().toISOString(), evidence: 'Decision pending', next_action: 'Record decision' };
  assert.equal(f.session().block(id, f.command({ blocker })).ok, true);
  const owner = f.session(f.outsider);
  assert.equal(owner.readTask(id).task.blocker.owner, blocker.owner);
  assert.equal(owner.assign(id, f.command({ role: 'implementation', owner: blocker.owner, handoff })).code, 'not_authorized');
  assert.equal(owner.resolve(id, f.command({ handoff })).ok, true);
  assert.equal(owner.readTask(id).code, 'not_authorized');
});

test('source changes during evidence resolution cannot initialize a stale mapping', () => {
  const f = fixture(), file = path.join(f.repo, '.todomd/tasks', readCard(f.repo, id).file);
  const s = f.session(f.operator, { resolveWorkflow: () => {
    fs.appendFileSync(file, '\nChanged during resolution\n');
    return { writers_fenced: true, busy: false, ready };
  } });
  assert.equal(s.initialize(id, f.initialize()).ok, false);
  assert.equal(f.store.read(id), null);
});
