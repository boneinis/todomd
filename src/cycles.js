import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadBoard } from './board.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { createDeliveryStore } from './delivery-store.js';
import { isOwnerId } from './delivery.js';
import { withAdmissionSync } from './delivery-admission.js';

const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const cycleIdRegex = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const DEFAULT_CAPACITY_POLICY = Object.freeze({
  max_wip: 2,
  max_writers_per_repo: 1,
});

export function cyclesDirectory(repoPath) {
  return path.join(path.resolve(repoPath), '.todomd', 'cycles');
}

export function validateCycle(cycle) {
  const issues = [];
  const issue = (path, code, message) => issues.push({ path, code, message });
  if (!object(cycle)) return { ok: false, issues: [{ path: '', code: 'invalid_cycle', message: 'Cycle must be an object.' }] };
  if (cycle.schema_version !== 2) issue('schema_version', 'unsupported_version', 'schema_version must be 2.');
  if (!nonempty(cycle.id) || !cycleIdRegex.test(cycle.id)) {
    issue('id', 'invalid_id', 'Cycle ID must be an alphanumeric identifier up to 64 chars.');
  }
  if (!nonempty(cycle.goal)) issue('goal', 'required', 'Cycle goal is required.');
  if (!nonempty(cycle.start_date) || isNaN(Date.parse(cycle.start_date))) {
    issue('start_date', 'invalid_date', 'Valid start_date ISO timestamp is required.');
  }
  if (!nonempty(cycle.end_date) || isNaN(Date.parse(cycle.end_date))) {
    issue('end_date', 'invalid_date', 'Valid end_date ISO timestamp is required.');
  }
  if (!['active', 'closed'].includes(cycle.status)) {
    issue('status', 'invalid_status', 'Cycle status must be active or closed.');
  }
  if (cycle.capacity_policy !== undefined && !object(cycle.capacity_policy)) {
    issue('capacity_policy', 'invalid_policy', 'capacity_policy must be an object.');
  }
  if (!Array.isArray(cycle.tasks)) issue('tasks', 'invalid_tasks', 'tasks must be an array of task IDs.');
  if (!Array.isArray(cycle.scope_history)) {
    issue('scope_history', 'invalid_history', 'scope_history must be an array.');
  }

  return { ok: issues.length === 0, issues };
}

export function listCycles(repoPath) {
  const dir = cyclesDirectory(repoPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const results = [];
  for (const file of entries) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const validation = validateCycle(content);
      if (validation.ok) results.push(content);
    } catch {}
  }
  return results;
}

