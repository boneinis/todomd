import { createDeliveryStore } from '../src/delivery-store.js';
import { deliveryStoreDirectory } from '../src/delivery-runtime.js';

// Synthetic private state only. Call isolateHome() before using this fixture.
export function seedDelivery(repo, id, { leased = false } = {}) {
  if (!process.env.TODOMD_HOME?.includes('todomd-test-')) throw new Error('Delivery fixture requires an isolated test home.');
  const task = { id, schema_version: 2,
    delivery: { state: 'backlog', completion_policy: 'released', target_environment: 'production' },
    ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' } };
  const directory = deliveryStoreDirectory(repo);
  const store = createDeliveryStore(directory, { enabled: true, now: () => 1000,
    resolveContext: () => ({ actor_id: 'human:owner', busy: false,
      grants: ['initialize', 'ready', 'acquire', 'in_progress'].map(g => `delivery:${g}`),
      facts: { private_reference: 'private-evidence-do-not-expose',
        ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])),
        admission: { authorized: true, dependencies_satisfied: true, owner: 'agent-role:builder' } } }) });
  const results = [store.execute(id, { action: 'initialize', task, source_revision: 'a'.repeat(64), expected_revision: 0, idempotency_key: 'init' })];
  if (leased) {
    results.push(store.execute(id, { action: 'transition', to: 'ready', expected_revision: 1, idempotency_key: 'ready' }));
    results.push(store.execute(id, { action: 'acquire', run_id: 'private-run-do-not-expose', ttl_ms: 1, expected_revision: 2, idempotency_key: 'acquire' }));
  }
  if (results.some(r => !r.ok)) throw new Error(JSON.stringify(results));
  return { directory, store };
}
