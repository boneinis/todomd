// Delivery v2 is a preview contract. No function in this module writes cards,
// dispatches agents, or grants authority. A future mutation adapter must supply
// authenticated grants and reconciled facts, never values copied from a card.
export const DELIVERY_STATES = Object.freeze([
  'backlog', 'ready', 'in_progress', 'in_review', 'ready_to_release', 'released', 'completed', 'cancelled',
]);
export const OWNER_ROLES = Object.freeze(['delivery_lead', 'implementation', 'reviewer', 'release']);
const POLICIES = ['released', 'completed'];
const BLOCKERS = ['dependency', 'environment', 'provider', 'implementation', 'review', 'publication', 'product_decision'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const isOwnerId = value => typeof value === 'string' && /^(human|agent-role):[a-z0-9][a-z0-9._-]{0,79}$/.test(value);

export function validateDeliveryTask(task) {
  const issues = [];
  const issue = (path, code, message) => issues.push({ path, code, message });
  if (!object(task)) return { ok: false, version: null, issues: [{ path: '', code: 'invalid_task', message: 'Task must be an object.' }] };
  const version = Object.hasOwn(task, 'schema_version') ? task.schema_version : 1;
  const additions = ['delivery', 'ownership', 'blocker'].filter(key => Object.hasOwn(task, key));
  if (version === 1) {
    for (const key of additions) issue(key, 'version_required', 'Delivery fields require schema_version: 2.');
    return { ok: !issues.length, version, issues };
  }
  if (version !== 2) return { ok: false, version, issues: [{ path: 'schema_version', code: 'unsupported_version', message: 'Supported schema versions are 1 and 2.' }] };
  const keys = (value, prefix, allowed) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`${prefix}.${key}`, 'unknown_field', 'Unknown delivery field.');
  };
  if (!object(task.delivery)) issue('delivery', 'required', 'Version 2 requires a delivery object.');
  else {
    const d = task.delivery;
    keys(d, 'delivery', ['state', 'completion_policy', 'cycle_id', 'target_environment']);
    if (!DELIVERY_STATES.includes(d.state)) issue('delivery.state', 'invalid_state', 'Unknown delivery state.');
    if (!POLICIES.includes(d.completion_policy)) issue('delivery.completion_policy', 'invalid_policy', 'Choose released or completed.');
    for (const key of ['cycle_id', 'target_environment']) {
      if (Object.hasOwn(d, key) && !nonempty(d[key])) issue(`delivery.${key}`, 'invalid_string', 'Use a nonempty string or omit this field.');
    }
    if (d.state === 'completed' && d.completion_policy !== 'completed') issue('delivery.state', 'policy_mismatch', 'Deployment-required work cannot finish as Completed.');
    if (['released', 'ready_to_release'].includes(d.state) && d.completion_policy !== 'released') issue('delivery.state', 'policy_mismatch', 'This state requires a release completion policy.');
    if (d.completion_policy === 'released' && !['backlog', 'cancelled'].includes(d.state) && !nonempty(d.target_environment)) issue('delivery.target_environment', 'required', 'Release-bound work needs a target environment before Ready.');
  }
  if (!object(task.ownership)) issue('ownership', 'required', 'Version 2 requires an ownership object (it may be empty in Backlog).');
  else {
    keys(task.ownership, 'ownership', OWNER_ROLES);
    for (const role of OWNER_ROLES) {
      if (Object.hasOwn(task.ownership, role) && !isOwnerId(task.ownership[role])) issue(`ownership.${role}`, 'invalid_owner', 'Use a stable human:<id> or agent-role:<id> identity.');
    }
    if (task.ownership.implementation && task.ownership.implementation === task.ownership.reviewer) issue('ownership.reviewer', 'self_review', 'Implementation and review must have distinct owners.');
    if (task.delivery && !['backlog', 'cancelled'].includes(task.delivery.state)) {
      for (const role of [...OWNER_ROLES.filter(r => r !== 'release'), ...(task.delivery.completion_policy === 'released' ? ['release'] : [])]) {
        if (!isOwnerId(task.ownership[role])) issue(`ownership.${role}`, 'required', 'An accountable owner is required before Ready.');
      }
    }
  }
  if (Object.hasOwn(task, 'blocker')) {
    if (!object(task.blocker)) issue('blocker', 'invalid_blocker', 'A blocker must be an object; omit it when unblocked.');
    else {
      const b = task.blocker;
      keys(b, 'blocker', ['category', 'owner', 'since', 'evidence', 'next_action']);
      if (!BLOCKERS.includes(b.category)) issue('blocker.category', 'invalid_category', 'Unknown blocker category.');
      if (!isOwnerId(b.owner)) issue('blocker.owner', 'invalid_owner', 'A blocker needs a stable responsible owner.');
      if (!nonempty(b.since) || !/^\d{4}-\d\d-\d\dT/.test(b.since) || !Number.isFinite(Date.parse(b.since))) issue('blocker.since', 'invalid_time', 'Use a quoted ISO timestamp.');
      for (const key of ['evidence', 'next_action']) if (!nonempty(b[key])) issue(`blocker.${key}`, 'required', 'Explain the evidence and the next action.');
      if (['released', 'completed', 'cancelled'].includes(task.delivery?.state)) issue('blocker', 'terminal_blocker', 'Resolve the blocker before recording a terminal state.');
    }
  }
  return { ok: !issues.length, version, issues };
}

