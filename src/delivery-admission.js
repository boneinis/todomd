import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { machineIdentity, privateDirectory, writeOnce, refKey, pause, localRef } from './delivery-local-state.js';
import { sameExecution } from './delivery-execution-state.js';
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
const LOCAL_LAUNCH = 'registered-local-job-v1';
const REPOSITORY_COMMAND = 'local-repository-command-v1';
function repositoryBinding(kind, taskId, command) {
  if (command === undefined) return {};
  if (kind !== 'repository' || taskId !== null || !identity(command?.lock_nonce) ||
    Object.keys(command).length !== 2) throw new Error('Invalid repository command scope.');
  const execution = localRef(command.execution, 'repository-write');
  if (execution.task_id !== 'repository-write' || Object.keys(command.execution).length !== Object.keys(execution).length) throw new Error('Invalid repository command identity.');
  return { repository_authority: REPOSITORY_COMMAND, repository_command: { execution, lock_nonce: command.lock_nonce } };
}
function launchBinding(kind, taskId, execution) {
  if (execution === undefined) return {};
  if (kind !== 'launch' || !/^local-job-[a-f0-9]{64}$/.test(execution?.backend)) throw new Error('Invalid local launch scope.');
  const ref = localRef(execution, execution.backend);
  if (ref.task_id !== taskId || Object.keys(execution).length !== Object.keys(ref).length) throw new Error('Invalid local launch identity.');
  return { launch_authority: LOCAL_LAUNCH, execution: ref };
}
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
    if (owner.launch_authority !== undefined || owner.execution !== undefined) {
      if (owner.launch_authority !== LOCAL_LAUNCH || owner.execution === undefined ||
        JSON.stringify(launchBinding(owner.kind, owner.task_id, owner.execution).execution) !== JSON.stringify(owner.execution)) throw new Error('Invalid launch binding.');
    }
    if (owner.repository_authority !== undefined || owner.repository_command !== undefined) {
      if (owner.repository_authority !== REPOSITORY_COMMAND || owner.repository_command === undefined ||
        JSON.stringify(repositoryBinding(owner.kind, owner.task_id, owner.repository_command).repository_command) !== JSON.stringify(owner.repository_command)) throw new Error('Invalid repository command binding.');
    }
    if (!done) return { enabled: true, epoch, owner };
    if (done.format !== 1 || done.epoch !== epoch || done.owner_checksum !== owner.checksum ||
      !['released', 'recovered'].includes(done.outcome)) throw new Error('Invalid admission completion.');
  }
  throw new Error('Admission history exhausted.');
}

