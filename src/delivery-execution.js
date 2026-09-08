import { createDeliveryStore } from './delivery-store.js';
import { executionRef, sameExecution } from './delivery-execution-state.js';
import { isOwnerId } from './delivery.js';

const fail = (code, message) => ({ ok: false, code, message });
const clone = value => JSON.parse(JSON.stringify(value));

// Internal coordinator for explicitly mapped tasks. No server/CLI activates it.
// Backends and resolveContext are server-owned capabilities, never request data.
// A backend must durably close a dispatch identity: a delayed start after close
// must be rejected, even when the earlier start acknowledgement was lost.
export function createDeliveryExecutionCoordinator(directory, { enabled = false, now = Date.now,
  resolveContext, backends = {} } = {}) {
  const registry = new Map(Object.entries(backends));
  const storeWith = observation => createDeliveryStore(directory, { enabled, now,
    resolveContext: (record, command) => {
      const context = resolveContext?.(record, command);
      return context && { ...context, execution_observation: observation };
    } });
  const store = storeWith();
  const backendFor = name => {
    const backend = registry.get(name);
    return backend && ['start', 'close', 'inspect'].every(method => typeof backend[method] === 'function') ? backend : null;
  };
  function current(id, command, grant) {
    if (enabled !== true) return fail('disabled', 'Delivery execution is not enabled.');
    let record;
    try { record = store.read(id); } catch { return fail('corrupt_store', 'Reconcile private delivery state before execution.'); }
    if (!record?.lease || !record.execution || !sameExecution(executionRef(record), command)) {
      return fail('stale_execution', 'Read the current execution identity before recovery.');
    }
    const context = resolveContext?.(clone(record), clone(command));
    if (!isOwnerId(context?.actor_id) || !Array.isArray(context?.grants) || !context.grants.includes(`delivery:${grant}`)) {
      return fail('not_authorized', `The authenticated actor needs delivery:${grant}.`);
    }
    const backend = backendFor(record.execution.backend);
    if (!backend) return fail('backend_unavailable', 'The recorded execution backend is unavailable; ownership is held.');
    return { ok: true, record, backend };
  }
  return {
    read: store.read,
    reserve(id, command) {
      if (enabled !== true) return fail('disabled', 'Delivery execution is not enabled.');
      if (!backendFor(command?.execution?.backend)) return fail('backend_unavailable', 'Select a configured execution backend.');
      return store.execute(id, { ...command, action: 'acquire' });
    },
    async dispatch(id, command) {
      const c = { ...command, action: 'dispatch' };
      const checked = current(id, c, 'dispatch');
      if (!checked.ok) return checked;
      const claimed = store.execute(id, c);
      // A receipt or uncertain commit never authorizes another external start.
      if (!claimed.ok || claimed.replayed) return claimed;
      try {
        await checked.backend.start(Object.freeze(executionRef(checked.record)));
      } catch {
        return fail('dispatch_uncertain', 'Dispatch acknowledgement is unavailable. Reconcile this identity; do not submit again.');
      }
      // A start acknowledgement is not completion or stop evidence.
      return { ok: true, revision: claimed.revision, phase: 'dispatching', reconciliation_required: true };
    },
    async stop(id, command) {
      const c = { ...command, action: 'request_stop' };
      const checked = current(id, c, 'request_stop');
      if (!checked.ok) return checked;
      const requested = store.execute(id, c);
      if (!requested.ok) return requested;
      // Retrying close is safe by backend contract. Re-read before acting on a
      // replayed receipt; it may belong to an execution that has been replaced.
      const live = current(id, c, 'request_stop');
      if (!live.ok) return live;
      try { await live.backend.close(Object.freeze(executionRef(live.record))); }
      catch { return fail('stop_unconfirmed', 'Backend closure is unconfirmed; keep ownership and reconcile.'); }
      return { ok: true, revision: live.record.revision, phase: live.record.execution.phase, reconciliation_required: true };
    },
    async reconcile(id, command) {
      const c = { ...command, action: 'observe_execution' };
      const checked = current(id, c, 'observe_execution');
      if (!checked.ok) return checked;
      let observation;
      try { observation = await checked.backend.inspect(Object.freeze(executionRef(checked.record))); }
      catch { return fail('backend_unavailable', 'Backend status is unavailable; ownership remains held.'); }
      // Recheck authority, revision and the exact lease under the store lock
      // after the asynchronous lookup. No mutable shared observation context.
      return storeWith(observation).execute(id, c);
    },
    release(id, command) {
      // The store derives stop evidence from its committed backend observation.
      if (enabled !== true) return fail('disabled', 'Delivery execution is not enabled.');
      let record;
      try { record = store.read(id); } catch { return fail('corrupt_store', 'Reconcile private delivery state before release.'); }
      if (!record?.execution) return fail('stale_execution', 'This task has no coordinated execution journal.');
      return store.execute(id, { ...command, action: 'release' });
    },
  };
}
