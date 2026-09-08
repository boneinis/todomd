import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_STATES, validateDeliveryTask, evaluateDeliveryTransition, deliveryActions } from '../src/delivery.js';

const head = 'a'.repeat(40), merged = 'b'.repeat(40);
function task(state = 'backlog', policy = 'released') {
  return { id: 'task-0001', status: 'Needs Human', schema_version: 2,
    delivery: { state, completion_policy: policy, target_environment: 'production' },
    ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' } };
}
function context(to) {
  return { revision: 'revision-1', actor_id: 'human:owner', grants: [`delivery:${to}`], busy: false,
    facts: { ready: Object.fromEntries(['scope_defined', 'criteria_defined', 'validation_plan', 'target_known', 'dependencies_valid', 'planning_approved'].map(k => [k, true])),
      admission: { authorized: true, dependencies_satisfied: true, owner: 'agent-role:builder' },
      candidate: { head, clean: true, preserved: true, run_id: 'implementation-1' }, policy_revision: 'policy-1', target_branch: 'main',
      checks: { passed: true, head, policy_revision: 'policy-1', reference: 'ci:1' },
      review: { passed: true, head, policy_revision: 'policy-1', reference: 'review:1', reviewer: 'agent-role:reviewer', run_id: 'review-1' },
      integration: { confirmed: true, candidate_head: head, merged_head: merged, target_branch: 'main', reference: 'pr:1' },
      release: { deployed: true, verified: true, rolled_back: false, merged_head: merged, environment: 'production', reference: 'deployment:1' },
      acceptance: { accepted: true, reference: 'acceptance:1' } } };
}
const assess = (card, to, ctx = context(to), reason = '') => evaluateDeliveryTransition(card, { to, expected_revision: 'revision-1', reason }, ctx);

test('schema is additive and never rewrites legacy runtime data', () => {
  const legacy = { id: 'task-1', status: 'Done', assignee: 'Alice', dependencies: ['task-0'], verification: { attempts: 3 }, worktree: 'branch' };
  const before = structuredClone(legacy);
  assert.deepEqual(validateDeliveryTask(legacy), { ok: true, version: 1, issues: [] });
  assert.deepEqual(legacy, before);
  assert.equal(validateDeliveryTask({ ...legacy, delivery: {} }).ok, false);
  for (const version of [null, '2', 0, 3]) assert.equal(validateDeliveryTask({ ...legacy, schema_version: version }).ok, false);
  assert.equal(validateDeliveryTask(task()).ok, true);
});

test('schema reports malformed ownership, blockers, policies and fields without guessing', () => {
  const mutations = [
    c => c.delivery = [], c => c.delivery.state = 'Done', c => c.delivery.completion_policy = 'auto',
    c => c.delivery.cycle_id = 4, c => c.delivery.relesed = true,
    c => c.ownership = 'claude', c => c.ownership.implementation = 'claude',
    c => c.ownership.reviewer = c.ownership.implementation,
    c => c.ownership.secret = 'unknown', c => c.blocker = { category: 'whatever' },
    c => c.blocker = [], c => c.blocker = { category: 'review', owner: 'human:owner', since: 'yesterday', evidence: 'waiting', next_action: 'review' },
  ];
  for (const mutate of mutations) { const card = task(); mutate(card); assert.equal(validateDeliveryTask(card).ok, false); }
  const backlog = task(); backlog.ownership = {};
  assert.equal(validateDeliveryTask(backlog).ok, true);
  backlog.delivery.state = 'ready';
  assert.equal(validateDeliveryTask(backlog).ok, false);
  assert.equal(validateDeliveryTask(task('completed', 'released')).ok, false);
  assert.equal(validateDeliveryTask(task('released', 'completed')).ok, false);
});

test('every delivery state has an explicit exit and assessments share action eligibility', () => {
  const exits = { backlog: 'ready', ready: 'in_progress', in_progress: 'in_review', in_review: 'ready_to_release', ready_to_release: 'released', released: 'backlog', completed: 'backlog', cancelled: 'backlog' };
  for (const state of DELIVERY_STATES) {
    const card = task(state, state === 'completed' ? 'completed' : 'released');
    const to = exits[state], ctx = { ...context(to), reason: 'human requested follow-up' };
    const before = structuredClone(card);
    assert.equal(assess(card, to, ctx, ctx.reason).ok, true, `${state} -> ${to}`);
    const action = deliveryActions(card, ctx).find(a => a.to === to);
    assert.equal(action.ok, true);
    assert.equal(action.effect, 'assessment_only');
    assert.deepEqual(card, before);
  }
  assert.equal(assess(task(), 'released').code, 'invalid_transition');
  assert.equal(assess(task('released'), 'backlog').code, 'reason_required');
});

test('revision, grants and active execution fence transitions even with complete evidence', () => {
  for (const [change, code] of [
    [c => c.revision = 'changed', 'stale_revision'], [c => c.grants = [], 'not_authorized'],
    [c => c.actor_id = 'claude', 'not_authorized'], [c => c.busy = true, 'active_work'],
    [c => delete c.busy, 'active_work'],
  ]) { const ctx = context('ready'); change(ctx); assert.equal(assess(task(), 'ready', ctx).code, code); }
  assert.equal(assess(task(), 'ready', null).ok, false);
  assert.equal(assess({ status: 'Planned' }, 'ready').code, 'invalid_schema');
});

test('Ready and execution admission require all prerequisites and stable ownership', () => {
  for (const field of Object.keys(context('ready').facts.ready)) {
    const ctx = context('ready'); delete ctx.facts.ready[field];
    assert.equal(assess(task(), 'ready', ctx).code, 'not_ready', field);
  }
  const ctx = context('in_progress'); ctx.facts.admission.owner = 'agent-role:other';
  assert.equal(assess(task('ready'), 'in_progress', ctx).code, 'admission_required');
  ctx.facts.admission.owner = 'agent-role:builder'; ctx.facts.admission.dependencies_satisfied = false;
  assert.equal(assess(task('ready'), 'in_progress', ctx).code, 'admission_required');
});

test('blocking retains the delivery stage, with explicit withdrawal preserving the candidate', () => {
  const card = task('in_review');
  card.blocker = { category: 'publication', owner: 'human:owner', since: '2026-09-08T12:00:00Z', evidence: 'review is pending', next_action: 'Review PR 1' };
  assert.equal(validateDeliveryTask(card).ok, true);
  assert.equal(assess(card, 'ready_to_release').code, 'blocked');
  assert.equal(assess(card, 'cancelled', context('cancelled'), 'withdraw scope').preserves_candidate, true);
  assert.equal(card.delivery.state, 'in_review');
  assert.ok(card.blocker);
});

test('checks, independent review and integration stay bound to the current candidate and policy', () => {
  const mutations = [
    [c => c.facts.candidate.head = 'c'.repeat(40), 'evidence_required'],
    [c => c.facts.policy_revision = 'new-policy', 'evidence_required'],
    [c => c.facts.candidate.clean = false, 'candidate_required'],
    [c => c.facts.review.run_id = c.facts.candidate.run_id, 'independent_review_required'],
    [c => c.facts.review.reviewer = 'agent-role:builder', 'independent_review_required'],
    [c => c.facts.integration.confirmed = false, 'integration_required'],
    [c => c.facts.integration.target_branch = 'other', 'integration_required'],
  ];
  for (const [mutate, code] of mutations) { const ctx = context('ready_to_release'); mutate(ctx); assert.equal(assess(task('in_review'), 'ready_to_release', ctx).code, code); }
  // Candidate and merge SHA may differ (a reconciled squash merge, for example),
  // but only a trusted integration adapter can attest that relationship.
  assert.equal(assess(task('in_review'), 'ready_to_release').ok, true);
});

test('merged is never released; deployment must match the environment and integrated change', () => {
  for (const mutate of [c => delete c.facts.release, c => c.facts.release.verified = false,
    c => c.facts.release.rolled_back = true, c => c.facts.release.environment = 'staging',
    c => c.facts.release.merged_head = head, c => c.facts.release.deployed = false]) {
    const ctx = context('released'); mutate(ctx);
    assert.equal(assess(task('ready_to_release'), 'released', ctx).code, 'release_required');
  }
  assert.equal(assess(task('in_review', 'completed'), 'completed').ok, true);
  const ctx = context('completed'); delete ctx.facts.acceptance;
  assert.equal(assess(task('in_review', 'completed'), 'completed', ctx).code, 'acceptance_required');
  assert.equal(assess(task('in_review'), 'completed').ok, false);
});
