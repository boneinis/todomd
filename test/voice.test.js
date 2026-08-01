import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, sleep, BUDGET } from './helpers.js';
import { readCard, patchFrontmatter, withRepoLock } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as voice from '../src/voice.js';

const noop = () => {};
function project(repo) { return { name: path.basename(repo), path: repo }; }
function budgetProject(repo) {
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return project(repo);
}
const status = (repo, id) => readCard(repo, id).data.status;

// Several tests here spawn a hanging fake agent to exercise cancel. Sweep any
// live child at the end so a missed cancel path can't stall the whole suite.
after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

test('allowlist: unknown or disallowed actions are refused, and delete is never exposed', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  for (const action of ['delete', 'dispatch', 'run_shell', 'bulk_archive', '']) {
    const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action });
    assert.equal(r.status, 400, action);
    assert.match(r.error, /unknown or disallowed voice action|invalid card id/);
  }
  // an invalid card id is rejected before any file lookup
  const bad = await voice.prepareVoiceAction(p, { cardId: '../../etc/passwd', action: 'retriage' });
  assert.equal(bad.status, 400);

  assert.equal((await voice.prepareVoiceAction(p, null)).status, 400);
  const inherited = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'toString' });
  assert.equal(inherited.status, 400);
  assert.match(inherited.error, /unknown or disallowed/);
});

test('approve preparation shares every guarded board eligibility check', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const chunks = '## Chunks\n\n```yaml\n- title: A\n  plan: do a\n  criteria: [a]\n- title: B\n  plan: do b\n  criteria: [b]\n```';
  writeCard(repo, 'task-0001', { status: 'Planned', body: chunks });

  const prepared = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
  assert.equal(prepared.status, 400);
  assert.match(prepared.error, /never materialized/);
  assert.equal(status(repo, 'task-0001'), 'Planned');

  const boardResult = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(boardResult.ok, false);
  assert.equal(boardResult.error, prepared.error);
});

test('read-only summary and card status are deterministic and surface Needs Human + active runs', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Review' });
  writeCard(repo, 'task-0002', { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\n' });

  const s1 = voice.buildVoiceSummary(p);
  const s2 = voice.buildVoiceSummary(p);
  assert.equal(s1.text, s2.text, 'the same board state always produces the same summary text');
  assert.deepEqual(s1.needsHuman, [{ id: 'task-0002', title: 'Test card', reason: 'bad_verdict' }]);
  assert.match(s1.text, /task-0002 \(bad_verdict\)/);
  assert.match(s1.text, /Nothing building right now\./);
  assert.equal(s1.counts.Review, 1);
  assert.equal(s1.counts['Needs Human'], 1);

  const cs = await voice.buildCardStatus(p, 'task-0002');
  assert.match(cs.text, /task-0002:.*Needs Human/);
  assert.match(cs.text, /reason: bad_verdict/);
  assert.equal(await voice.buildCardStatus(p, 'task-9999'), null);
});

test('summary excludes process-global banners and carries no wall-clock timestamp', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo({ triage: true });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Review' });
  // a malformed card triggers a process-global banner (shared across every open
  // project, not scoped to this one) — the same fixture pipeline.test.js uses
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0009-broken.md'), '---\nbad: [unclosed\n---\n');
  pipeline.triageSweep(p);
  const banners = pipeline.getBanners();
  assert.ok(banners.length > 0, 'sanity: a banner exists');

  const s = voice.buildVoiceSummary(p);
  assert.equal('generatedAt' in s, false, 'no wall-clock timestamp — the response stays fully deterministic');
  for (const b of banners) {
    assert.doesNotMatch(s.text, new RegExp(b.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'a process-global banner must never leak into one project\'s spoken summary');
  }
});

test('budget-mode columns and fresh leases are externally active and cannot be moved by voice', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = budgetProject(repo);
  const now = Math.floor(Date.now() / 1000);
  writeCard(repo, 'task-0001', { status: 'Build' });
  writeCard(repo, 'task-0002', { status: 'Verify' });
  writeCard(repo, 'task-0003', { status: 'Planned' });
  writeCard(repo, 'task-0004', { status: 'Plan', extra: `lease: "${now} worker@host"\n` });
  writeCard(repo, 'task-0005', { status: 'Review', extra: `lease: "${now} worker@host"\n` });
  writeCard(repo, 'task-0006', { status: 'Plan', extra: `lease: "${now - 901} old@host"\n` });

  const summary = voice.buildVoiceSummary(p);
  assert.deepEqual(summary.activeRuns, [
    { card: 'task-0001', state: 'running', stage: 'Build', external: true },
    { card: 'task-0002', state: 'running', stage: 'Verify', external: true },
    { card: 'task-0004', state: 'running', stage: 'Plan', external: true },
    { card: 'task-0005', state: 'running', stage: 'Triage', external: true },
  ]);
  assert.match(summary.text, /task-0001 running Build through the dispatcher/);
  assert.match((await voice.buildCardStatus(p, 'task-0002')).text, /running Verify through the dispatcher/);
  assert.match((await voice.buildCardStatus(p, 'task-0004')).text, /running Plan through the dispatcher/);

  for (const action of ['retriage', 'retry_planned', 'archive']) {
    const prepared = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action });
    assert.equal(prepared.status, 400, action);
    assert.match(prepared.error, /external Build run.*dispatcher/, action);
  }
  const cancel = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
  assert.equal(cancel.status, 400);
  assert.match(cancel.error, /external dispatcher run/);
  assert.equal(status(repo, 'task-0001'), 'Build');

  const leased = await voice.prepareVoiceAction(p, { cardId: 'task-0004', action: 'retriage' });
  assert.equal(leased.status, 400);
  assert.match(leased.error, /external Plan run.*dispatcher/);
  const staleLease = await voice.prepareVoiceAction(p, { cardId: 'task-0006', action: 'retriage' });
  assert.equal(staleLease.status, 200, 'an expired dispatcher lease does not freeze voice actions');

  // Confirmation re-derives external ownership rather than trusting the state
  // captured while the card was still idle.
  const idle = await voice.prepareVoiceAction(p, { cardId: 'task-0003', action: 'retriage' });
  await patchFrontmatter(repo, 'task-0003', { status: 'Build' });
  const stale = await voice.confirmVoiceAction(p, idle.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(stale.status, 409);
  assert.equal(status(repo, 'task-0003'), 'Build');
});