const EDGES = Object.freeze({
  backlog: ['ready', 'cancelled'],
  ready: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['in_review', 'backlog', 'cancelled'],
  in_review: ['in_progress', 'ready_to_release', 'completed', 'backlog', 'cancelled'],
  ready_to_release: ['released', 'in_progress', 'cancelled'],
  released: ['backlog'], completed: ['backlog'], cancelled: ['backlog'],
});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);

// Pure assessment only. `context` is a future server adapter's trusted input:
// current revision, authenticated actor/grants, active-owner state and evidence.
// There is deliberately no HTTP/CLI route accepting this context from a user.
export function evaluateDeliveryTransition(task, request, context = {}) {
  if (!object(context)) context = {};
  const validation = validateDeliveryTask(task);
  const reject = (code, message) => ({ ok: false, code, message });
  if (!validation.ok || validation.version !== 2) return { ...reject('invalid_schema', 'A valid version 2 task is required.'), issues: validation.issues };
  if (!object(request) || !nonempty(context.revision) || request.expected_revision !== context.revision) return reject('stale_revision', 'Read the current task revision before requesting a transition.');
  const from = task.delivery.state, to = request.to;
  if (!EDGES[from]?.includes(to)) return reject('invalid_transition', `Transition from ${from} to ${String(to)} is not supported.`);
  const grant = `delivery:${to}`;
  if (!isOwnerId(context.actor_id) || !Array.isArray(context.grants) || !context.grants.includes(grant)) return reject('not_authorized', `The authenticated actor needs ${grant}.`);
  if (context.busy !== false) return reject('active_work', 'Establish that no execution or admission owns the task first.');
  const withdrawal = ['backlog', 'cancelled'].includes(to);
  if ((withdrawal || to === 'in_progress' && from !== 'ready') && !nonempty(request.reason)) return reject('reason_required', 'Record the reason for cancellation, reopening, withdrawal, or rework.');
  if (task.blocker && !withdrawal) return reject('blocked', 'Resolve the blocker through its recorded next action first.');
  const facts = object(context.facts) ? context.facts : {};
  const proposed = { ...task, delivery: { ...task.delivery, state: to } };
  if (withdrawal) delete proposed.blocker;
  const nextValidation = validateDeliveryTask(proposed);
  if (!nextValidation.ok) return { ...reject('invalid_destination', 'Destination requirements are incomplete.'), issues: nextValidation.issues };
  if (to === 'ready') {
    if (!['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].every(key => facts.ready?.[key] === true)) return reject('not_ready', 'Scope, criteria, validation, target, dependencies, and planning approval must be established.');
  }
  if (to === 'in_progress') {
    if (facts.admission?.authorized !== true || facts.admission?.dependencies_satisfied !== true || facts.admission?.owner !== task.ownership.implementation) return reject('admission_required', 'An authorized implementation assignment and satisfied dependencies are required.');
  }
  if (to === 'in_review' && (!sha(facts.candidate?.head) || facts.candidate?.preserved !== true || facts.candidate?.clean !== true)) return reject('candidate_required', 'A clean preserved candidate commit is required.');
  if (['ready_to_release', 'completed', 'released'].includes(to)) {
    const head = facts.candidate?.head;
    if (!sha(head) || facts.candidate?.clean !== true || !nonempty(facts.policy_revision)) return reject('candidate_required', 'Establish the current clean candidate and policy revision.');
    const matching = evidence => evidence?.passed === true && evidence.head === head && evidence.policy_revision === facts.policy_revision && nonempty(evidence.reference);
    if (!matching(facts.checks) || !matching(facts.review)) return reject('evidence_required', 'Checks and review must pass for the current candidate and policy.');
    if (facts.review.reviewer !== task.ownership.reviewer || !nonempty(facts.review.run_id) || !nonempty(facts.candidate.run_id) || facts.review.run_id === facts.candidate.run_id) return reject('independent_review_required', 'The assigned independent reviewer must review in a separate run.');
    if (to === 'completed') {
      if (facts.acceptance?.accepted !== true || !nonempty(facts.acceptance.reference)) return reject('acceptance_required', 'Record acceptance under the non-deployment completion policy.');
    } else {
      const merged = facts.integration;
      if (merged?.confirmed !== true || merged.candidate_head !== head || !sha(merged.merged_head) || !nonempty(facts.target_branch) || merged.target_branch !== facts.target_branch || !nonempty(merged.reference)) return reject('integration_required', 'Integration evidence must identify this candidate and the intended target.');
      if (to === 'released') {
        const release = facts.release;
        if (release?.deployed !== true || release.verified !== true || release.rolled_back !== false || release.merged_head !== merged.merged_head || release.environment !== task.delivery.target_environment || !nonempty(release.reference)) return reject('release_required', 'A successful verified deployment of the integrated change to the required environment is necessary.');
      }
    }
  }
  return { ok: true, from, to, expected_revision: context.revision,
    requirements_satisfied: true, effect: 'assessment_only', preserves_candidate: true,
    reason: request.reason || '' };
}

export function deliveryActions(task, context = {}) {
  if (!object(context)) context = {};
  // Assessment and per-destination explanations share exactly one evaluator.
  return DELIVERY_STATES.filter(to => to !== task?.delivery?.state).map(to => ({ to,
    ...evaluateDeliveryTransition(task, { to, expected_revision: context.revision, reason: context.reason }, context) }));
}
