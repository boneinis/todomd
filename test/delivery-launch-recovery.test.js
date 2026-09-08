import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard, tmp } from './helpers.js';
import { readCard } from '../src/board.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliveryAuthority } from '../src/delivery-authority.js';
import { recoverProjectAdmission } from '../src/delivery-launch-recovery.js';
import { admissionStatus, recoverAdmission, withAdmissionSync } from '../src/delivery-admission.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { executionRef } from '../src/delivery-execution-state.js';
import { refKey, pause } from '../src/delivery-local-state.js';
import { deliveryRuntimeStatus } from '../src/delivery-runtime.js';

const supported = ['darwin', 'linux'].includes(process.platform), id = 'task-0001';
const moduleUrl = name => new URL(`../src/${name}.js`, import.meta.url).href;
const cli = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
const request = owner => ({ epoch: owner.epoch, nonce: owner.nonce });
const script = `
  import { withAdmission, admissionStatus } from ${JSON.stringify(moduleUrl('delivery-admission'))};
  import { deliveryStoreDirectory } from ${JSON.stringify(moduleUrl('delivery-paths'))};
  import { createDeliveryAuthority } from ${JSON.stringify(moduleUrl('delivery-authority'))};
  import { createLocalDeliveryBackend } from ${JSON.stringify(moduleUrl('delivery-local-backend'))};
  import path from 'node:path';
  const [repo, rawRef, rawJob, mode, rawCommand] = process.argv.slice(1);
  const ref = JSON.parse(rawRef), job = JSON.parse(rawJob), directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  if (mode === 'authority') {
    const service = createDeliveryAuthority(repo, { enabled: true, jobs: { build: job },
      authenticate: () => { if (admissionStatus(gate).owner?.kind === 'launch') process.exit(23); return { actor_id: 'agent-role:builder', project: repo }; },
      resolveAdmission: () => ({ job_approved: true, writers_fenced: true, busy: false, dependencies_satisfied: true }) });
    await service.dispatch(ref.task_id, JSON.parse(rawCommand));
    process.exit(24);
  }
  const backend = createLocalDeliveryBackend(path.join(directory, 'local-executions', ref.backend), {
    enabled: true, name: ref.backend, authorizeStart: () => true, resolveJob: () => job, graceMs: 50, closeTimeoutMs: 3000 });
  await withAdmission(gate, 'launch', ref.task_id, async () => {
    await backend.start(ref);
    if (mode === 'after') process.exit(23);
    process.send({ ready: true });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }, { localExecution: ref });
`;
function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()), cwd = tmp('launch-recovery'), directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  writeCard(repo, id, { status: 'Planned' });
  const source = createHash('sha256').update(readCard(repo, id).raw).digest('hex');
  let context = { actor_id: 'human:lead', busy: false, grants: ['delivery:initialize', 'delivery:ready'],
    facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])) } };
  const store = createDeliveryStore(directory, { enabled: true, resolveContext: () => context });
  assert.equal(store.execute(id, { action: 'initialize', expected_revision: 0, idempotency_key: 'init', source_revision: source,
    task: { id, schema_version: 2, delivery: { state: 'backlog', completion_policy: 'completed' }, ownership: { delivery_lead: 'human:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer' } } }).ok, true);
  assert.equal(store.execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready' }).ok, true);
  const marker = path.join(cwd, 'candidate.txt');
  const job = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'preserved');setInterval(()=>{},1000)`], cwd, containment: 'local_process_group' };
  const service = createDeliveryAuthority(repo, { enabled: true, jobs: { build: job }, authenticate: () => ({ actor_id: 'agent-role:builder', project: repo }),
    resolveAdmission: () => ({ job_approved: true, writers_fenced: true, busy: false, dependencies_satisfied: true }) });
  assert.equal(service.reserve(id, { expected_revision: 2, idempotency_key: 'reserve', profile: 'build', run_id: 'run-1', ttl_ms: 30000 }).ok, true);
  const ref = executionRef(store.read(id)), folder = path.join(directory, 'local-executions', ref.backend, refKey(ref));
  context = { actor_id: 'agent-role:builder', busy: false, grants: ['delivery:dispatch'], execution_admission: { backend: ref.backend, source_revision: source, fenced: true },
    facts: { admission: { owner: 'agent-role:builder', authorized: true, dependencies_satisfied: true } } };
  let key = 0, child, exited;
  const command = extra => ({ ...ref, expected_revision: store.read(id).revision, idempotency_key: `command-${++key}`, ...extra });
  const launch = async (mode = 'after') => {
    if (mode !== 'authority') assert.equal(store.execute(id, command({ action: 'dispatch' })).ok, true);
    const c = command();
    child = spawn(process.execPath, ['--input-type=module', '-e', script, repo, JSON.stringify(ref), JSON.stringify(job), mode, JSON.stringify(c)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', b => stderr += b);
    exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
    if (mode === 'running') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Launcher did not acknowledge fixture')), 15000);
        child.once('message', () => { clearTimeout(timer); resolve(); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr || 'Launcher exited early')); });
      });
    } else assert.equal(await exited, 23, stderr);
    return admissionStatus(gate).owner;
  };
  const kill = async () => { if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } };
  const finish = async () => {
    await kill();
    const owner = admissionStatus(gate).owner;
    if (owner) assert.equal((await recoverProjectAdmission(repo, request(owner))).ok, true);
    if (!store.read(id).lease) return;
    assert.equal((await service.stop(id, command())).ok, true);
    if (store.read(id).execution.phase !== 'stopped') assert.equal((await service.reconcile(id, command())).ok, true);
    assert.equal(service.release(id, command({ handoff: { evidence: 'candidate preserved', next_action: 'review' } })).ok, true);
  };
  return { repo, directory, gate, store, service, marker, ref, folder, command, launch, kill, finish };
}

test('a real authority crash before backend start binds recovery to its exact execution', { skip: !supported }, async () => {
  const f = fixture();
  try {
    const owner = await f.launch('authority');
    assert.equal(owner.launch_authority, 'registered-local-job-v1');
    assert.deepEqual(owner.execution, f.ref);
    const status = deliveryRuntimeStatus(f.repo, id);
    assert.equal(status.code, 'delivery_launch_pending');
    assert.doesNotMatch(JSON.stringify(status), /nonce|pid|checksum|source_revision|run-1|local-job-/);
    const before = f.store.read(id);
    assert.equal((await f.service.stop(id, f.command())).code, 'write_busy');
    assert.equal(recoverAdmission(f.gate, request(owner)).code, 'external_reconciliation_required');
    const recovered = await recoverProjectAdmission(f.repo, request(owner));
    assert.equal(recovered.ok, true); assert.equal(recovered.effect, 'launch_gate_only');
    assert.deepEqual(f.store.read(id), before, 'lease, journal and receipts stay untouched');
    assert.equal(fs.existsSync(path.join(f.folder, 'no-job.json')), true);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(admissionStatus(f.gate).owner, null);
    assert.equal(deliveryRuntimeStatus(f.repo, id).code, 'delivery_execution_owned');
  } finally { await f.finish(); }
});

test('a live launcher cannot be recovered and its orphaned job is closed after launcher death', { skip: !supported }, async () => {
  const f = fixture(), card = readCard(f.repo, id).raw;
  try {
    const owner = await f.launch('running');
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'owner_alive');
    assert.equal(fs.existsSync(path.join(f.folder, 'closed.json')), false);
    for (let i = 0; i < 400 && !fs.existsSync(f.marker); i++) await pause(25);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'preserved');
    await f.kill(); const before = f.store.read(id);
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).ok, true);
    assert.deepEqual(f.store.read(id), before);
    assert.equal(readCard(f.repo, id).raw, card);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'preserved');
    assert.equal((await f.service.reconcile(id, f.command())).ok, true);
    assert.equal(f.store.read(id).execution.phase, 'stopped');
  } finally { await f.finish(); }
});

test('CLI recovery and concurrent callers close one gate without retiring a replacement', { skip: !supported }, async () => {
  const f = fixture();
  try {
    const owner = await f.launch();
    const run = () => new Promise((resolve, reject) => execFile(process.execPath, [cli, 'delivery-admission', f.repo, '--recover', '--epoch', String(owner.epoch), '--nonce', owner.nonce, '--json'],
      (error, stdout, stderr) => error ? reject(new Error(stderr || stdout)) : resolve(JSON.parse(stdout))));
    const results = await Promise.all([run(), run()]);
    assert.ok(results.every(r => r.ok));
    withAdmissionSync(f.gate, 'metadata', 'task-0002', () => {
      const newer = admissionStatus(f.gate).owner;
      assert.equal(recoverProjectAdmission(f.repo, request(owner)).replayed, true);
      assert.deepEqual(admissionStatus(f.gate).owner, newer);
    });
    assert.equal(fs.existsSync(path.join(f.gate, `${owner.epoch}.owner.json`)), true);
  } finally { await f.finish(); }
});

test('wrong nonce, foreign host, unknown registration and changed journal all retain admission', { skip: !supported }, async () => {
  const f = fixture();
  try {
    const owner = await f.launch('authority'), ownerFile = path.join(f.gate, `${owner.epoch}.owner.json`);
    assert.equal((await recoverProjectAdmission(f.repo, { ...request(owner), nonce: 'wrong' })).code, 'stale_admission');
    assert.equal((await recoverProjectAdmission(f.repo, { ...request(owner), observation: { closed: true } })).code, 'invalid_request');
    const goodOwner = fs.readFileSync(ownerFile), { checksum, ...foreign } = owner;
    foreign.boot = 'another-boot'; fs.writeFileSync(ownerFile, JSON.stringify({ ...foreign, checksum: refKey(foreign) }));
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'unknown_process');
    fs.writeFileSync(ownerFile, goodOwner);
    const mismatched = { ...foreign, boot: owner.boot, execution: { ...owner.execution, fence: owner.execution.fence + 1 } };
    fs.writeFileSync(ownerFile, JSON.stringify({ ...mismatched, checksum: refKey(mismatched) }));
    try { assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed'); }
    finally { fs.writeFileSync(ownerFile, goodOwner); }
    const registration = path.join(f.directory, 'job-authorities', `${f.ref.backend}.json`), goodRegistration = fs.readFileSync(registration);
    fs.renameSync(registration, registration + '.fixture');
    try { assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed'); }
    finally { fs.renameSync(registration + '.fixture', registration); }
    fs.writeFileSync(registration, '{bad');
    try { assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed'); }
    finally { fs.writeFileSync(registration, goodRegistration); }
    const taskFile = path.join(f.directory, `${id}.json`), task = fs.readFileSync(taskFile);
    fs.writeFileSync(taskFile, '{bad');
    try { assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed'); }
    finally { fs.writeFileSync(taskFile, task); }
    assert.deepEqual(admissionStatus(f.gate).owner, owner);
    assert.equal(fs.existsSync(f.folder), false);
  } finally { await f.finish(); }
});

test('unknown, mismatched, or failed backend observations cannot release a bound gate', { skip: !supported }, async () => {
  const f = fixture();
  try {
    const owner = await f.launch('authority');
    for (const observation of [null, { ...f.ref, state: 'unknown', closed: true }, { ...f.ref, state: 'stopped', closed: false },
      { ...f.ref, fence: f.ref.fence + 1, state: 'stopped', closed: true }]) {
      assert.equal((await recoverAdmission(f.gate, request(owner), { reconcileLaunch: async () => observation })).code, 'stop_unconfirmed');
    }
    assert.equal((await recoverAdmission(f.gate, request(owner), { reconcileLaunch: async () => { throw new Error('offline'); } })).code, 'stop_unconfirmed');
    assert.deepEqual(admissionStatus(f.gate).owner, owner);
  } finally { await f.finish(); }
});

test('recovery can resume after crashing before or after completion publication', { skip: !supported }, async () => {
  for (const point of ['before', 'after']) {
    const f = fixture();
    try {
      const owner = await f.launch(), before = f.store.read(id);
      const crash = `import fs from 'node:fs';
        import { recoverProjectAdmission } from ${JSON.stringify(moduleUrl('delivery-launch-recovery'))};
        const [repo, rawRequest, done, point] = process.argv.slice(1), link = fs.linkSync;
        fs.linkSync = (from, to, ...rest) => {
          if (to === done && point === 'before') process.exit(23);
          const result = link(from, to, ...rest);
          if (to === done && point === 'after') process.exit(23);
          return result;
        };
        await recoverProjectAdmission(repo, JSON.parse(rawRequest)); process.exit(24);`;
      const code = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', crash, f.repo, JSON.stringify(request(owner)), path.join(f.gate, `${owner.epoch}.done.json`), point], { stdio: 'ignore' });
        p.on('error', reject); p.on('exit', resolve);
      });
      assert.equal(code, 23);
      assert.equal(fs.existsSync(path.join(f.folder, 'closed.json')), true);
      const recovered = await recoverProjectAdmission(f.repo, request(owner));
      assert.equal(recovered.ok, true);
      if (point === 'after') assert.equal(recovered.replayed, true);
      assert.deepEqual(f.store.read(id), before);
      assert.equal(admissionStatus(f.gate).owner, null);
    } finally { await f.finish(); }
  }
});