test('summary text stays concise on a busy board: it names a handful, then a count', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  for (let i = 1; i <= 8; i++) {
    writeCard(repo, `task-000${i}`, { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\n' });
  }

  const s = voice.buildVoiceSummary(p);
  assert.equal(s.needsHuman.length, 8, 'the structured list stays complete');
  assert.match(s.text, /^8 cards on the board\. Nothing building right now\. 8 need you: .*, and 3 more\.$/);
  assert.equal((s.text.match(/task-\d+/g) || []).length, 5, 'only the first five are named in speech');
});

test('prepare returns an opaque proposal, exact read-back, expiry, and confirmation policy — without touching the board', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(r.status, 200);
  assert.match(r.proposalId, /^[a-f0-9]{32}$/, 'an opaque, unguessable token');
  assert.equal(r.readback, 'move task-0001 back to Review');
  assert.equal(r.confirmation.tier, 'reversible');
  assert.equal(r.confirmation.phrase, 'Yes To-do');
  assert.equal(r.confirmation.challenge, null);
  assert.equal(r.confirmation.visibleApprovalRequired, false);
  assert.ok(new Date(r.expiresAt).getTime() > Date.now(), 'expiry is in the future');

  // preparing changes nothing on the board
  assert.equal(status(repo, 'task-0001'), 'Build');
});

test('confirm executes exactly once: a wrong phrase does not execute, a replay is refused', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });

  // wrong phrase: refused, proposal still usable, board unchanged
  let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'sure thing' });
  assert.equal(r.status, 400);
  assert.match(r.error, /Yes To-do/);
  assert.equal(status(repo, 'task-0001'), 'Build');

  // exact phrase (case/punctuation-insensitive) executes the guarded transition
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'yes, to-do!' });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(status(repo, 'task-0001'), 'Review');

  // replay: the same proposal id can never execute again
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404);
  assert.match(r.error, /no such pending proposal/);
});

test('reject consumes the proposal without ever executing it', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  let r = await voice.rejectVoiceAction(p, prep.proposalId);
  assert.equal(r.status, 200);
  assert.equal(r.rejected, true);
  assert.equal(status(repo, 'task-0001'), 'Build', 'rejecting never executes the action');

  // the rejected proposal cannot later be confirmed
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404);

  const stalePrep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  await patchFrontmatter(repo, 'task-0001', { status: 'Needs Human' });
  r = await voice.rejectVoiceAction(p, stalePrep.proposalId);
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal((await voice.rejectVoiceAction(p, stalePrep.proposalId)).status, 404,
    'a stale rejection consumes the obsolete proposal');
});

