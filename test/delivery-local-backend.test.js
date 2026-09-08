import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, fork } from 'node:child_process';
import { tmp } from './helpers.js';
import { createLocalDeliveryBackend } from '../src/delivery-local-backend.js';
import { localRef, refKey, writeOnce, readRegistration, pause, sealRegistration, groupAlive } from '../src/delivery-local-state.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryExecutionCoordinator } from '../src/delivery-execution.js';
import { executionRef } from '../src/delivery-execution-state.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const ref = localRef({ task_id: 'task-0001', lease_id: 'lease-1', run_id: 'run-1', fence: 1, backend: 'local', source_revision: 'a'.repeat(64) }, 'local');
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await pause(25); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for local execution fixture.');
}
function fixture() {
  const directory = path.join(tmp('local-backend'), 'executions'), cwd = tmp('local-candidate');
  let allowed = true;
  const job = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd, containment: 'local_process_group' };
  const options = { enabled: true, graceMs: 50, closeTimeoutMs: 2000, authorizeStart: () => allowed, resolveJob: () => job };
  const backend = () => createLocalDeliveryBackend(directory, options);
  const runDir = path.join(directory, refKey(ref));
  return { directory, cwd, runDir, job, options, backend, set allowed(v) { allowed = v; } };
}

test('disabled and unauthorized local execution cannot create private state or launch commands', { skip: !supported }, async () => {
  const f = fixture();
  const disabled = createLocalDeliveryBackend(f.directory);
  for (const method of ['start', 'close', 'inspect']) await assert.rejects(disabled[method](ref), /not enabled/);
  f.allowed = false;
  await assert.rejects(f.backend().start(ref), /not authorized/);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal((await f.backend().inspect(ref)).state, 'unknown');
  assert.equal(fs.existsSync(f.directory), false);
});

test('closure before start and during asynchronous job resolution permanently blocks late submissions', { skip: !supported }, async () => {
  const f = fixture();
  await f.backend().close(ref);
  assert.equal((await f.backend().start(ref)).closed, true);
  assert.equal((await f.backend().inspect(ref)).state, 'stopped');
  assert.equal(fs.existsSync(path.join(f.runDir, 'supervisor.json')), false);
  const g = fixture(), gate = pending(), entered = pending();
  g.options.resolveJob = async () => { entered.resolve(); await gate.promise; return g.job; };
  const start = g.backend().start(ref); await entered.promise;
  await g.backend().close(ref); gate.resolve();
  assert.equal((await start).closed, true);
  assert.equal(fs.existsSync(path.join(g.runDir, 'supervisor.json')), false);
});

