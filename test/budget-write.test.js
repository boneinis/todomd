import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { budgetWrite } from '../src/budget-write.js';
import { admissionStatus } from '../src/delivery-admission.js';
import { recoverProjectAdmission } from '../src/delivery-launch-recovery.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { withRepoLock, readCard } from '../src/board.js';
import { refKey, pause } from '../src/delivery-local-state.js';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { seedDelivery } from './delivery-fixture.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const cli = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()); writeCard(repo, 'task-0001', { status: 'Planned' });
  const directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  const marker = path.join(repo, 'fixture.txt');
  const run = (script, extra = {}) => budgetWrite(repo, { command: process.execPath, args: ['-e', script], ...extra });
  return { repo, directory, gate, marker, run };
}
async function until(fn) {
  for (let i = 0; i < 600; i++) { if (fn()) return; await pause(25); }
  throw new Error('Budget fixture timed out');
}
const request = owner => ({ epoch: owner.epoch, nonce: owner.nonce });
function launch(f, script, timeout = 30000) {
  const child = spawn(process.execPath, [cli, 'budget-write', f.repo, '--timeout-ms', String(timeout), '--', process.execPath, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, out, err })); });
  return { child, exited };
}

test('bounded commands retain admission through descendants and serialize board writers and metadata', { skip: !supported }, async () => {
  const f = fixture(), childDone = path.join(f.repo, 'child-done.txt');
  const childCode = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(childDone)},'done'),300)`;
  const run = f.run(`require('fs').writeFileSync(${JSON.stringify(f.marker)},'started');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});process.exit(0)`);
  await until(() => fs.existsSync(f.marker));
  const owner = admissionStatus(f.gate).owner;
  assert.equal(owner.repository_authority, 'local-repository-command-v1');
  const store = createDeliveryStore(f.directory, { enabled: true });
  assert.equal(store.execute('task-0002', { action: 'initialize', expected_revision: 0, idempotency_key: 'blocked' }).code, 'write_busy');
  let wrote = false;
  const write = withRepoLock(f.repo, () => { assert.equal(fs.existsSync(childDone), true); wrote = true; });
  assert.equal(wrote, false);
  const result = await run; assert.equal(result.ok, true); assert.equal(result.exit_code, 0);
  await write; assert.equal(wrote, true); assert.equal(admissionStatus(f.gate).owner, null);
  assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), false);
});

test('failed commands and deadlines preserve changes and close their group before unlocking', { skip: !supported }, async () => {
  const f = fixture();
  const failed = await f.run(`require('fs').writeFileSync(${JSON.stringify(f.marker)},'preserved');console.log('fixture output');process.exit(7)`);
  assert.equal(failed.ok, false); assert.equal(failed.exit_code, 7);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'preserved');
  assert.equal(fs.readFileSync(failed.output_file, 'utf8').trim(), 'fixture output');
  const timed = await f.run('setInterval(()=>{},1000)', { timeoutMs: 150 });
  assert.equal(timed.code, 'timeout'); assert.equal(admissionStatus(f.gate).owner, null);
  assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), false);
  for (const folder of fs.readdirSync(path.join(f.directory, 'repository-writes'))) {
    const directory = path.join(f.directory, 'repository-writes', folder);
    assert.equal(fs.existsSync(path.join(directory, 'closed.json')), true);
    assert.equal(fs.readFileSync(path.join(directory, 'command.json'), 'utf8').includes('fixture output'), false);
  }
});

test('managed or mixed boards are refused before spawning a shell command', { skip: !supported }, async () => {
  for (const kind of ['private', 'authored']) {
    const f = fixture();
    if (kind === 'private') seedDelivery(f.repo, 'task-0001');
    else writeCard(f.repo, 'task-0002', { status: 'Planned', extra: 'schema_version: 2\n' });
    const before = readCard(f.repo, 'task-0001').raw;
    assert.equal((await f.run(`require('fs').writeFileSync(${JSON.stringify(f.marker)},'must not run')`)).code, 'delivery_managed');
    assert.equal(fs.existsSync(f.marker), false); assert.equal(readCard(f.repo, 'task-0001').raw, before);
    assert.equal(admissionStatus(f.gate).owner, null);
  }
});

test('a killed helper recovers through exact backend closure and nonce-fenced file-lock cleanup', { skip: !supported }, async () => {
  const f = fixture(), p = launch(f, `require('fs').writeFileSync(${JSON.stringify(f.marker)},'candidate');setInterval(()=>{},1000)`);
  let owner;
  try {
    await until(() => fs.existsSync(f.marker)); owner = admissionStatus(f.gate).owner;
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'owner_alive');
    p.child.kill('SIGKILL'); await p.exited;
    assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), true);
    const result = await recoverProjectAdmission(f.repo, request(owner));
    assert.equal(result.ok, true); assert.equal(result.effect, 'repository_gate_only');
    assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), false);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'candidate');
    await withRepoLock(f.repo, () => {
      assert.equal(recoverProjectAdmission(f.repo, request(owner)).replayed, true);
      assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), true);
    });
  } finally {
    if (p.child.exitCode === null && p.child.signalCode === null) { p.child.kill('SIGKILL'); await p.exited; }
    if (owner && admissionStatus(f.gate).owner) await recoverProjectAdmission(f.repo, request(owner));
  }
});

test('missing command receipts hold recovery without removing the legacy lock', { skip: !supported }, async () => {
  const f = fixture(), p = launch(f, `require('fs').writeFileSync(${JSON.stringify(f.marker)},'ready');setInterval(()=>{},1000)`);
  let owner, file;
  try {
    await until(() => fs.existsSync(f.marker)); owner = admissionStatus(f.gate).owner;
    p.child.kill('SIGKILL'); await p.exited;
    file = path.join(f.directory, 'repository-writes', refKey(owner.repository_command.execution), 'command.json');
    fs.renameSync(file, file + '.fixture');
    assert.equal((await recoverProjectAdmission(f.repo, request(owner))).code, 'stop_unconfirmed');
    assert.equal(fs.existsSync(path.join(f.repo, '.todomd/.lock')), true);
    assert.deepEqual(admissionStatus(f.gate).owner, owner);
  } finally {
    if (file && fs.existsSync(file + '.fixture')) fs.renameSync(file + '.fixture', file);
    if (p.child.exitCode === null && p.child.signalCode === null) { p.child.kill('SIGKILL'); await p.exited; }
    if (owner) await recoverProjectAdmission(f.repo, request(owner));
  }
});

test('uncertain process closure retains admission after the CLI returns', { skip: !supported }, async () => {
  const f = fixture(), p = launch(f, `require('fs').writeFileSync(${JSON.stringify(f.marker)},String(process.pid));setInterval(()=>{},1000)`, 1500);
  let owner, jobPid;
  try {
    await until(() => fs.existsSync(f.marker)); jobPid = Number(fs.readFileSync(f.marker, 'utf8')); owner = admissionStatus(f.gate).owner;
    const folder = path.join(f.directory, 'repository-writes', refKey(owner.repository_command.execution));
    const controller = JSON.parse(fs.readFileSync(path.join(folder, 'supervisor.json'), 'utf8'));
    const guardian = JSON.parse(fs.readFileSync(path.join(folder, 'guardian.json'), 'utf8'));
    // These are isolated fixture children we just launched, never live-board PIDs.
    process.kill(controller.pid, 'SIGSTOP'); process.kill(guardian.pid, 'SIGSTOP');
    process.kill(controller.pid, 'SIGKILL'); process.kill(guardian.pid, 'SIGKILL');
    const result = await p.exited;
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.out).code, 'stop_unconfirmed');
    assert.deepEqual(admissionStatus(f.gate).owner, owner);
  } finally {
    if (jobPid) { try { process.kill(jobPid, 'SIGKILL'); } catch {} }
    if (p.child.exitCode === null && p.child.signalCode === null) { p.child.kill('SIGKILL'); await p.exited; }
    if (owner) assert.equal((await recoverProjectAdmission(f.repo, request(owner))).ok, true);
  }
});