test('expiry: a proposal outside its TTL can neither confirm nor reject', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  process.env.TODOMD_VOICE_PROPOSAL_TTL_MS = '30';
  try {
    const repo = makeRepo();
    const p = project(repo);
    writeCard(repo, 'task-0001', { status: 'Build' });
    const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    await sleep(80);
    let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
    assert.equal(r.status, 410);
    assert.match(r.error, /expired/);
    assert.equal(status(repo, 'task-0001'), 'Build');

    const prep2 = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    await sleep(80);
    r = await voice.rejectVoiceAction(p, prep2.proposalId);
    assert.equal(r.status, 410);
  } finally {
    delete process.env.TODOMD_VOICE_PROPOSAL_TTL_MS;
  }
});

test('stale: a card that changed state between prepare and confirm is refused, not executed', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\n' });

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retry_planned' });
  assert.equal(prep.status, 200);

  // the board moves on without the voice channel (a human dragged it themselves)
  await pipeline.humanMove(p, 'task-0001', 'Review');
  assert.equal(status(repo, 'task-0001'), 'Review');

  const r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0001'), 'Review', 'the stale confirm executed nothing');

  // a stale confirm still spends the proposal — no infinite retries against a moving target
  const again = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(again.status, 404);
});

test('ambiguous: a second pending proposal for the same card is refused, and a mismatched binding is refused', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });
  writeCard(repo, 'task-0002', { status: 'Build' });

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(prep.status, 200);

  // a second prepare for the SAME card is ambiguous while one is pending
  const dupe = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(dupe.status, 409);
  assert.match(dupe.error, /ambiguous/);

  // readCard also accepts the filename slug as an alias; it must canonicalize
  // to the same physical card reservation, not create a second proposal.
  const alias = await voice.prepareVoiceAction(p, { cardId: 'task-0001-card', action: 'retriage' });
  assert.equal(alias.status, 409);
  assert.match(alias.error, /ambiguous/);

  // a different card can still be prepared concurrently
  const other = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'retriage' });
  assert.equal(other.status, 200);

  // confirming with a cardId/action that doesn't match the bound proposal is ambiguous
  let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do', cardId: 'task-0002' });
  assert.equal(r.status, 409);
  assert.match(r.error, /ambiguous/);
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do', action: 'archive' });
  assert.equal(r.status, 409);
  assert.match(r.error, /ambiguous/);
  r = await voice.confirmVoiceAction(p, prep.proposalId, {
    confirmation: 'Yes To-do', cardId: 0, action: '',
  });
  assert.equal(r.status, 409, 'explicit falsy bindings are mismatches, not omitted fields');
  assert.match(r.error, /ambiguous/);

  r = await voice.rejectVoiceAction(p, other.proposalId, { cardId: 0, action: '' });
  assert.equal(r.status, 409, 'reject applies the same exact property-presence binding');
  assert.match(r.error, /ambiguous/);
  assert.equal((await voice.rejectVoiceAction(p, other.proposalId, {
    cardId: 'task-0002', action: 'retriage',
  })).status, 200);

  // the correctly-bound confirm still works
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do', cardId: 'task-0001', action: 'retriage' });
  assert.equal(r.status, 200);
  assert.equal(status(repo, 'task-0001'), 'Review');
});

test('voice approval preserves a hand-edited scalar dependency', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = budgetProject(repo);
  writeCard(repo, 'task-0002', { status: 'Review' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('dependencies: []', 'dependencies: task-0002'));

  const prepared = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
  assert.equal(prepared.status, 400);
  assert.match(prepared.error, /blocked by: task-0002/);
  assert.equal(status(repo, 'task-0001'), 'Planned');
});