export function readCycle(repoPath, cycleId) {
  if (!nonempty(cycleId)) return null;
  const file = path.join(cyclesDirectory(repoPath), `${cycleId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validateCycle(content).ok) return null;
    content.scope = content.tasks;
    return content;
  } catch {
    return null;
  }
}

export function getActiveCycle(repoPath) {
  return listCycles(repoPath).find(c => c.status === 'active') || null;
}

export function saveCycle(repoPath, cycle) {
  if (cycle) {
    if (!cycle.tasks && cycle.scope) cycle.tasks = cycle.scope;
    if (!cycle.scope && cycle.tasks) cycle.scope = cycle.tasks;
  }
  const validation = validateCycle(cycle);
  if (!validation.ok) {
    const error = new Error(`Invalid cycle: ${validation.issues.map(i => i.message).join('; ')}`);
    error.issues = validation.issues;
    throw error;
  }
  const dir = cyclesDirectory(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cycle.id}.json`);
  const tmp = `${file}.${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cycle, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return cycle;
}

export function createCycle(repoPath, data) {
  const now = new Date().toISOString();
  const id = data.id || `cycle-${String(listCycles(repoPath).length + 1).padStart(4, '0')}`;
  const initialTasks = Array.isArray(data.scope) ? [...data.scope] : (Array.isArray(data.tasks) ? [...data.tasks] : []);
  const scopeHistory = Array.isArray(data.scope_history) ? [...data.scope_history] : [];

  if (initialTasks.length > 0 && scopeHistory.length === 0) {
    for (const taskId of initialTasks) {
      scopeHistory.push({
        action: 'added',
        task_id: taskId,
        at: now,
        reason: data.reason || 'Initial cycle scope',
        actor: data.actor || null,
      });
    }
  }

  const cycle = {
    schema_version: 2,
    id,
    name: data.name || id,
    goal: data.goal,
    start_date: data.start_date || now,
    end_date: data.end_date || new Date(Date.now() + 7 * 86400000).toISOString(),
    status: data.status || 'active',
    capacity_policy: { ...DEFAULT_CAPACITY_POLICY, ...(data.capacity_policy || {}) },
    tasks: initialTasks,
    scope: initialTasks,
    scope_history: scopeHistory,
  };

  return saveCycle(repoPath, cycle);
}

export function updateCycleScope(repoPath, cycleId, options = {}) {
  const cycle = readCycle(repoPath, cycleId);
  if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
  const { action, task_id, tasks, reason, actor, add, remove } = options;
  if (!nonempty(reason)) throw new Error('Reason is required for cycle scope changes.');

  const now = new Date().toISOString();
  let updatedTasks = [...cycle.tasks];
  const history = [...cycle.scope_history];

  if (Array.isArray(add) || Array.isArray(remove)) {
    const toAdd = Array.isArray(add) ? add : [];
    const toRemove = Array.isArray(remove) ? remove : [];
    for (const id of toAdd) {
      if (!updatedTasks.includes(id)) {
        updatedTasks.push(id);
        history.push({ action: 'added', task_id: id, at: now, reason, actor: actor || null });
      }
    }
    for (const id of toRemove) {
      const idx = updatedTasks.indexOf(id);
      if (idx !== -1) {
        updatedTasks.splice(idx, 1);
        history.push({ action: 'removed', task_id: id, at: now, reason, actor: actor || null });
      }
    }
    history.push({ action: 'scope_updated', added: toAdd, removed: toRemove, at: now, reason, actor: actor || null });
  } else if (action === 'add') {
    if (!nonempty(task_id)) throw new Error('task_id is required to add task to cycle.');
    if (!updatedTasks.includes(task_id)) {
      updatedTasks.push(task_id);
      history.push({ action: 'added', task_id, at: now, reason, actor: actor || null });
    }
  } else if (action === 'remove') {
    if (!nonempty(task_id)) throw new Error('task_id is required to remove task from cycle.');
    const idx = updatedTasks.indexOf(task_id);
    if (idx !== -1) {
      updatedTasks.splice(idx, 1);
      history.push({ action: 'removed', task_id, at: now, reason, actor: actor || null });
    }
  } else if (action === 'reorder') {
    if (!Array.isArray(tasks)) throw new Error('tasks array is required for reordering.');
    updatedTasks = [...tasks];
    history.push({ action: 'reordered', task_id: null, at: now, reason, actor: actor || null });
  } else {
    throw new Error(`Unknown scope action: ${action}`);
  }

  const updatedCycle = {
    ...cycle,
    tasks: updatedTasks,
    scope: updatedTasks,
    scope_history: history,
  };

  return saveCycle(repoPath, updatedCycle);
}

function updateTaskDeliveryCycleId(directory, id, cycleId) {
  if (cycleId && (!nonempty(cycleId) || !cycleIdRegex.test(cycleId))) return false;
  const file = path.join(directory, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  try {
    const res = withAdmissionSync(path.join(directory, 'admission'), 'metadata', id, () => {
      let raw;
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        raw = fs.readFileSync(fd, 'utf8');
        fs.closeSync(fd);
      } catch {
        return false;
      }
      const record = JSON.parse(raw);
      if (!record || !record.task?.delivery) return false;

      if (cycleId) {
        if (record.task.delivery.cycle_id === cycleId) return true;
        record.task.delivery.cycle_id = cycleId;
      } else {
        if (!Object.hasOwn(record.task.delivery, 'cycle_id')) return true;
        delete record.task.delivery.cycle_id;
      }

      delete record.checksum;
      const canonical = v => JSON.stringify(v, (k, val) => (val !== null && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map(x => [x, val[x]])) : val));
      record.checksum = createHash('sha256').update(canonical(record)).digest('hex');

      const temp = `${file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(temp, file);
      return true;
    });
    return res.ok ? res.value : false;
  } catch {
    return false;
  }
}

