import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { machineIdentity, privateDirectory, writeOnce, refKey, pause } from './delivery-local-state.js';
import { projectAdmissionDirectory } from './delivery-paths.js';

const context = new AsyncLocalStorage();
const listeners = new Set();
let notificationPending = false;
function changed() {
  if (notificationPending) return;
  notificationPending = true;
  queueMicrotask(() => { notificationPending = false; for (const fn of listeners) { try { fn(); } catch {} } });
}
export function onAdmissionRelease(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const kinds = new Set(['metadata', 'repository', 'launch']);
const fail = (code, message) => ({ ok: false, code, message });
const ownerFile = (root, epoch) => path.join(root, `${epoch}.owner.json`);
const doneFile = (root, epoch) => path.join(root, `${epoch}.done.json`);
const seal = value => ({ ...value, checksum: refKey(value) });
function read(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid admission record.');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const { checksum, ...value } = record || {};
    if (checksum !== refKey(value)) throw new Error('Invalid admission checksum.');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Epochs are never renamed, removed or reused. A stale recovery can close only
// its exact numbered owner, not a replacement that acquired the next epoch.
export function admissionStatus(directory) {
  const root = path.resolve(directory);
  if (!privateDirectory(root)) return { enabled: false, epoch: 1, owner: null };
  for (let epoch = 1; Number.isSafeInteger(epoch); epoch++) {
    let owner = read(ownerFile(root, epoch));
    const done = read(doneFile(root, epoch));
    // A rival may have published and completed this epoch between our reads.
    if (!owner && done) owner = read(ownerFile(root, epoch));
    if (!owner) {
      if (done) throw new Error('Admission history has a missing owner.');
      if (fs.readdirSync(root).some(name => /^\d+\.(owner|done)\.json$/.test(name) && Number(name.split('.')[0]) > epoch)) {
        if (read(ownerFile(root, epoch))) { epoch--; continue; }
        throw new Error('Admission history has a missing epoch.');
      }
      return { enabled: true, epoch, owner: null };
    }
    if (owner.format !== 1 || owner.epoch !== epoch || !kinds.has(owner.kind) ||
      !identity(owner.nonce) || !Number.isSafeInteger(owner.pid) || owner.pid < 2 ||
      typeof owner.host !== 'string' || !owner.host || typeof owner.boot !== 'string' || !owner.boot ||
      !(owner.task_id === null || identity(owner.task_id))) throw new Error('Invalid admission owner.');
    if (!done) return { enabled: true, epoch, owner };
    if (done.format !== 1 || done.epoch !== epoch || done.owner_checksum !== owner.checksum ||
      !['released', 'recovered'].includes(done.outcome)) throw new Error('Invalid admission completion.');
  }
  throw new Error('Admission history exhausted.');
}

function release(token) {
  if (token.borrowed) return;
  token.active = false; // revoke inherited async continuations before publication
  const owner = read(ownerFile(token.root, token.owner.epoch));
  if (owner?.checksum !== token.owner.checksum) throw new Error('Admission ownership changed.');
  writeOnce(doneFile(token.root, owner.epoch), seal({ format: 1, epoch: owner.epoch,
    owner_checksum: owner.checksum, outcome: 'released' }));
  changed();
}
function acquire(directory, kind, taskId, { existingOnly = false, borrow = true } = {}) {
  const root = path.resolve(directory), inherited = context.getStore()?.get(root);
  if (borrow && inherited?.active) return { ok: true, token: { ...inherited, borrowed: true } };
  const status = admissionStatus(root);
  if (!status.enabled && existingOnly) return { ok: true, token: null };
  if (status.owner) return fail('write_busy', 'A project admission owner is active or requires reconciliation.');
  if (!kinds.has(kind) || !(taskId === null || identity(taskId))) throw new Error('Invalid admission scope.');
  const owner = seal({ format: 1, epoch: status.epoch, kind, task_id: taskId,
    nonce: randomUUID(), pid: process.pid, ...machineIdentity() });
  privateDirectory(root, true);
  if (!writeOnce(ownerFile(root, owner.epoch), owner)) return fail('write_busy', 'Another writer claimed project admission.');
  return { ok: true, token: { root, owner, active: true } };
}
function enter(token, fn) {
  if (!token || token.borrowed) return fn();
  const held = new Map(context.getStore() || []); held.set(token.root, token);
  return context.run(held, fn);
}
export function withAdmissionSync(directory, kind, taskId, fn, options) {
  const claim = acquire(directory, kind, taskId, options);
  if (!claim.ok) return claim;
  try { return { ok: true, value: enter(claim.token, fn) }; }
  finally { if (claim.token) release(claim.token); }
}
export const admissionHeld = directory => context.getStore()?.get(path.resolve(directory))?.active === true;
export async function withAdmission(directory, kind, taskId, fn, { existingOnly = false } = {}) {
  if (!['repository', 'launch'].includes(kind)) throw new Error('Asynchronous metadata admission is not supported.');
  const root = path.resolve(directory);
  // A synchronous launch token must not be borrowed across an await. Nested
  // repository work is already handled by board.js's revocable repo context.
  const deadline = Date.now() + 10000;
  while (true) {
    const claim = acquire(root, kind, taskId, { existingOnly, borrow: false });
    if (claim.ok) {
      try { return await enter(claim.token, fn); }
      finally { if (claim.token) release(claim.token); }
    }
    if (Date.now() >= deadline) throw Object.assign(new Error(claim.message), { code: 'delivery_admission_busy' });
    await pause(50);
  }
}
export const withExistingProjectAdmission = (repoPath, fn) =>
  withAdmission(projectAdmissionDirectory(repoPath), 'repository', null, fn, { existingOnly: true });
export const withoutAdmissionContext = fn => context.run(new Map(), fn);

export function recoverAdmission(directory, { epoch, nonce } = {}) {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !identity(nonce)) return fail('invalid_request', 'Supply the exact admission epoch and nonce.');
  const root = path.resolve(directory);
  let status, owner;
  try {
    status = admissionStatus(root);
    owner = status.enabled ? read(ownerFile(root, epoch)) : null;
  } catch { return fail('corrupt_admission', 'Admission history cannot be verified; no record was replaced.'); }
  if (!owner || owner.nonce !== nonce) return fail('stale_admission', 'The expected admission owner does not match.');
  if (status.epoch > epoch) return { ok: true, epoch, replayed: true };
  if (status.epoch !== epoch) return fail('stale_admission', 'Read the current admission owner.');
  // Only metadata transactions are confined to this synchronous process.
  // Repository/git operations and launches can leave children or remote work.
  if (owner.kind !== 'metadata') return fail('external_reconciliation_required', 'Confirm all repository or launch work stopped through its execution authority.');
  const machine = machineIdentity();
  if (owner.host !== machine.host || owner.boot !== machine.boot) return fail('unknown_process', 'The recorded host or boot requires operator reconciliation.');
  try { process.kill(owner.pid, 0); return fail('owner_alive', 'The recorded transaction process still exists; ownership is retained.'); }
  catch (error) { if (error.code !== 'ESRCH') return fail('unknown_process', 'Process absence could not be confirmed.'); }
  try {
    writeOnce(doneFile(root, epoch), seal({ format: 1, epoch, owner_checksum: owner.checksum,
      outcome: 'recovered', evidence: 'same-host-and-boot:transaction-process-absent' }));
  } catch { return fail('commit_uncertain', 'Read admission state before retrying this exact recovery.'); }
  changed();
  return { ok: true, epoch, effect: 'transaction_gate_only' };
}