test('a restarted backend stops a real supervised group and retains private candidate evidence', { skip: !supported }, async () => {
  const f = fixture(), candidate = path.join(f.cwd, 'candidate.txt');
  f.job.args = ['-e', `require('fs').writeFileSync(${JSON.stringify(candidate)}, 'preserved'); console.log('fixture output'); setInterval(() => {},1000)`];
  try {
    assert.equal((await f.backend().start(ref)).accepted, true);
    await until(() => fs.existsSync(candidate));
    assert.equal((await f.backend().inspect(ref)).state, 'running');
    const registration = readRegistration(f.runDir, ref);
    assert.equal(fs.statSync(path.join(f.runDir, 'supervisor.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(registration.socket).mode & 0o777, 0o600);
    await f.backend().close(ref);
    const observation = await f.backend().inspect(ref);
    assert.equal(observation.closed, true); assert.equal(observation.state, 'stopped');
    assert.doesNotMatch(JSON.stringify(observation), /nonce|socket|\.log|pid|fixture output/);
    assert.equal(fs.readFileSync(candidate, 'utf8'), 'preserved');
    assert.equal((await f.backend().start(ref)).closed, true);
    assert.equal(fs.existsSync(registration.socket), false);
  } finally { await f.backend().close(ref); }
});

test('natural completion closes the identity after the process group drains', { skip: !supported }, async () => {
  const f = fixture(); f.job.args = ['-e', 'console.log("completed");'];
  try {
    await f.backend().start(ref);
    await until(async () => (await f.backend().inspect(ref)).state === 'stopped');
    assert.equal((await f.backend().start(ref)).closed, true);
    const result = JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8'));
    assert.equal(result.code, 0);
  } finally { await f.backend().close(ref); }
});

test('a background descendant keeps ownership after its command leader exits', { skip: !supported }, async () => {
  const f = fixture(), alive = path.join(f.cwd, 'descendant.pid');
  const childCode = `require('fs').writeFileSync(${JSON.stringify(alive)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  f.job.args = ['-e', `const p=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});p.unref();`];
  try {
    await f.backend().start(ref); await until(() => fs.existsSync(alive));
    await pause(100);
    assert.equal((await f.backend().inspect(ref)).state, 'running');
    await f.backend().close(ref);
    assert.equal((await f.backend().inspect(ref)).state, 'stopped');
  } finally { await f.backend().close(ref); }
});

test('six independent callers share one immutable start claim and launch one command', { skip: !supported }, async () => {
  const f = fixture(), count = path.join(f.cwd, 'starts');
  const script = `import { createLocalDeliveryBackend } from ${JSON.stringify(new URL('../src/delivery-local-backend.js', import.meta.url).href)};
    const b=createLocalDeliveryBackend(process.argv[1], {enabled:true,graceMs:50,closeTimeoutMs:2000,authorizeStart:()=>true,
      resolveJob:()=>({command:process.execPath,args:['-e',process.argv[3]],cwd:process.argv[2],containment:'local_process_group'})});
    console.log(JSON.stringify(await b.start(JSON.parse(process.argv[4]))));`;
  try {
    const code = `require('fs').appendFileSync(${JSON.stringify(count)},'start\\n');setInterval(()=>{},1000);`;
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.directory, f.cwd, code, JSON.stringify(ref)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    })));
    assert.equal(outcomes.filter(r => r.accepted).length, 1);
    await until(() => fs.existsSync(count));
    assert.equal(fs.readFileSync(count, 'utf8'), 'start\n');
    // The launcher processes have all exited; the detached supervisor survives.
    assert.equal((await f.backend().inspect(ref)).state, 'running');
  } finally { await f.backend().close(ref); }
});

test('a supervisor arriving after confirmed closure cannot launch its delayed job', { skip: !supported }, async () => {
  const f = fixture(), launched = path.join(f.cwd, 'must-not-exist');
  fs.mkdirSync(f.runDir, { recursive: true }); writeOnce(path.join(f.runDir, 'start.json'), ref);
  await f.backend().close(ref);
  f.job.args = ['-e', `require('fs').writeFileSync(${JSON.stringify(launched)},'launched')`];
  const child = fork(new URL('../src/delivery-local-supervisor.js', import.meta.url), [],
    { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Delayed supervisor failed')));
    child.send({ ref, directory: f.runDir, job: f.job, graceMs: 50 });
  });
  assert.equal(fs.existsSync(launched), false);
  assert.equal((await f.backend().inspect(ref)).state, 'stopped');
});

test('a dead supervisor with a surviving group remains held until its descendants actually stop', { skip: !supported }, async () => {
  const f = fixture(); let registration;
  try {
    await f.backend().start(ref); registration = readRegistration(f.runDir, ref);
    process.kill(registration.pid, 'SIGKILL');
    await pause(50);
    assert.equal(await groupAlive(registration.pid), true);
    await assert.rejects(f.backend().close(ref), /stop is unconfirmed/);
    assert.equal((await f.backend().inspect(ref)).state, 'unknown');
    assert.equal(await groupAlive(registration.pid), true, 'recovery never signals a saved process-group ID');
  } finally {
    // Test-only cleanup of the exact group just created by this fixture.
    if (registration) {
      try { process.kill(-registration.pid, 'SIGKILL'); } catch {}
      await until(async () => !await groupAlive(registration.pid));
    }
    await f.backend().close(ref);
  }
});

test('checksum, host and boot mismatches never establish stop evidence', { skip: !supported }, async () => {
  const f = fixture(); let good;
  try {
    await f.backend().start(ref);
    const file = path.join(f.runDir, 'supervisor.json'); good = fs.readFileSync(file);
    const changed = JSON.parse(good); changed.pid++;
    fs.writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(f.backend().inspect(ref), /registration/);
    const { checksum, ...record } = JSON.parse(good);
    for (const fields of [{ host: 'another-machine' }, { boot: 'another-boot' }]) {
      fs.writeFileSync(file, JSON.stringify(sealRegistration({ ...record, ...fields })));
      assert.equal((await f.backend().inspect(ref)).state, 'unknown');
    }
  } finally {
    if (good) fs.writeFileSync(path.join(f.runDir, 'supervisor.json'), good);
    await f.backend().close(ref);
  }
});

test('the real backend completes coordinator reservation, dispatch, closure observation and fenced release', { skip: !supported }, async () => {
  const f = fixture(), directory = path.join(tmp('local-coordinator'), 'store');
  const owner = 'agent-role:builder';
  const context = { actor_id: 'human:owner', busy: false,
    grants: ['initialize','ready','in_progress','acquire','dispatch','request_stop','observe_execution','release'].map(a => `delivery:${a}`),
    execution_admission: { backend: 'local', source_revision: ref.source_revision, fenced: true },
    facts: { admission: { authorized: true, dependencies_satisfied: true, owner },
      ready: Object.fromEntries(['scope_defined','criteria_defined','validation_plan','target_known','dependencies_valid','planning_approved'].map(k => [k,true])) } };
  const store = createDeliveryStore(directory, { enabled: true, resolveContext: () => context });
  let counter = 0;
  const command = fields => ({ expected_revision: store.read(ref.task_id)?.revision || 0, idempotency_key: `key-${++counter}`,
    ...(store.read(ref.task_id)?.lease ? executionRef(store.read(ref.task_id)) : {}), ...fields });
  store.execute(ref.task_id, command({ action: 'initialize', source_revision: ref.source_revision,
    task: { id: ref.task_id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' },
      ownership: { delivery_lead: 'human:owner', implementation: owner, reviewer: 'agent-role:reviewer' } } }));
  store.execute(ref.task_id, command({ action: 'transition', to: 'ready' }));
  f.options.authorizeStart = value => {
    const current = store.read(value.task_id);
    return current?.lease && JSON.stringify(executionRef(current)) === JSON.stringify(value) && current.execution.phase === 'dispatching';
  };
  const coordinator = () => createDeliveryExecutionCoordinator(directory, { enabled: true, resolveContext: () => context,
    backends: { local: f.backend() } });
  let active;
  try {
    assert.equal(coordinator().reserve(ref.task_id, command({ run_id: 'run-real', ttl_ms: 60000,
      execution: { backend: 'local', source_revision: ref.source_revision } })).ok, true);
    active = executionRef(store.read(ref.task_id));
    assert.equal((await coordinator().dispatch(ref.task_id, command())).ok, true);
    assert.equal((await coordinator().reconcile(ref.task_id, command())).ok, true);
    assert.equal(store.read(ref.task_id).execution.phase, 'running');
    assert.equal(coordinator().release(ref.task_id, command({ handoff: { evidence: 'candidate:kept', next_action: 'review' } })).code, 'stop_unconfirmed');
    assert.equal((await coordinator().stop(ref.task_id, command())).ok, true);
    assert.equal((await coordinator().reconcile(ref.task_id, command())).ok, true);
    assert.equal(coordinator().release(ref.task_id, command({ handoff: { evidence: 'candidate:kept', next_action: 'review' } })).ok, true);
    assert.equal(store.read(ref.task_id).lease, null);
    assert.equal(store.read(ref.task_id).last_handoff.evidence, 'candidate:kept');
  } finally { if (active) await f.backend().close(active); }
});

test('wrong control credentials cannot stop an execution, and corrupt registration fails closed', { skip: !supported }, async () => {
  const f = fixture(); let good;
  try {
    await f.backend().start(ref);
    const r = readRegistration(f.runDir, ref);
    await new Promise(resolve => {
      const socket = net.createConnection(r.socket, () => socket.write('{"nonce":"wrong","action":"stop"}\n'));
      socket.on('close', resolve); socket.on('error', resolve);
    });
    assert.equal((await f.backend().inspect(ref)).state, 'running');
    const file = path.join(f.runDir, 'supervisor.json'); good = fs.readFileSync(file);
    fs.writeFileSync(file, '{broken');
    await assert.rejects(f.backend().inspect(ref));
    await assert.rejects(f.backend().close(ref));
    fs.writeFileSync(file, good); good = null;
    await f.backend().close(ref);
  } finally {
    if (good) fs.writeFileSync(path.join(f.runDir, 'supervisor.json'), good);
    await f.backend().close(ref);
  }
});

test('abandoned start claims can close without deleting history or launching a replacement', { skip: !supported }, async () => {
  const f = fixture(); fs.mkdirSync(f.runDir, { recursive: true });
  writeOnce(path.join(f.runDir, 'start.json'), ref);
  assert.equal((await f.backend().start(ref)).replayed, true);
  assert.equal((await f.backend().inspect(ref)).state, 'unknown');
  await f.backend().close(ref);
  assert.equal((await f.backend().inspect(ref)).state, 'stopped');
  assert.equal(fs.existsSync(path.join(f.runDir, 'start.json')), true);
});

test('a closure interrupted before its no-job receipt stays unknown until closure is retried', { skip: !supported }, async () => {
  const f = fixture(); fs.mkdirSync(f.runDir, { recursive: true });
  writeOnce(path.join(f.runDir, 'closed.json'));
  assert.equal((await f.backend().inspect(ref)).state, 'unknown');
  await f.backend().close(ref);
  assert.equal((await f.backend().inspect(ref)).state, 'stopped');
});

test('forced launcher death leaves the supervisor recoverable by a new backend instance', { skip: !supported }, async () => {
  const f = fixture();
  const script = `import {createLocalDeliveryBackend} from ${JSON.stringify(new URL('../src/delivery-local-backend.js', import.meta.url).href)};
    const backend=createLocalDeliveryBackend(process.argv[1],{enabled:true,graceMs:50,closeTimeoutMs:2000,
      authorizeStart:()=>true,resolveJob:()=>({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],
      cwd:process.argv[2],containment:'local_process_group'})});
    await backend.start(JSON.parse(process.argv[3]));console.log('started');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module','-e',script,f.directory,f.cwd,JSON.stringify(ref)], {stdio:['ignore','pipe','pipe']});
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    await new Promise((resolve,reject) => { child.stdout.once('data',resolve);child.once('error',reject);
      child.once('exit',() => reject(new Error('Launcher exited before dispatch'))); });
    child.kill('SIGKILL'); await exited;
    assert.equal((await f.backend().inspect(ref)).state,'running');
    await f.backend().close(ref);
    assert.equal((await f.backend().inspect(ref)).state,'stopped');
  } finally { child.kill('SIGKILL'); await exited; await f.backend().close(ref); }
});