test('confirmation tiers: reversible needs the spoken phrase, agent needs the fresh challenge, visible needs in-app approval only', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = budgetProject(repo); // budget mode: approving Planned->Queue does not spawn an agent
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Review' });

  // agent tier ("start or resume an agent"): a spoken "Yes To-do" is not enough
  const approve = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
  assert.equal(approve.confirmation.tier, 'agent');
  assert.match(approve.confirmation.challenge, /^Confirm approve task-0001 \w+$/);
  let r = await voice.confirmVoiceAction(p, approve.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 400);
  assert.match(r.error, /challenge phrase/);
  r = await voice.confirmVoiceAction(p, approve.proposalId, { confirmation: 'confirm approve task-0001 wrong-word' });
  assert.equal(r.status, 400);
  // the exact fresh challenge (case-insensitive) executes it
  r = await voice.confirmVoiceAction(p, approve.proposalId, { confirmation: approve.confirmation.challenge.toUpperCase() });
  assert.equal(r.status, 200);
  assert.equal(status(repo, 'task-0001'), 'Queue');

  // visible tier (archive): no spoken phrase can substitute for visible approval
  const archive = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'archive' });
  assert.equal(archive.confirmation.tier, 'visible');
  assert.equal(archive.confirmation.visibleApprovalRequired, true);
  r = await voice.confirmVoiceAction(p, archive.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 400);
  assert.match(r.error, /visible approval/);
  assert.equal(readCard(repo, 'task-0002').data.archived, undefined);
  r = await voice.confirmVoiceAction(p, archive.proposalId, { visibleApproval: true });
  assert.equal(r.status, 200);
  assert.ok(readCard(repo, 'task-0002').data.archived, 'visible approval alone executes it');
});

test('agent challenges bind cryptographic proposal entropy and never reuse the small word pool', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = budgetProject(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  const challenges = new Set();

  for (let i = 0; i < 24; i++) {
    const prepared = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
    assert.equal(prepared.status, 200);
    assert.ok(prepared.confirmation.challenge.endsWith(prepared.proposalId.slice(0, 16)));
    challenges.add(prepared.confirmation.challenge);
    assert.equal((await voice.rejectVoiceAction(p, prepared.proposalId)).status, 200);
  }
  assert.equal(challenges.size, 24);
});

test('unarchive is a harmless reversible move (Yes To-do), and archive/unarchive eligibility rejects the wrong state', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Review' });

  // cannot unarchive a card that isn't archived
  let r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'unarchive' });
  assert.equal(r.status, 400);

  const archive = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'archive' });
  await voice.confirmVoiceAction(p, archive.proposalId, { visibleApproval: true });
  assert.ok(readCard(repo, 'task-0001').data.archived);

  // cannot re-archive an already-archived card
  r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'archive' });
  assert.equal(r.status, 400);
  assert.match(r.error, /already archived/);
  for (const action of ['approve', 'retriage', 'retry_planned', 'cancel']) {
    r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action });
    assert.equal(r.status, 400, action);
    assert.match(r.error, /archived.*restore/, action);
  }

  const unarchive = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'unarchive' });
  assert.equal(unarchive.confirmation.tier, 'reversible');
  r = await voice.confirmVoiceAction(p, unarchive.proposalId, { confirmation: 'yes to do' });
  assert.equal(r.status, 200);
  assert.equal(readCard(repo, 'task-0001').data.archived, undefined);
});

test('recovery actions stay gated by the same eligibility pipeline.recoveryActions already enforces', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Review' }); // not Needs Human, nothing to recover

  for (const action of ['resume_build', 'restart_build', 'retry_verification']) {
    const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action });
    assert.equal(r.status, 400, action);
    assert.match(r.error, /not available for this card/);
  }
  // and cancel refuses when there is nothing live to cancel
  const c = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
  assert.equal(c.status, 400);
  assert.match(c.error, /no live run/);
  // approve refuses off of the wrong column
  const a = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
  assert.equal(a.status, 400);
  // retry_planned refuses off of the wrong column
  const rp = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retry_planned' });
  assert.equal(rp.status, 400);
});

test('cancel (visible tier) revalidates the live run at confirm time and executes at most once', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-cancel'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
    assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'));

    const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
    assert.equal(prep.confirmation.tier, 'visible');

    // a spoken phrase alone cannot cancel a running build
    let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
    assert.equal(r.status, 400);
    assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'still running — the wrong confirmation executed nothing');

    r = await voice.confirmVoiceAction(p, prep.proposalId, { visibleApproval: true });
    assert.equal(r.status, 200);
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
  } finally {
    clearFakeAgent();
  }
});

