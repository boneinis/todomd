import { createDeliveryAccess } from './delivery-access.js';
import { createDeliveryAuthority } from './delivery-authority.js';
import { createDeliveryStore } from './delivery-store.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { executionRef } from './delivery-execution-state.js';

// Capture the credential for THIS request. Authentication and job policy are
// fresh private reads at every authority check, including asynchronous returns.
export function createDeliverySession(repo, { credential, enabled = false, jobs = {}, resolveAdmission,
  now = Date.now, localOptions = {} } = {}) {
  const access = createDeliveryAccess(repo, { enabled, now });
  const service = createDeliveryAuthority(repo, { enabled, jobs, now, localOptions,
    authenticate: () => access.authenticate(credential),
    resolveAdmission: (id, ref) => {
      const facts = resolveAdmission?.(id, ref);
      if (!facts || typeof facts.then === 'function') return null;
      return { ...facts, job_approved: facts.job_approved === true && access.jobApproved(ref.backend) };
    },
  });
  return Object.freeze({ ...service,
    read(id) {
      const p = access.authenticate(credential);
      if (!p) return { ok: false, code: 'not_authorized' };
      try {
        const record = createDeliveryStore(deliveryStoreDirectory(repo)).read(id);
        if (!record) return { ok: false, code: 'not_initialized' };
        if (!(p.operator && p.actor_id.startsWith('human:')) && !Object.values(record.task.ownership).includes(p.actor_id)) return { ok: false, code: 'not_authorized' };
        const ref = record.execution && record.lease ? executionRef(record) : record.execution?.observation;
        return { ok: true, task_id: id, revision: record.revision,
          execution: record.execution ? { ...Object.fromEntries(['task_id', 'lease_id', 'run_id', 'fence', 'backend', 'source_revision']
            .filter(k => ref?.[k] !== undefined).map(k => [k, ref[k]])), phase: record.execution.phase } : null };
      } catch { return { ok: false, code: 'corrupt_store' }; }
    },
  });
}
