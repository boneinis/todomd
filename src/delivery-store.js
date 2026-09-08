import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateDeliveryTask, evaluateDeliveryTransition, OWNER_ROLES, isOwnerId } from './delivery.js';

// Internal, opt-in persistence primitive. No production adapter imports this
// module yet. Its private directory must never be the tracked task directory.
// It does not dispatch work, edit Markdown, or make external evidence trusted.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (code, message) => ({ ok: false, code, message });
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, function (key, v) {
  return object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const handoff = v => object(v) && text(v.evidence) && text(v.next_action);
const ttl = v => Number.isSafeInteger(v) && v >= 1 && v <= 3_600_000;
const ACTIONS = new Set(['initialize', 'assign', 'acquire', 'renew', 'release', 'block', 'resolve', 'transition']);
const matchesLease = (lease, value) => object(lease) && object(value) &&
  lease.id === value.lease_id && lease.fence === value.fence && lease.run_id === value.run_id;

function readRecord(file, id) {
  let raw, descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Delivery record is not a regular file.');
    raw = fs.readFileSync(descriptor, 'utf8');
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const r = JSON.parse(raw);
  const { checksum, ...contents } = r || {};
  if (!object(r) || r.format !== 1 || !Number.isSafeInteger(r.revision) || r.revision < 1 ||
    !sha(checksum) || checksum !== fingerprint(contents) ||
    r.task?.id !== id || !validateDeliveryTask(r.task).ok || r.task.schema_version !== 2 ||
    !sha(r.source_revision) || !Array.isArray(r.events) || r.events.length !== r.revision ||
    !object(r.receipts) || !Number.isSafeInteger(r.next_fence) || r.next_fence < 1 ||
    !(r.lease === null || object(r.lease) && identity(r.lease.id) && identity(r.lease.run_id) &&
      isOwnerId(r.lease.owner) && Number.isSafeInteger(r.lease.fence) && r.lease.fence > 0 &&
      r.lease.fence < r.next_fence && Number.isSafeInteger(r.lease.expires_at))) {
    throw new Error('Invalid delivery record; reconcile private state before writing.');
  }
  return r;
}

function saveRecord(file, record) {
  delete record.checksum;
  record.checksum = fingerprint(record);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function createDeliveryStore(directory, { enabled = false, now = Date.now, resolveContext } = {}) {
  const root = path.resolve(directory);
  const fileFor = id => path.join(root, `${id}.json`);
  return {
    // Reads never create a directory and remain available during a rollout hold.
    read(id) {
      if (!identity(id)) throw new Error('Invalid task identity.');
      return readRecord(fileFor(id), id);
    },
    execute(id, command) {
      if (enabled !== true) return fail('disabled', 'Delivery writes are not enabled.');
      if (!identity(id) || !object(command) || !ACTIONS.has(command.action) ||
        !identity(command.idempotency_key) || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) {
        return fail('invalid_request', 'Supply an action, task identity, expected revision, and idempotency key.');
      }
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - 3_600_000) return fail('invalid_clock', 'A valid clock is required.');
      // No time-based lock stealing. An abandoned transaction lock requires
      // explicit operator reconciliation of its process before removal.
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const lock = path.join(root, `${id}.lock`), nonce = randomUUID();
      try { fs.mkdirSync(lock, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') return fail('write_busy', 'A transaction owns this task; retry or reconcile its process.'); throw error; }
      try {
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ nonce, pid: process.pid }), { mode: 0o600 });
        let record;
        try { record = readRecord(fileFor(id), id); }
        catch { return fail('corrupt_store', 'Private delivery state could not be validated; no state was replaced.'); }
        // Trusted synchronous adapter only, resolved under the transaction lock.
        // It must derive identity/grants/facts from server authority, not a card
        // or HTTP body, and fence legacy/remote admission before enabling writes.
        const context = typeof resolveContext === 'function' ? resolveContext(record && clone(record), clone(command)) : null;
        const grant = command.action === 'transition' ? `delivery:${command.to}` : `delivery:${command.action}`;
        if (!object(context) || !isOwnerId(context.actor_id) || !Array.isArray(context.grants) || !context.grants.includes(grant)) {
          return fail('not_authorized', `The authenticated actor needs ${grant}.`);
        }
        const key = command.idempotency_key;
        const hash = fingerprint({ actor: context.actor_id, command });
        if (record && Object.hasOwn(record.receipts, key)) {
          const prior = record.receipts[key];
          if (prior.fingerprint !== hash) return fail('idempotency_conflict', 'This key belongs to a different actor or request.');
          return { ...clone(prior.result), replayed: true };
        }
        if (command.expected_revision !== (record?.revision || 0)) return fail('stale_revision', 'Read the current delivery revision.');
        const busy = () => record?.lease || context.busy !== false;
        const c = command;
        if (c.action === 'initialize') {
          if (record) return fail('already_initialized', 'This task already has delivery state.');
          if (context.busy !== false) return fail('active_work', 'Reconcile existing execution and admission before initialization.');
          if (c.task?.id !== id || c.task?.schema_version !== 2 || !validateDeliveryTask(c.task).ok || !sha(c.source_revision)) {
            return fail('invalid_schema', 'Initialization needs a valid version 2 task and its source revision.');
          }
          // Starting from authored advanced states would turn claims into facts.
          if (c.task.delivery.state !== 'backlog') return fail('initial_state', 'This increment initializes Backlog only; evidence-backed migration is not available.');
          const task = { id, schema_version: 2, delivery: clone(c.task.delivery), ownership: clone(c.task.ownership) };
          if (c.task.blocker) task.blocker = clone(c.task.blocker);
          record = { format: 1, revision: 0, source_revision: c.source_revision, task, lease: null,
            next_fence: 1, last_handoff: null, events: [], receipts: {} };
        } else {
          if (!record) return fail('not_initialized', 'Initialize an explicitly mapped task first.');
          if (c.action === 'renew' || c.action === 'release') {
            if (!matchesLease(record.lease, c)) return fail('stale_lease', 'The lease identity, run and fence must match the current owner.');
            if (c.action === 'renew') {
              if (context.actor_id !== record.lease.owner) return fail('not_owner', 'Only the lease owner can renew it.');
              if (record.lease.expires_at <= time) return fail('lease_expired', 'An expired lease requires execution reconciliation, not renewal.');
              if (!ttl(c.ttl_ms)) return fail('invalid_ttl', 'Lease duration must be between 1 ms and one hour.');
              record.lease.expires_at = Math.max(record.lease.expires_at, time + c.ttl_ms);
            } else {
              if (!matchesLease(record.lease, context.stopped) || context.stopped.confirmed !== true || !text(context.stopped.reference)) {
                return fail('stop_unconfirmed', 'Confirm this exact execution stopped, including any accepted remote job.');
              }
              if (!handoff(c.handoff)) return fail('handoff_required', 'Preserve evidence and the next action when releasing execution.');
              record.last_handoff = { ...clone(c.handoff), from: record.lease.owner, run_id: record.lease.run_id,
                fence: record.lease.fence, stopped_reference: context.stopped.reference, at: time };
              record.lease = null;
            }
          } else {
            if (busy()) return fail('active_work', 'Existing execution/admission must be reconciled; lease expiry never permits another writer.');
            if (c.action === 'assign') {
              if (!OWNER_ROLES.includes(c.role) || !isOwnerId(c.owner)) return fail('invalid_owner', 'Select a stable owner and supported responsibility.');
              if (!handoff(c.handoff)) return fail('handoff_required', 'Record evidence and the next action for the assignment.');
              const from = record.task.ownership[c.role] || null;
              record.task.ownership[c.role] = c.owner;
              record.last_handoff = { ...clone(c.handoff), role: c.role, from, to: c.owner, at: time };
            } else if (c.action === 'block') {
              if (record.task.blocker) return fail('already_blocked', 'Resolve the existing blocker before replacing it.');
              if (!object(c.blocker)) return fail('invalid_blocker', 'Supply a structured blocker.');
              record.task.blocker = clone(c.blocker);
            } else if (c.action === 'resolve') {
              if (!record.task.blocker || !handoff(c.handoff)) return fail('handoff_required', 'Resolve an existing blocker with evidence and a next action.');
              record.last_handoff = { ...clone(c.handoff), from: record.task.blocker.owner, at: time };
              delete record.task.blocker;
            } else if (c.action === 'acquire' || c.action === 'transition') {
              if (c.action === 'transition' && c.to === 'in_progress') return fail('admission_required', 'Use acquire to atomically record admission and its lease.');
              const to = c.action === 'acquire' ? 'in_progress' : c.to;
              const current = record.task.delivery.state;
              if (c.action === 'acquire' && current === 'in_progress') {
                if (!text(c.reason) || record.task.blocker || context.facts?.admission?.authorized !== true ||
                  context.facts?.admission?.dependencies_satisfied !== true || context.facts?.admission?.owner !== record.task.ownership.implementation) {
                  return fail('admission_required', 'Resuming needs a reason, resolved blockers, and an authorized eligible assignment.');
                }
              } else {
                const result = evaluateDeliveryTransition(record.task, { to, reason: c.reason, expected_revision: String(record.revision) },
                  { ...context, revision: String(record.revision), busy: false });
                if (!result.ok) return result;
              }
              if (c.action === 'acquire') {
                if (!identity(c.run_id) || !ttl(c.ttl_ms)) return fail('invalid_lease', 'Supply a run identity and a lease duration between 1 ms and one hour.');
                // Run IDs are never recycled, even after a confirmed release.
                if (record.events.some(e => e.action === 'acquire' && e.command.run_id === c.run_id)) return fail('run_reused', 'Use a new run identity.');
                record.lease = { id: randomUUID(), fence: record.next_fence++, run_id: c.run_id,
                  owner: record.task.ownership.implementation, acquired_at: time, expires_at: time + c.ttl_ms };
              }
              record.task.delivery.state = to;
              if (['backlog', 'cancelled'].includes(to)) delete record.task.blocker;
            }
          }
        }
        const validation = validateDeliveryTask(record.task);
        if (!validation.ok) return { ...fail('invalid_schema', 'The operation would violate the delivery contract.'), issues: validation.issues };
        record.revision++;
        const result = { ok: true, revision: record.revision, action: c.action, lease: clone(record.lease), effect: 'private_state_only' };
        const evidence = c.action === 'release' ? { stopped: clone(context.stopped) }
          : ['transition', 'acquire'].includes(c.action) ? { facts: clone(context.facts || {}) } : {};
        record.events.push({ revision: record.revision, at: time, actor: context.actor_id, grant, action: c.action,
          command: clone(c), evidence });
        Object.defineProperty(record.receipts, key, { value: { fingerprint: hash, result }, enumerable: true, writable: true, configurable: true });
        // State, event, lease and receipt publish as one atomic snapshot. If an
        // acknowledgement is lost, retry the same key; never redispatch blindly.
        try { saveRecord(fileFor(id), record); }
        catch { return fail('commit_uncertain', 'Read state or retry this exact key before taking any external action.'); }
        return result;
      } finally {
        // Cleanup only our own lock; never remove a replacement owner's lock.
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch { /* preserve uncertain ownership */ }
        if (owner?.nonce === nonce) fs.rmSync(lock, { recursive: true });
      }
    },
  };
}