test('prepare is race-free: two concurrent prepares for the same card never both win', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  // restart_build's eligibility check (recoveryActions) does real async work
  // (reads/validates a possible preserved worktree) — the exact shape of the
  // race the fix closes: two prepares racing through that await.
  writeCard(repo, 'task-0001', {
    status: 'Needs Human',
    extra: 'needs_human_reason: orphaned_run\nsession_id: stale-session\nworktree: todomd/task-0001\nbase_branch: main\n',
  });
  assert.equal((await pipeline.recoveryActions(p, 'task-0001')).restart_build, true);

  const [a, b] = await Promise.all([
    voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'restart_build' }),
    voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'restart_build' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'exactly one prepare wins; the other is refused as ambiguous');
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert.match(loser.error, /ambiguous/);

  // only the winner's proposal is outstanding — a third prepare still collides with it
  const third = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'restart_build' });
  assert.equal(third.status, 409);

  // rejecting the winner frees the card for a fresh prepare again
  const rej = await voice.rejectVoiceAction(p, winner.proposalId);
  assert.equal(rej.status, 200);
  const fresh = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'restart_build' });
  assert.equal(fresh.status, 200);
});

test('proposals are bound to the resolved repo path, not the reusable display name', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repoA = makeRepo();
  const repoB = makeRepo();
  writeCard(repoA, 'task-0001', { status: 'Build' });
  writeCard(repoB, 'task-0001', { status: 'Build' });

  const pA = { name: 'shared-name', path: repoA };
  const prep = await voice.prepareVoiceAction(pA, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(prep.status, 200);

  // a different repository registered under the SAME display name (e.g. the
  // original project was removed and an unrelated repo claimed the freed name)
  const pB = { name: 'shared-name', path: repoB };
  let r = await voice.confirmVoiceAction(pB, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404, 'a proposal prepared against repo A must not execute against repo B under the same name');
  assert.equal(status(repoB, 'task-0001'), 'Build', 'repo B is untouched');

  // the ORIGINAL repository can still confirm its own proposal
  r = await voice.confirmVoiceAction(pA, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 200);
  assert.equal(status(repoA, 'task-0001'), 'Review');
});

test('a live run makes retriage ineligible: the reversible phrase can never reach a cancellation', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-live-retriage'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
    assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'));

    // humanMove(…, 'Review') on a live card is a run cancellation, not a move —
    // it must never be offered as a "Yes To-do" reversible proposal
    const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(r.status, 400);
    assert.match(r.error, /live run — cancel it in the app first/);
    assert.equal(r.proposalId, undefined, 'nothing was proposed at all');
    assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'the refused prepare cancelled nothing');

    // the same refusal for the other worktree-discarding move
    const rp = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retry_planned' });
    assert.equal(rp.status, 400);
    assert.match(rp.error, /live run — cancel it in the app first/);

    // cancel remains the ONLY route to stopping it, still under visible approval
    const c = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
    assert.equal(c.status, 200);
    assert.equal(c.confirmation.tier, 'visible');
    assert.equal(c.readback, 'cancel the running build for task-0001');
    const done = await voice.confirmVoiceAction(p, c.proposalId, { visibleApproval: true });
    assert.equal(done.status, 200);
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
  } finally {
    clearFakeAgent();
  }
});

test('cancel read-back names the actual running stage', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-plan-cancel'), 'started');
  useFakeAgent({ hang: 'plan', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'Plan' });
    const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
    assert.equal(prep.status, 200);
    assert.equal(prep.readback, 'cancel the running Plan run for task-0001');
    assert.equal((await voice.rejectVoiceAction(p, prep.proposalId)).status, 200);
  } finally {
    pipeline.cancel(p, 'task-0001');
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
    clearFakeAgent();
  }
});

// Park a claimed build chain in its between-spawns window: the chain's first
// board write (the worktree add) queues behind this lock, so `pending` holds the
// card while `children`/`runs` stay empty — the exact window where hasLiveRun is
// true but a runs-only view reports an idle board.
function holdRepoLock(repo) {
  let release;
  const held = new Promise((r) => { release = r; });
  const done = withRepoLock(repo, () => held);
  return () => { release(); return done; };
}

