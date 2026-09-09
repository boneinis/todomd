import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCard } from './board.js';
import { isOwnerId } from './delivery.js';
import { createDeliveryStore } from './delivery-store.js';
import { createDeliveryExecutionCoordinator } from './delivery-execution.js';
import { createLocalDeliveryBackend } from './delivery-local-backend.js';
import { sameExecution, executionRef } from './delivery-execution-state.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { admissionHeld, withAdmission } from './delivery-admission.js';
import { registerAuthority, registeredAuthority } from './delivery-authority-state.js';
import { deliveryWriterPreflight } from './delivery-writer-preflight.js';

const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => createHash('sha256').update(v).digest('hex');
const fail = (code, message) => ({ ok: false, code, message });
const backendId = v => typeof v === 'string' && /^local-job-[a-f0-9]{64}$/.test(v);
const recovery = ['request_stop', 'observe_execution', 'release'];
const referenceFields = ['task_id', 'lease_id', 'run_id', 'fence', 'backend', 'source_revision'];
const common = ['expected_revision', 'idempotency_key'];
const fields = {
  reserve: [...common, 'profile', 'run_id', 'ttl_ms', 'reason'],
  dispatch: [...common, ...referenceFields], stop: [...common, ...referenceFields],
  reconcile: [...common, ...referenceFields], release: [...common, ...referenceFields, 'handoff'],
  renew: [...common, ...referenceFields, 'ttl_ms'],
};

function approvedJobs(repo, jobs) {
  if (!object(jobs)) throw new Error('Approved delivery jobs must be server configuration.');
  return new Map(Object.entries(jobs).map(([name, value]) => {
    if (!identity(name) || !object(value) || Object.keys(value).some(k => !['command', 'args', 'cwd', 'containment'].includes(k)) ||
      value.containment !== 'local_process_group' || typeof value.command !== 'string' || !path.isAbsolute(value.command) ||
      typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string')) {
      throw new Error('Invalid approved delivery job definition.');
    }
    const command = fs.realpathSync(value.command), cwd = fs.realpathSync(value.cwd);
    if (!fs.statSync(command).isFile() || !fs.statSync(cwd).isDirectory()) throw new Error('Invalid approved job paths.');
    fs.accessSync(command, fs.constants.X_OK);
    const job = Object.freeze({ command, args: Object.freeze([...value.args]), cwd, containment: 'local_process_group' });
    return [name, Object.freeze({ job, backend: `local-job-${hash(JSON.stringify({ format: 1, repo, name, job }))}` })];
  }));
}

