import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createDeliveryStore } from './delivery-store.js';

// Read-only compatibility boundary. Presence of private delivery state claims
// the task even when its lease is expired, absent, corrupt, or mid-transaction.
// No production entry point initializes this store or activates migration yet.
export function deliveryStoreDirectory(repoPath) {
  const canonical = fs.realpathSync(repoPath);
  const key = createHash('sha256').update(canonical).digest('hex');
  return path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'delivery', key);
}

const legacy = () => ({ managed: false, legacy_execution_allowed: true });
const hold = (code, message, nextAction, extra = {}) => ({ managed: true, legacy_execution_allowed: false,
  code, message, next_action: nextAction, ...extra });
const reconcile = 'The project owner must confirm the previous execution has stopped and reconcile pending operations before further changes. Keep the candidate and attempt history.';

export function deliveryRuntimeStatus(repoPath, id) {
  try {
    const directory = deliveryStoreDirectory(repoPath);
    try { if (!fs.lstatSync(directory).isDirectory()) throw new Error('invalid private directory'); }
    catch (error) { if (error.code === 'ENOENT') return legacy(); throw error; }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
      return hold('delivery_identity_invalid', 'Delivery task identity requires reconciliation.', reconcile);
    }
    // lstat distinguishes absence from unreadability and dangling symlinks.
    for (const file of [`${id}.lock`, `${id}.json`]) {
      let stat;
      try { stat = fs.lstatSync(path.join(directory, file)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) return hold('delivery_state_unavailable', 'Delivery ownership cannot be verified.', reconcile);
      if (file.endsWith('.lock')) return hold('delivery_transaction_pending', 'A delivery transaction owns this task or requires recovery.', reconcile);
      if (!stat.isFile()) return hold('delivery_state_unavailable', 'Delivery ownership cannot be verified.', reconcile);
    }
    const record = createDeliveryStore(directory).read(id);
    if (!record) return legacy();
    // Only safe metadata reaches viewer/UI callers. Never expose receipts,
    // evidence references, command history, private paths, PIDs or run IDs.
    return hold(record.lease ? 'delivery_execution_owned' : 'delivery_managed',
      record.lease ? 'Durable delivery ownership prevents legacy execution or recovery.' : 'This task is managed by the delivery workflow; legacy actions are held.',
      reconcile, { revision: record.revision, state: record.task.delivery.state,
        ownership: record.task.ownership, blocker_category: record.task.blocker?.category || null,
        lease: record.lease ? { owner: record.lease.owner, expired: record.lease.expires_at <= Date.now() } : null });
  } catch {
    return hold('delivery_state_unavailable', 'Delivery ownership cannot be verified.', reconcile);
  }
}

export function legacyMutationGuard(repoPath, id) {
  const status = deliveryRuntimeStatus(repoPath, id);
  return status.legacy_execution_allowed ? null : { ok: false, code: status.code,
    error: `${status.message} ${status.next_action}`, delivery_runtime: status };
}