test('a chain claimed between spawns counts as live everywhere: summary, cancel, and refused moves agree', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-pending'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  let release = null;
  try {
    // processQueue claims the chain synchronously inside humanMove, so taking
    // the repo lock now parks it before addWorktree — nothing is ever spawned
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    release = holdRepoLock(repo);

    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.equal(fs.existsSync(marker), false, 'no agent child yet — this is the pending-only window');
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'in progress' });

    const s = voice.buildVoiceSummary(p);
    assert.equal(s.activeRuns.length, 1, 'a claimed chain is an active run');
    assert.doesNotMatch(s.text, /Nothing building/, 'the summary must not report an idle board');
    assert.match((await voice.buildCardStatus(p, 'task-0001')).text, /running in progress/);

    // the false idle used to let a "Yes To-do" retriage cancel this chain
    const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(r.status, 400);
    assert.match(r.error, /live run/);

    // …while cancel, which CAN act on a claimed chain, is correctly offered
    const c = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'cancel' });
    assert.equal(c.status, 200);
    assert.equal(c.confirmation.tier, 'visible');
    assert.equal(c.readback, 'cancel the active run for task-0001');
    // This fixture deliberately holds the repository transaction open. A real
    // reject must wait for that transaction to revalidate atomically, so clear
    // the test-only proposal synchronously instead of deadlocking the fixture.
    voice.invalidateProject(repo);
  } finally {
    // flag the parked chain (revertTo Review, so it is not re-driven), then let
    // it reach its cancel checkpoint and settle
    await pipeline.humanMove(p, 'task-0001', 'Review');
    if (release) await release();
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
    clearFakeAgent();
  }
});

test('a queued Build cannot be retriaged under reversible voice confirmation', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-queued'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
    await pipeline.humanMove(p, 'task-0002', 'Queue');
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0002'], { state: 'queued', stage: 'Build' });

    const retriage = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'retriage' });
    assert.equal(retriage.status, 400);
    assert.match(retriage.error, /queued Build run/);
    assert.equal(status(repo, 'task-0002'), 'Queue');

    const cancel = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'cancel' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.readback, 'take task-0002 out of the build queue');
    assert.equal((await voice.rejectVoiceAction(p, cancel.proposalId)).status, 200);
  } finally {
    pipeline.cancel(p, 'task-0002');
    pipeline.cancel(p, 'task-0001');
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
    clearFakeAgent();
  }
});

test('pending run ownership uses exact project identity when names contain colons', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-colon-project'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const plain = { ...project(makeRepo()), name: 'alpha' };
  const nested = { ...project(makeRepo()), name: 'alpha:beta' };
  writeCard(plain.path, 'task-0001', { status: 'Review' });
  writeCard(nested.path, 'task-0002', { status: 'Planned' });

  try {
    await pipeline.humanMove(nested, 'task-0002', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
    assert.equal(pipeline.hasLiveRun(nested.name, 'task-0002'), true);
    assert.deepEqual(pipeline.getRunStates(plain.name), {});
    assert.equal(voice.buildVoiceSummary(plain).activeRuns.length, 0);
    assert.match(voice.buildVoiceSummary(plain).text, /Nothing building right now/);
  } finally {
    pipeline.cancel(nested, 'task-0002');
    await until(() => !pipeline.hasLiveRun(nested.name, 'task-0002'), { timeout: BUDGET.chain });
    clearFakeAgent();
  }
});

test('voice summaries and card status sanitize and bound user-controlled card text', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', {
    status: 'Needs Human',
    title: `Title ${'y'.repeat(4000)}`,
    extra: `needs_human_reason: "${'x'.repeat(4000)}\\nsecond line"\n`,
  });

  const summary = voice.buildVoiceSummary(p);
  assert.ok(summary.text.length <= 1200, `summary was ${summary.text.length} characters`);
  assert.ok(summary.needsHuman[0].reason.length <= 160);
  assert.doesNotMatch(summary.text, /[\u0000-\u001f\u007f]/);
  assert.match(summary.needsHuman[0].reason, /…$/);

  const cardStatus = await voice.buildCardStatus(p, 'task-0001');
  assert.ok(cardStatus.text.length <= 1200, `card status was ${cardStatus.text.length} characters`);
  assert.doesNotMatch(cardStatus.text, /[\u0000-\u001f\u007f]/);
  assert.match(cardStatus.text, /…/);
});

test('argumentless proposals bind normalized arguments through confirm and reject', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  let r = await voice.prepareVoiceAction(p, {
    cardId: 'task-0001', action: 'retriage', arguments: { destination: 'Done' },
  });
  assert.equal(r.status, 400);
  assert.match(r.error, /accepts no arguments/);

  const prep = await voice.prepareVoiceAction(p, {
    cardId: 'task-0001', action: 'retriage', arguments: {},
  });
  assert.deepEqual(prep.arguments, {});

  r = await voice.confirmVoiceAction(p, prep.proposalId, {
    confirmation: 'Yes To-do', arguments: { destination: 'Done' },
  });
  assert.equal(r.status, 409);
  assert.equal(status(repo, 'task-0001'), 'Build');

  r = await voice.confirmVoiceAction(p, prep.proposalId, {
    confirmation: 'Yes To-do', arguments: {},
  });
  assert.equal(r.status, 200);
  assert.equal(status(repo, 'task-0001'), 'Review');

  const reject = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'archive' });
  r = await voice.rejectVoiceAction(p, reject.proposalId, { arguments: { reason: 'different' } });
  assert.equal(r.status, 409);
  assert.equal((await voice.rejectVoiceAction(p, reject.proposalId, { arguments: {} })).status, 200);
});