export function closeCycle(repoPath, cycleId, options = {}) {
  const cycle = readCycle(repoPath, cycleId);
  if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
  if (cycle.status === 'closed') return cycle;

  const now = new Date().toISOString();
  const history = [...cycle.scope_history];
  const {
    carry_forward = [],
    return_to_backlog = [],
    cancel = [],
    reason,
    actor,
    incomplete_action,
    carry_forward_cycle_id,
    destCycleId,
    dest_cycle_id,
    audit_reason,
  } = options;
  const auditMsg = audit_reason || reason || 'Cycle closed';
  const targetCycleId = carry_forward_cycle_id || destCycleId || dest_cycle_id || null;
  if (targetCycleId && (!nonempty(targetCycleId) || !cycleIdRegex.test(targetCycleId))) {
    throw new Error(`Invalid destination cycle identifier: "${targetCycleId}"`);
  }

  let storeDir = null;
  try {
    const resolvedRepo = fs.realpathSync(repoPath);
    storeDir = deliveryStoreDirectory(resolvedRepo);
  } catch {}

  let boardCards = [];
  try {
    const board = loadBoard(repoPath, { includeArchived: true });
    boardCards = board.cards || [];
  } catch {}

  const terminalStates = ['released', 'completed', 'cancelled', 'Done', 'Cancelled'];
  const incomplete = (cycle.tasks || []).filter(tid => {
    const c = boardCards.find(x => x.id === tid);
    let s = c ? (c.delivery?.state || c.status) : null;
    if (!s && storeDir && fs.existsSync(storeDir)) {
      try {
        const rec = createDeliveryStore(storeDir).read(tid);
        s = rec?.task?.delivery?.state;
      } catch {}
    }
    if (!s) return false;
    return !terminalStates.includes(s);
  });

  const toCarryForward = new Set(Array.isArray(carry_forward) ? carry_forward : []);
  const toReturnToBacklog = new Set(Array.isArray(return_to_backlog) ? return_to_backlog : []);
  const toCancel = new Set(Array.isArray(cancel) ? cancel : []);

  if (incomplete_action === 'carry_forward') {
    for (const tid of incomplete) {
      if (!toReturnToBacklog.has(tid) && !toCancel.has(tid)) {
        toCarryForward.add(tid);
      }
    }
  } else if (incomplete_action === 'return_to_backlog') {
    for (const tid of incomplete) {
      if (!toCarryForward.has(tid) && !toCancel.has(tid)) {
        toReturnToBacklog.add(tid);
      }
    }
  } else if (incomplete_action === 'cancel') {
    for (const tid of incomplete) {
      if (!toCarryForward.has(tid) && !toReturnToBacklog.has(tid)) {
        toCancel.add(tid);
      }
    }
  }

  // Handle destination cycle scope and audit history for carry_forward
  if (targetCycleId) {
    const destCycle = readCycle(repoPath, targetCycleId);
    if (destCycle) {
      let destChanged = false;
      for (const tid of toCarryForward) {
        if (!destCycle.tasks.includes(tid)) {
          destCycle.tasks.push(tid);
          destCycle.scope_history.push({
            action: 'carried_forward',
            task_id: tid,
            from_cycle: cycleId,
            at: now,
            reason: auditMsg || 'Carried forward to next cycle',
            actor: actor || null,
          });
          destChanged = true;
        }
        history.push({
          action: 'carried_forward',
          task_id: tid,
          to_cycle: targetCycleId,
          at: now,
          reason: auditMsg || 'Carried forward to next cycle',
          actor: actor || null,
        });
      }
      if (destChanged) {
        destCycle.scope = destCycle.tasks;
        saveCycle(repoPath, destCycle);
      }
    } else {
      for (const tid of toCarryForward) {
        history.push({
          action: 'carried_forward',
          task_id: tid,
          at: now,
          reason: auditMsg || 'Carried forward to next cycle',
          actor: actor || null,
        });
      }
    }
  } else {
    for (const tid of toCarryForward) {
      history.push({
        action: 'carried_forward',
        task_id: tid,
        at: now,
        reason: auditMsg || 'Carried forward to next cycle',
        actor: actor || null,
      });
    }
  }

  for (const taskId of toReturnToBacklog) {
    history.push({
      action: 'returned_to_backlog',
      task_id: taskId,
      at: now,
      reason: auditMsg || 'Returned to backlog at cycle close',
      actor: actor || null,
    });
  }

  for (const taskId of toCancel) {
    history.push({
      action: 'cancelled',
      task_id: taskId,
      at: now,
      reason: auditMsg || 'Cancelled at cycle close',
      actor: actor || null,
    });
  }

  // Canonical delivery store state reconciliation
  if (storeDir && fs.existsSync(storeDir)) {
    const actorId = isOwnerId(actor) ? actor : 'human:project-owner';
    const store = createDeliveryStore(storeDir, {
      enabled: true,
      resolveContext: () => ({
        actor_id: actorId,
        grants: ['delivery:backlog', 'delivery:cancelled'],
        busy: false,
      }),
    });

    for (const tid of toReturnToBacklog) {
      try {
        const record = store.read(tid);
        if (!record) continue;
        if (record.lease || (record.execution && record.execution.phase !== 'stopped')) {
          continue;
        }
        if (record.task?.delivery?.state !== 'backlog') {
          const rawKey = `cycle-close-${cycleId}-${tid}-backlog`;
          const key = rawKey.length <= 120 ? rawKey : `cycle-${createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
          const cmd = {
            action: 'transition',
            to: 'backlog',
            reason: auditMsg || 'Returned to backlog at cycle close',
            expected_revision: record.revision,
            idempotency_key: key,
          };
          const res = store.execute(tid, cmd);
          if (res.ok) {
            updateTaskDeliveryCycleId(storeDir, tid, null);
          }
        } else {
          updateTaskDeliveryCycleId(storeDir, tid, null);
        }
      } catch {}
    }

    for (const tid of toCancel) {
      try {
        const record = store.read(tid);
        if (!record) continue;
        if (record.lease || (record.execution && record.execution.phase !== 'stopped')) {
          continue;
        }
        if (record.task?.delivery?.state !== 'cancelled') {
          const rawKey = `cycle-close-${cycleId}-${tid}-cancelled`;
          const key = rawKey.length <= 120 ? rawKey : `cycle-${createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
          const cmd = {
            action: 'transition',
            to: 'cancelled',
            reason: auditMsg || 'Cancelled at cycle close',
            expected_revision: record.revision,
            idempotency_key: key,
          };
          const res = store.execute(tid, cmd);
          if (res.ok) {
            updateTaskDeliveryCycleId(storeDir, tid, null);
          }
        } else {
          updateTaskDeliveryCycleId(storeDir, tid, null);
        }
      } catch {}
    }

    if (targetCycleId) {
      for (const tid of toCarryForward) {
        try {
          const record = store.read(tid);
          if (!record) continue;
          if (record.lease || (record.execution && record.execution.phase !== 'stopped')) {
            continue;
          }
          updateTaskDeliveryCycleId(storeDir, tid, targetCycleId);
        } catch {}
      }
    }
  }

  const closed = {
    ...cycle,
    status: 'closed',
    closed_at: now,
    scope_history: history,
  };

  return saveCycle(repoPath, closed);
}

// WIP limits calculation:
// Pilot capacity: 1 implementation writer per repo, max 2 started, unfinished implementation tasks.
// Blocked and review-waiting work count toward the limit.
export function checkWipLimit(target = [], options = {}) {
  const cards = typeof target === 'string'
    ? loadBoard(target, { includeArchived: false }).cards
    : (Array.isArray(target) ? target : []);
  const maxWip = options.limit !== undefined ? options.limit : (options.maxWip !== undefined ? options.maxWip : DEFAULT_CAPACITY_POLICY.max_wip);
  const candidateTaskId = options.candidateTaskId || null;

  const activeImplementationTasks = cards.filter(card => {
    if (candidateTaskId && card.id === candidateTaskId) return false;
    const deliveryState = card.delivery?.state;
    if (deliveryState) {
      if (['in_progress', 'in_review'].includes(deliveryState)) return true;
      if (card.blocker && !['backlog', 'cancelled', 'released', 'completed'].includes(deliveryState)) return true;
    } else {
      if (['Build', 'CI', 'Verify'].includes(card.status)) return true;
      if (card.status === 'Needs Human') return true;
    }
    return false;
  });

  const currentWip = activeImplementationTasks.length;
  const allowed = currentWip <= maxWip;

  return {
    allowed,
    ok: allowed,
    current: currentWip,
    current_wip: currentWip,
    limit: maxWip,
    max_wip: maxWip,
    exceeded: currentWip > maxWip,
    active_tasks: activeImplementationTasks.map(c => c.id),
    reason: allowed ? null : `WIP capacity limit reached (${currentWip}/${maxWip} active tasks). Finish or withdraw existing work first.`,
  };
}