// Internal, opt-in transport adapter. authenticate and resolveAdmission are
// synchronous server capabilities, never values decoded from a card/request.
// The canonical store + backend namespace is also the recovery authority: do
// not remap it to arbitrary backend directories when a job profile is removed.
export function createDeliveryAuthority(repoPath, { enabled = false, authenticate, resolveAdmission,
  jobs = {}, now = Date.now, localOptions = {} } = {}) {
  const repo = fs.realpathSync(repoPath), directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  if (!object(localOptions) || Object.keys(localOptions).some(k => !['graceMs', 'closeTimeoutMs'].includes(k))) throw new Error('Invalid local delivery options.');
  const profiles = approvedJobs(repo, jobs), byBackend = new Map([...profiles.values()].map(p => [p.backend, p]));
  // Enabled construction installs server-owned configuration bindings, not
  // executions. No command text or environment is written to these receipts.
  if (enabled === true) for (const [name, profile] of profiles) registerAuthority(directory, profile.backend, repo, name);
  const readStore = createDeliveryStore(directory);

  function principal() {
    try {
      const p = authenticate?.();
      return object(p) && typeof p.then !== 'function' && isOwnerId(p.actor_id) && p.project === repo
        ? { actor_id: p.actor_id, operator: p.operator === true } : null;
    } catch { return null; }
  }
  function context(record, command) {
    const p = principal();
    if (!p || !record) return null;
    const owners = record.task.ownership, grants = new Set();
    if (p.actor_id === owners.implementation) {
      for (const a of ['acquire', 'in_progress', 'dispatch', 'renew', ...recovery]) grants.add(`delivery:${a}`);
    }
    if (p.actor_id === owners.delivery_lead || p.operator === true && p.actor_id.startsWith('human:')) {
      for (const a of recovery) grants.add(`delivery:${a}`);
    }
    if (Object.values(owners).includes(p.actor_id)) grants.add('delivery:observe_execution');
    const result = { actor_id: p.actor_id, grants: [...grants] };
    if (!['acquire', 'dispatch'].includes(command.action) || !admissionHeld(gate)) return result;
    const backend = command.execution?.backend || record.execution?.backend;
    if (!byBackend.has(backend)) return result;
    try {
      const card = readCard(repo, record.task.id);
      if (!card || card.parseError || card.data.id !== record.task.id || card.data.archived === true || hash(card.raw) !== record.source_revision) return result;
      const facts = resolveAdmission?.(record.task.id, Object.freeze({ backend, source_revision: record.source_revision }));
      if (!object(facts) || typeof facts.then === 'function' || facts.job_approved !== true || facts.writers_fenced !== true || facts.busy !== false || facts.dependencies_satisfied !== true) return result;
      if (deliveryWriterPreflight(repo).blocked) return result;
      return { ...result, busy: false,
        execution_admission: { backend, source_revision: record.source_revision, fenced: true },
        facts: { admission: { owner: owners.implementation, authorized: p.actor_id === owners.implementation, dependencies_satisfied: true } } };
    } catch { return result; }
  }
  function backend(name) {
    const profile = byBackend.get(name);
    const local = createLocalDeliveryBackend(path.join(directory, 'local-executions', name), { ...localOptions, enabled, name,
      authorizeStart: ref => {
        if (!admissionHeld(gate) || !profile || !registeredAuthority(directory, name, repo)) return false;
        const record = readStore.read(ref.task_id), time = now();
        if (!record?.lease || !record.execution || !sameExecution(executionRef(record), ref) ||
          record.execution.phase !== 'dispatching' || !Number.isSafeInteger(time) || record.lease.expires_at <= time) return false;
        const c = context(record, { action: 'dispatch' });
        return c?.grants.includes('delivery:dispatch') && c.busy === false && c.execution_admission?.fenced === true;
      },
      resolveJob: ref => profile && { ...profile.job,
        args: profile.job.args.map(arg => {
          const key = referenceFields.find(k => arg === `{${k}}`);
          return key ? String(ref[key]) : arg;
        }) },
    });
    const verified = fn => ref => {
      if (!registeredAuthority(directory, name, repo)) throw new Error('Job authority is unavailable.');
      return fn(ref);
    };
    return { inspect: verified(local.inspect), close: verified(local.close),
      // Retain project admission through asynchronous authorization, job
      // resolution, and supervisor acknowledgement. Revalidate after acquiring.
      start: verified(ref => withAdmission(gate, 'launch', ref.task_id, () => local.start(ref), { localExecution: ref })) };
  }
  function coordinator(record) {
    const names = new Set(byBackend.keys());
    // A removed profile is close/inspect-only in its ORIGINAL namespace. Old
    // generic `local` or remote records are never guessed into this authority.
    if (backendId(record?.execution?.backend) && registeredAuthority(directory, record.execution.backend, repo)) names.add(record.execution.backend);
    return createDeliveryExecutionCoordinator(directory, { enabled, now, resolveContext: context,
      backends: Object.fromEntries([...names].map(name => [name, backend(name)])) });
  }
  function invoke(method, id, command) {
    if (enabled !== true) return fail('disabled', 'Delivery authority is not enabled.');
    if (!identity(id) || !object(command) || Object.keys(command).some(k => !fields[method].includes(k))) return fail('invalid_request', 'Use revisioned execution fields; authority and job commands come from the server.');
    let record;
    try { record = readStore.read(id); } catch { return fail('corrupt_store', 'Reconcile private delivery state before execution.'); }
    if (!record) return fail('not_initialized', 'Map the task before using delivery execution.');
    if (method !== 'reserve' && command.task_id !== id) return fail('stale_execution', 'Use the requested task execution identity.');
    if (['renew', 'release'].includes(method) && !sameExecution(record.lease && record.execution ? executionRef(record) : record.execution?.observation, command)) {
      return fail('stale_execution', 'Use the current execution identity.');
    }
    if (method === 'renew') return createDeliveryStore(directory, { enabled, now, resolveContext: context }).execute(id, { ...command, action: 'renew' });
    let service;
    try { service = coordinator(record); } catch { return fail('backend_unavailable', 'The recorded job authority cannot be verified; ownership is held.'); }
    if (method === 'reserve') {
      const profile = profiles.get(command.profile);
      if (!profile) return fail('profile_unavailable', 'Select an approved job profile.');
      const { profile: ignored, ...c } = command;
      return service.reserve(id, { ...c, execution: { backend: profile.backend, source_revision: record.source_revision } });
    }
    return service[method](id, command);
  }
  return Object.freeze(Object.fromEntries(Object.keys(fields).map(method => [method, (id, command) => invoke(method, id, command)])));
}