test('epic-wide cascades are unavailable by voice: retriage, approve, and archive refuse unfinished children', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'epic: true\n' });
  writeCard(repo, 'task-0002', { status: 'Planned', extra: 'parent: task-0001\n' });
  writeCard(repo, 'task-0003', { status: 'Done', extra: 'parent: task-0001\n' });

  // Review/archive would clean up the child and approve would release it into
  // Queue. All are multi-card effects, so all are refused at preparation.
  for (const action of ['retriage', 'approve', 'archive']) {
    const r = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action });
    assert.equal(r.status, 400, action);
    assert.match(r.error, /epic with 1 unfinished child card/);
    assert.match(r.error, /not available by voice/);
  }
  assert.equal(status(repo, 'task-0002'), 'Planned', 'the refused prepares archived nothing');

  // Once no child would be cascaded, retriage is single-card again. Approval is
  // still refused because an all-Done epic completes rather than starting an
  // agent, so its read-back/tier could not match this action's contract.
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0002-card.md'),
    fs.readFileSync(path.join(repo, '.todomd/tasks/task-0002-card.md'), 'utf8').replace('status: Planned', 'status: Done'));
  const approveDoneEpic = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'approve' });
  assert.equal(approveDoneEpic.status, 400);
  assert.match(approveDoneEpic.error, /epic approvals/);
  const ok = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(ok.status, 200);
  assert.equal(ok.confirmation.tier, 'reversible');
});

test('read-backs are generated from the real effect: project mode and worktree discard are both disclosed', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const launcher = project(makeRepo());
  const budget = budgetProject(makeRepo());
  writeCard(launcher.path, 'task-0001', { status: 'Planned' });
  writeCard(budget.path, 'task-0001', { status: 'Planned' });
  writeCard(launcher.path, 'task-0002', { status: 'Planned', extra: 'epic: true\n' });
  writeCard(budget.path, 'task-0002', { status: 'Planned', extra: 'epic: true\n' });

  // budget mode has no launcher: Planned -> Queue only parks the card for the
  // /todomd-dispatch session, so "start the build" would be a false promise
  assert.equal((await voice.prepareVoiceAction(launcher, { cardId: 'task-0001', action: 'approve' })).readback,
    'approve task-0001 and start the build');
  assert.equal((await voice.prepareVoiceAction(budget, { cardId: 'task-0001', action: 'approve' })).readback,
    'approve task-0001 and queue it for the dispatcher');
  // A childless epic has no truthful agent-starting read-back and is refused.
  assert.match((await voice.prepareVoiceAction(launcher, { cardId: 'task-0002', action: 'approve' })).error,
    /epic approvals/);
  assert.match((await voice.prepareVoiceAction(budget, { cardId: 'task-0002', action: 'approve' })).error,
    /epic approvals/);

  // a move that deletes a preserved worktree says so, and leaves the reversible tier
  const p = project(makeRepo());
  writeCard(p.path, 'task-0001', { status: 'Needs Human', extra: 'needs_human_reason: bad_verdict\nworktree: todomd/task-0001\n' });
  writeCard(p.path, 'task-0002', { status: 'Build', extra: 'worktree: todomd/task-0002\n' });
  writeCard(p.path, 'task-0003', { status: 'Build' });

  const rp = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retry_planned' });
  assert.equal(rp.readback, 'send task-0001 back to Planned for another look, discarding its preserved worktree');
  assert.equal(rp.confirmation.tier, 'visible');
  assert.equal(rp.confirmation.phrase, null, 'no spoken phrase can authorize destroying preserved work');

  const rt = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'retriage' });
  assert.equal(rt.readback, 'move task-0002 back to Review, discarding its preserved worktree');
  assert.equal(rt.confirmation.tier, 'visible');

  // …and a card with nothing preserved keeps the plain reversible read-back
  const plain = await voice.prepareVoiceAction(p, { cardId: 'task-0003', action: 'retriage' });
  assert.equal(plain.readback, 'move task-0003 back to Review');
  assert.equal(plain.confirmation.tier, 'reversible');
});

