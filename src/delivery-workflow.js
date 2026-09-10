import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCard } from './board.js';
import { isOwnerId } from './delivery.js';
import { createDeliveryStore } from './delivery-store.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { admissionHeld } from './delivery-admission.js';
import { deliveryWriterPreflight } from './delivery-writer-preflight.js';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const clone = v => JSON.parse(JSON.stringify(v));
const fail = code => ({ ok: false, code });
const common = ['expected_revision', 'idempotency_key'];
const fields = {
  initialize: [...common, 'task', 'source_revision'],
  assign: [...common, 'role', 'owner', 'handoff'],
  block: [...common, 'blocker'], resolve: [...common, 'handoff'],
  transition: [...common, 'to', 'reason'],
};
export function createDeliveryWorkflow(repoPath, { enabled = false, authenticate, resolveWorkflow, now = Date.now, enableReleaseTransitions = false } = {}) {
  const destinations = enableReleaseTransitions
    ? ['backlog', 'ready', 'in_review', 'ready_to_release', 'released', 'completed', 'cancelled']
    : ['backlog', 'ready', 'in_review', 'cancelled'];
  const repo = fs.realpathSync(repoPath), directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  function principal() {
    try {
      const p = authenticate?.();
      return object(p) && typeof p.then !== 'function' && p.project === repo && isOwnerId(p.actor_id)
        ? { actor_id: p.actor_id, operator: p.operator === true && p.actor_id.startsWith('human:') } : null;
    } catch { return null; }
  }
  function context(record, command) {
    const p = principal();
    if (!p || !admissionHeld(gate)) return null;
    const owners = record?.task.ownership || {}, grants = new Set();
    if (p.operator) grants.add('delivery:initialize');
    if (record && (p.operator || p.actor_id === owners.delivery_lead)) {
      for (const action of ['assign', 'block', 'resolve', ...destinations]) grants.add(`delivery:${action}`);
    }
    if (record && Object.values(owners).includes(p.actor_id)) {
      if (command.blocker?.owner === p.actor_id) grants.add('delivery:block');
      if (p.actor_id === owners.implementation) grants.add('delivery:in_review');
      if (p.actor_id === owners.release) {
        grants.add('delivery:ready_to_release');
        grants.add('delivery:released');
      }
    }
    if (record?.task.blocker?.owner === p.actor_id) grants.add('delivery:resolve');
    const result = { actor_id: p.actor_id, grants: [...grants] };
    const grant = `delivery:${command.action === 'transition' ? command.to : command.action}`;
    if (!grants.has(grant)) return result;
    try {
      const id = record?.task.id || command.task.id, source = record?.source_revision || command.source_revision;
      const card = readCard(repo, id);
      if (!card || card.parseError || card.data.id !== id || card.data.archived === true ||
        createHash('sha256').update(card.raw).digest('hex') !== source) return result;
      const facts = resolveWorkflow?.(id, Object.freeze({ action: command.action,
        ...(command.to ? { to: command.to } : {}), source_revision: source,
        revision: record?.revision || 0, actor_id: p.actor_id }));
      if (!object(facts) || typeof facts.then === 'function' || facts.writers_fenced !== true || facts.busy !== false ||
        deliveryWriterPreflight(repo).blocked) return result;
      // A callback may revoke a credential. Never commit under its earlier grant.
      const current = principal();
      if (!current || current.actor_id !== p.actor_id || current.operator !== p.operator) return null;
      const latest = readCard(repo, id);
      if (!latest || createHash('sha256').update(latest.raw).digest('hex') !== source) return result;
      return { ...result, busy: false, facts: clone({
        ready: facts.ready || {},
        candidate: facts.candidate || {},
        checks: facts.checks,
        review: facts.review,
        policy_revision: facts.policy_revision,
        target_branch: facts.target_branch,
        integration: facts.integration,
        release: facts.release,
        acceptance: facts.acceptance,
      }) };
    } catch { return result; }
  }
  const store = createDeliveryStore(directory, { enabled, now, resolveContext: context });
  function invoke(method, id, command) {
    if (enabled !== true) return fail('disabled');
    if (!identity(id) || !exact(command, fields[method])) return fail('invalid_request');
    if (method === 'initialize' && (!exact(command.task, ['id', 'schema_version', 'delivery', 'ownership', 'blocker']) || command.task.id !== id)) return fail('invalid_request');
    if (method === 'transition' && !destinations.includes(command.to)) return fail('unsupported_transition');
    if (command.handoff !== undefined && !exact(command.handoff, ['evidence', 'next_action'])) return fail('invalid_request');
    return store.execute(id, { ...command, action: method });
  }
  return Object.freeze({
    ...Object.fromEntries(Object.keys(fields).map(method => [method, (id, command) => invoke(method, id, command)])),
    readTask(id) {
      const p = principal();
      if (!p) return fail('not_authorized');
      if (!identity(id)) return fail('invalid_request');
      try {
        const record = store.read(id);
        if (!record) return fail('not_initialized');
        if (!p.operator && record.task.blocker?.owner !== p.actor_id && !Object.values(record.task.ownership).includes(p.actor_id)) return fail('not_authorized');
        return { ok: true, revision: record.revision, source_revision: record.source_revision,
          task: clone(record.task), handoff: clone(record.last_handoff), execution_held: record.lease !== null };
      } catch { return fail('corrupt_store'); }
    },
  });
}