function release(token) {
  if (token.borrowed) return;
  token.active = false; // revoke inherited async continuations before publication
  if (token.retained) return; // uncertain child closure keeps the durable gate held
  const owner = read(ownerFile(token.root, token.owner.epoch));
  if (owner?.checksum !== token.owner.checksum) throw new Error('Admission ownership changed.');
  writeOnce(doneFile(token.root, owner.epoch), seal({ format: 1, epoch: owner.epoch,
    owner_checksum: owner.checksum, outcome: 'released' }));
  changed();
}
function acquire(directory, kind, taskId, { existingOnly = false, borrow = true, localExecution, repositoryCommand } = {}) {
  const binding = { ...launchBinding(kind, taskId, localExecution), ...repositoryBinding(kind, taskId, repositoryCommand) };
  const root = path.resolve(directory), inherited = context.getStore()?.get(root);
  if (borrow && localExecution === undefined && repositoryCommand === undefined && inherited?.active) return { ok: true, token: { ...inherited, borrowed: true } };
  const status = admissionStatus(root);
  if (!status.enabled && existingOnly) return { ok: true, token: null };
  if (status.owner) return fail('write_busy', 'A project admission owner is active or requires reconciliation.');
  if (!kinds.has(kind) || !(taskId === null || identity(taskId))) throw new Error('Invalid admission scope.');
  const owner = seal({ format: 1, epoch: status.epoch, kind, task_id: taskId,
    nonce: randomUUID(), pid: process.pid, ...machineIdentity(), ...binding });
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
export function retainAdmission(directory) {
  const token = context.getStore()?.get(path.resolve(directory));
  if (!token?.active || !token.owner.repository_command) throw new Error('No repository command admission is held.');
  token.retained = true;
}
export async function withAdmission(directory, kind, taskId, fn, { existingOnly = false, localExecution, repositoryCommand } = {}) {
  if (!['repository', 'launch'].includes(kind)) throw new Error('Asynchronous metadata admission is not supported.');
  const execution = launchBinding(kind, taskId, localExecution).execution;
  const repository = repositoryBinding(kind, taskId, repositoryCommand).repository_command;
  const root = path.resolve(directory);
  // A synchronous launch token must not be borrowed across an await. Nested
  // repository work is already handled by board.js's revocable repo context.
  const deadline = Date.now() + 10000;
  while (true) {
    const claim = acquire(root, kind, taskId, { existingOnly, borrow: false, localExecution: execution, repositoryCommand: repository });
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

function recoveryState(root, epoch, nonce) {
  let status, owner;
  try {
    status = admissionStatus(root);
    owner = status.enabled ? read(ownerFile(root, epoch)) : null;
  } catch { return fail('corrupt_admission', 'Admission history cannot be verified; no record was replaced.'); }
  if (!owner || owner.nonce !== nonce) return fail('stale_admission', 'The expected admission owner does not match.');
  if (status.epoch > epoch) return { ok: true, epoch, replayed: true };
  if (status.epoch !== epoch) return fail('stale_admission', 'Read the current admission owner.');
  return { ok: true, owner };
}
function deadOwner(owner) {
  let machine;
  try { machine = machineIdentity(); } catch { return fail('unknown_process', 'The host or boot could not be verified.'); }
  if (owner.host !== machine.host || owner.boot !== machine.boot) return fail('unknown_process', 'The recorded host or boot requires operator reconciliation.');
  try { process.kill(owner.pid, 0); return fail('owner_alive', 'The recorded transaction process still exists; ownership is retained.'); }
  catch (error) { if (error.code !== 'ESRCH') return fail('unknown_process', 'Process absence could not be confirmed.'); }
  return { ok: true };
}
function finishRecovery(root, owner, evidence, effect) {
  const { epoch, nonce } = owner, current = recoveryState(root, epoch, nonce);
  if (!current.ok || current.replayed) return current;
  if (current.owner.checksum !== owner.checksum) return fail('stale_admission', 'The admission owner changed during recovery.');
  const dead = deadOwner(current.owner);
  if (!dead.ok) return dead;
  try {
    writeOnce(doneFile(root, epoch), seal({ format: 1, epoch, owner_checksum: owner.checksum,
      outcome: 'recovered', evidence }));
  } catch { return fail('commit_uncertain', 'Read admission state before retrying this exact recovery.'); }
  changed();
  return { ok: true, epoch, effect };
}
export function recoverAdmission(directory, command = {}, { reconcileLaunch, reconcileRepository } = {}) {
  const { epoch, nonce } = command || {};
  if (!command || Object.keys(command).some(k => !['epoch', 'nonce'].includes(k)) || !Number.isSafeInteger(epoch) || epoch < 1 || !identity(nonce)) return fail('invalid_request', 'Supply only the exact admission epoch and nonce.');
  const root = path.resolve(directory), current = recoveryState(root, epoch, nonce);
  if (!current.ok || current.replayed) return current;
  const owner = current.owner;
  if (owner.kind === 'metadata') return finishRecovery(root, owner, 'same-host-and-boot:transaction-process-absent', 'transaction_gate_only');
  // A binding attests that this scope launches ONLY this registered local job.
  // Unbound launch/repository owners may have unrelated children or remote work.
  const repository = owner.kind === 'repository' && owner.repository_authority === REPOSITORY_COMMAND;
  const reconcile = repository ? reconcileRepository : owner.kind === 'launch' && owner.launch_authority === LOCAL_LAUNCH ? reconcileLaunch : null;
  if (typeof reconcile !== 'function') return fail('external_reconciliation_required', 'Confirm all repository or launch work stopped through its execution authority.');
  const ref = repository ? owner.repository_command.execution : owner.execution;
  const dead = deadOwner(owner);
  if (!dead.ok) return dead;
  return (async () => {
    let observation;
    try { observation = await reconcile(Object.freeze({ ...owner, ...(owner.execution ? { execution: Object.freeze({ ...owner.execution }) } : {}),
      ...(repository ? { repository_command: Object.freeze({ ...owner.repository_command, execution: Object.freeze({ ...ref }) }) } : {}) })); }
    catch { return fail('stop_unconfirmed', 'Local execution closure could not be verified; admission remains held.'); }
    if (!sameExecution(ref, observation) || observation.state !== 'stopped' || observation.closed !== true) return fail('stop_unconfirmed', 'The exact local execution must be stopped and permanently closed.');
    return finishRecovery(root, owner, repository ? 'local-repository-command:stopped-and-closed' : 'registered-local-job:stopped-and-closed', repository ? 'repository_gate_only' : 'launch_gate_only');
  })();
}
