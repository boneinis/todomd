import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, sleep, BUDGET } from './helpers.js';
import { readCard } from '../src/board.js';
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
  let r = voice.rejectVoiceAction(p, prep.proposalId);
  assert.equal(r.status, 200);
  assert.equal(r.rejected, true);
  assert.equal(status(repo, 'task-0001'), 'Build', 'rejecting never executes the action');

  // the rejected proposal cannot later be confirmed
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404);
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
    r = voice.rejectVoiceAction(p, prep2.proposalId);
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

  // the correctly-bound confirm still works
  r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do', cardId: 'task-0001', action: 'retriage' });
  assert.equal(r.status, 200);
  assert.equal(status(repo, 'task-0001'), 'Review');
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
  const rej = voice.rejectVoiceAction(p, winner.proposalId);
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

test('invalidateProject drops every pending proposal for a removed repository', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });

  const prep = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
  assert.equal(prep.status, 200);

  voice.invalidateProject(repo);

  let r = await voice.confirmVoiceAction(p, prep.proposalId, { confirmation: 'Yes To-do' });
  assert.equal(r.status, 404);
  r = voice.rejectVoiceAction(p, prep.proposalId);
  assert.equal(r.status, 404);
  assert.equal(status(repo, 'task-0001'), 'Build');
});
