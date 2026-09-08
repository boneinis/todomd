// Pure execution journal rules. Backend observations enter only through the
// store's trusted context resolver, never through a delivery command body.
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const fail = (code, message) => ({ ok: false, code, message });
export const EXECUTION_ACTIONS = ['dispatch', 'request_stop', 'observe_execution'];
export const executionRef = r => ({ task_id: r.task.id, lease_id: r.lease.id,
  run_id: r.lease.run_id, fence: r.lease.fence, backend: r.execution.backend,
  source_revision: r.execution.source_revision });
export const sameExecution = (a, b) => a && b &&
  ['task_id', 'lease_id', 'run_id', 'fence', 'backend', 'source_revision'].every(k => a[k] === b[k]);

export function validExecution(e, r) {
  if (e === undefined || e === null) return true; // pre-journal records
  return identity(e.backend) && sha(e.source_revision) && e.source_revision === r.source_revision &&
    ['reserved', 'dispatching', 'running', 'stop_requested', 'stopped'].includes(e.phase) &&
    (r.lease !== null || e.phase === 'stopped') &&
    (e.phase !== 'stopped' || e.observation?.state === 'stopped' && e.observation.closed === true &&
      text(e.observation.reference)) &&
    (!e.observation || ['running', 'unknown', 'stopped'].includes(e.observation.state) &&
      text(e.observation.reference) && (r.lease === null || sameExecution(e.observation, executionRef(r))));
}

export function admissionMatches(context, execution, sourceRevision, owner) {
  const a = context.execution_admission, eligibility = context.facts?.admission;
  return identity(execution?.backend) && sha(execution?.source_revision) &&
    execution.source_revision === sourceRevision && a?.fenced === true &&
    a.backend === execution.backend && a.source_revision === sourceRevision &&
    eligibility?.authorized === true && eligibility.dependencies_satisfied === true && eligibility.owner === owner;
}

export function applyExecution(r, c, context, time) {
  const e = r.execution;
  if (!e || !sameExecution(executionRef(r), c)) return fail('stale_execution', 'Use the current execution identity and source revision.');
  if (c.action === 'dispatch') {
    if (e.phase !== 'reserved') return fail('dispatch_claimed', 'Dispatch was already claimed; reconcile without submitting again.');
    if (r.lease.expires_at <= time) return fail('lease_expired', 'Reconcile the expired reservation before execution.');
    if (!admissionMatches(context, e, r.source_revision, r.lease.owner) || context.busy !== false) {
      return fail('admission_required', 'Revalidate source and fenced legacy/remote admission before dispatch.');
    }
    e.phase = 'dispatching'; // publish before calling any external backend
  } else if (c.action === 'request_stop') {
    if (e.phase !== 'stopped') e.phase = 'stop_requested';
  } else {
    const o = context.execution_observation;
    if (!sameExecution(executionRef(r), o) || !text(o.reference) ||
      !['running', 'unknown', 'stopped'].includes(o.state) ||
      (o.state === 'stopped' && o.closed !== true)) {
      return fail('stop_unconfirmed', 'The backend must confirm the exact execution and permanently close its dispatch identity before release.');
    }
    // A stopped dispatch identity is terminal. Late observations cannot reopen it.
    if (e.phase === 'stopped') return fail('execution_closed', 'This execution is already closed.');
    e.observation = { ...executionRef(r), state: o.state, closed: o.closed === true, reference: o.reference };
    if (o.state === 'stopped') e.phase = 'stopped';
    else if (o.state === 'running' && e.phase !== 'stop_requested') e.phase = 'running';
    // Unknown/absent/timeout never undo dispatching or a stop request.
  }
  return { ok: true };
}