test('stale detection covers every input the policy was derived from, not just the column', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);

  // (1) a worktree appearing turns a plain move into a destructive one
  writeCard(repo, 'task-0001', { status: 'Build' });
  let prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(prep.confirmation.tier, 'reversible');
  await patchFrontmatter(repo, 'task-0001', { worktree: 'todomd/task-0001' });
  let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0001'), 'Build', 'nothing executed');

  // (2) a child becoming unfinished turns a single-card move into a cascade
  writeCard(repo, 'task-0002', { status: 'Queue', extra: 'epic: true\n' });
  writeCard(repo, 'task-0003', { status: 'Done', extra: 'parent: task-0002\n' });
  prep = await voice.prepareVoiceAction(p, { cardId: 'task-0002', action: 'retriage' });
  assert.equal(prep.status, 200);
  await patchFrontmatter(repo, 'task-0003', { status: 'Planned' });
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0003'), 'Planned', 'the child was never cascaded');

  // (3) approval eligibility changes when a dependency stops being Done.
  writeCard(repo, 'task-0004', { status: 'Planned', deps: ['task-0005'] });
  writeCard(repo, 'task-0005', { status: 'Done' });
  prep = await voice.prepareVoiceAction(p, { cardId: 'task-0004', action: 'approve' });
  assert.equal(prep.status, 200);
  await patchFrontmatter(repo, 'task-0005', { status: 'Review' });
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: prep.confirmation.challenge });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0004'), 'Planned');

  // (4) replacing one preserved branch with another must not let an earlier
  // visible approval discard the replacement merely because both are truthy.
  writeCard(repo, 'task-0006', { status: 'Build', extra: 'worktree: todomd/old-branch\n' });
  prep = await voice.prepareVoiceAction(p, { cardId: 'task-0006', action: 'retriage' });
  assert.equal(prep.confirmation.tier, 'visible');
  await patchFrontmatter(repo, 'task-0006', { worktree: 'todomd/replacement-branch' });
  r = await voice.confirmVoiceAction(p, prep.proposalId, { visibleApproval: true });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0006'), 'Build');
  assert.equal(readCard(repo, 'task-0006').data.worktree, 'todomd/replacement-branch');

  // (5) an archive racing confirmation cannot turn a visible-board action into
  // an invisible mutation.
  writeCard(repo, 'task-0007', { status: 'Build' });
  prep = await voice.prepareVoiceAction(p, { cardId: 'task-0007', action: 'retriage' });
  await patchFrontmatter(repo, 'task-0007', { archived: true });
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 409);
  assert.match(r.error, /stale/);
  assert.equal(status(repo, 'task-0007'), 'Build');
  assert.equal(readCard(repo, 'task-0007').data.archived, true);
});

test('confirm revalidation and mutation are atomic with concurrent board writes', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });
  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });

  const confirm = voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  // This writer queues behind the confirmation transaction. It must land after
  // the confirmed Review move, never be overwritten by a stale confirm.
  const concurrent = patchFrontmatter(repo, 'task-0001', { status: 'Needs Human' });
  const [confirmed] = await Promise.all([confirm, concurrent]);
  assert.equal(confirmed.status, 200);
  assert.equal(status(repo, 'task-0001'), 'Needs Human');
});

test('a run that goes live between prepare and confirm makes the proposal stale, not destructive', async () => {
  isolateHome();
  const marker = path.join(tmp('voice-race'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    // prepared while idle: a genuinely harmless "Yes To-do" move
    const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(prep.status, 200);
    assert.equal(prep.confirmation.tier, 'reversible');

    // …then the board starts a build under it
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });

    const r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
    assert.equal(r.status, 409);
    assert.match(r.error, /stale/);
    assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'the stale confirm cancelled nothing');
  } finally {
    pipeline.cancel(p, 'task-0001');
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
    clearFakeAgent();
  }
});

test('invalidateProject drops every pending proposal for a removed repository', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  // invalidation can interleave with an asynchronous eligibility check; the
  // prepare call must not return 200 for an id already removed from the map
  const preparing = voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  voice.invalidateProject(repo);
  const invalidated = await preparing;
  assert.equal(invalidated.status, 409);
  assert.match(invalidated.error, /invalidated while preparing/);

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(prep.status, 200);

  voice.invalidateProject(repo);

  let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404);
  r = await voice.rejectVoiceAction(p, prep.proposalId);
  assert.equal(r.status, 404);
  assert.equal(status(repo, 'task-0001'), 'Build');
});
