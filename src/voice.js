import crypto from 'node:crypto';
import { loadBoard, loadConfig, readCard } from './board.js';
import {
  humanMove, cancel, resumeBuild, restartBuild, retryVerification, archiveCard,
  recoveryActions, getRunStates, hasLiveRun,
} from './pipeline.js';

// Spoken summaries stay short even on a busy board — list at most this many
// active runs / Needs Human cards by name, then say how many more there are.
const MAX_SUMMARY_ITEMS = 5;
const MAX_SUMMARY_FIELD_CHARS = 160;
const MAX_SUMMARY_TEXT_CHARS = 1200;

// Same shape createCard uses: task-0001, zero-padded, growing past 4 digits.
// Voice card ids arrive in a JSON body rather than a URL path, so this route
// validates them itself instead of relying on server.js's path-level guard.
const CARD_ID = /^task-\d{1,6}(-[\w-]*)?$/;

function normalizePhrase(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function boundedText(value, max = MAX_SUMMARY_FIELD_CHARS) {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// The current allowlist is deliberately argumentless. Normalize an omitted or
// empty object to the exact value stored on the proposal, and refuse anything
// else instead of silently dropping parameters that a caller may believe were
// authorized.
function argumentless(fields) {
  if (fields.arguments === undefined) return { ok: true, value: {} };
  const args = fields.arguments;
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) {
    return { ok: false, error: 'this voice action accepts no arguments' };
  }
  return { ok: true, value: {} };
}

// What an action would ACTUALLY do to this card, right now.
//
// The guarded operations behind the allowlist are state-polymorphic: the single
// call `humanMove(…, 'Review')` is a harmless column move on an idle card, a run
// cancellation on a live one, a worktree deletion on one that kept its build,
// and a multi-card archive on an epic. So tier, eligibility, read-back and the
// stale check are all derived from this probe rather than hardcoded per action
// name — a name-keyed policy keeps promising "harmless and undoable" for
// whichever variant the board happens to be in.
function computeEffects(project, card) {
  const id = card.data.id;
  // the same predicate humanMove/archiveCard/cancel branch on: it covers a
  // spawned child AND a chain claimed between spawns
  const live = hasLiveRun(project.name, id);
  // mirrors cascadeEpicCleanup's own filter (active, non-Done, non-epic children)
  let cascadeChildren = 0;
  if (card.data.epic) {
    cascadeChildren = loadBoard(project.path).cards
      .filter((c) => c.parent === id && c.status !== 'Done' && !c.epic).length;
  }
  let mode = 'launcher';
  try { mode = loadConfig(project.path).mode || 'launcher'; } catch { /* unreadable config reads as the default */ }
  return {
    live,
    // runs ∪ pending ∪ queues — exactly the three cases pipeline.cancel acts on
    runState: getRunStates(project.name)[id] || null,
    epic: !!card.data.epic,
    cascadeChildren,
    worktree: !!card.data.worktree,
    budget: mode === 'budget',
  };
}

// A fingerprint of everything the tier, eligibility and read-back were derived
// from — not just the card's own columns. Confirm re-derives it from a fresh
// read and refuses on a mismatch, so a run that goes live (or a worktree that
// appears, or a child that stops being Done) between prepare and confirm turns
// the proposal stale instead of quietly changing what the confirmed phrase buys.
function fingerprint(card, fx) {
  return [
    card.data.status || '(none)',
    card.data.archived ? 'archived' : 'active',
    fx.live ? 'live' : 'idle',
    fx.worktree ? 'worktree' : 'no-worktree',
    `children:${fx.cascadeChildren}`,
    fx.budget ? 'budget' : 'launcher',
  ].join(' ');
}

// "Fresh" (changes every proposal) and "task-specific" (names the card), so a
// stray "yes" overheard on the microphone can never satisfy it by accident.
const CHALLENGE_WORDS = [
  'amber', 'cedar', 'delta', 'ember', 'harbor', 'indigo', 'juniper', 'lumen',
  'meridian', 'onyx', 'quartz', 'summit', 'tundra', 'violet', 'willow', 'zephyr',
];
function buildChallenge(action, cardId) {
  const word = CHALLENGE_WORDS[crypto.randomInt(CHALLENGE_WORDS.length)];
  return `Confirm ${action.replace(/_/g, ' ')} ${cardId} ${word}`;
}

// Voice never cancels a run as a side effect of a move. humanMove's Review
// branch kills a live child (or flags a claimed chain) — the operation
// docs/voice.md puts under visible approval — so a move prepared against a live
// card is refused outright rather than smuggled in behind a "Yes To-do".
// Cancelling stays reachable only through the explicit `cancel` action.
function notWhileLive(card, fx) {
  return fx.live
    ? { ok: false, error: `${card.data.id} has a live run — cancel it in the app first` }
    : null;
}

// Voice is strictly single-card. Moving/archiving an epic can cascade cleanup,
// while approving one releases its ready children; either affects multiple
// cards, and bulk actions are unavailable by voice at any tier.
function notEpicCascade(card, fx) {
  const n = fx.cascadeChildren;
  if (!n) return null;
  return {
    ok: false,
    error: `${card.data.id} is an epic with ${n} unfinished child card${n === 1 ? '' : 's'} — epic-wide actions are not available by voice`,
  };
}

// Discarding a preserved worktree throws away build state that moving the card
// back cannot recover, so a move that would do it leaves the reversible tier and
// joins cancel/restart/archive under visible approval (docs/voice.md).
const moveTier = (fx) => (fx.worktree ? 'visible' : 'reversible');
const worktreeClause = (fx) => (fx.worktree ? ', discarding its preserved worktree' : '');

// The allowlist: every entry maps 1:1 to an existing guarded board/pipeline
// operation the human UI already exposes. There is deliberately no generic
// "move" or "dispatch" action, no delete, and no bulk form — only these named,
// single-card operations can ever be proposed.
//
// tier(effects) drives the confirmation policy (docs/voice.md's phrase table):
//   reversible — harmless, undoable moves               → speak "Yes To-do"
//   agent      — starts or resumes an agent run          → repeat a fresh challenge phrase
//   visible    — cancel / restart-build / archive, and   → visible in-app approval only
//                any move that destroys preserved work
// label(card, effects) must describe exactly what execute() will do on THIS
// state — never a clause the execute path won't perform, and never silent about
// one it will.
const ALLOWED_ACTIONS = {
  retriage: {
    tier: moveTier,
    label: (card, fx) => `move ${card.data.id} back to Review${worktreeClause(fx)}`,
    eligible: (card, project, fx) => notWhileLive(card, fx) || notEpicCascade(card, fx) || { ok: true },
    execute: (project, id) => humanMove(project, id, 'Review'),
  },
  approve: {
    tier: () => 'agent',
    // budget mode has no launcher: Planned→Queue only parks the card for the
    // /todomd-dispatch session, so promising "start the build" would be a lie
    label: (card, fx) => `approve ${card.data.id} and ${fx.budget ? 'queue it for the dispatcher' : 'start the build'}`,
    // Epic approval either releases multiple unfinished children, completes an
    // all-Done tracker, or strands a childless tracker in Queue. None matches
    // this single-card, agent-starting action's contract, so voice refuses all
    // epic approvals and leaves them to the visible board UI.
    eligible: (card, project, fx) => (card.data.epic
      ? (notEpicCascade(card, fx) || { ok: false, error: 'epic approvals are not available by voice' })
      : (card.data.status === 'Planned'
        ? { ok: true } : { ok: false, error: `${card.data.id} is not in Planned` })),
    execute: (project, id) => humanMove(project, id, 'Queue'),
  },
  retry_planned: {
    tier: moveTier,
    label: (card, fx) => `send ${card.data.id} back to Planned for another look${worktreeClause(fx)}`,
    eligible: (card, project, fx) => notWhileLive(card, fx) || (card.data.status === 'Needs Human'
      ? { ok: true } : { ok: false, error: `${card.data.id} is not in Needs Human` }),
    execute: (project, id) => humanMove(project, id, 'Planned'),
  },
  resume_build: {
    tier: () => 'agent',
    label: (card) => `resume the build for ${card.data.id} in its preserved worktree`,
    eligible: async (card, project) => ((await recoveryActions(project, card.data.id)).resume_build
      ? { ok: true } : { ok: false, error: 'resume build is not available for this card' }),
    execute: (project, id) => resumeBuild(project, id),
  },
  retry_verification: {
    tier: () => 'agent',
    label: (card) => `retry verification for ${card.data.id} in its preserved worktree`,
    eligible: async (card, project) => ((await recoveryActions(project, card.data.id)).retry_verification
      ? { ok: true } : { ok: false, error: 'retry verification is not available for this card' }),
    execute: (project, id) => retryVerification(project, id),
  },
  restart_build: {
    tier: () => 'visible',
    // restartBuild is only eligible when NO preserved worktree survives, so it
    // never has one to discard — no worktree clause here on purpose
    label: (card) => `restart the build for ${card.data.id} from scratch`,
    eligible: async (card, project) => ((await recoveryActions(project, card.data.id)).restart_build
      ? { ok: true } : { ok: false, error: 'restart build is not available for this card' }),
    execute: (project, id) => restartBuild(project, id),
  },
  cancel: {
    tier: () => 'visible',
    label: (card, fx) => (fx.runState?.state === 'queued'
      ? `take ${card.data.id} out of the build queue`
      : `cancel the running build for ${card.data.id}`),
    // runState is runs ∪ pending ∪ queues — the exact three cases pipeline.cancel
    // can act on, so eligibility and execution agree, including in the
    // between-spawns windows where only `pending` holds the claim.
    eligible: (card, project, fx) => (fx.runState
      ? { ok: true } : { ok: false, error: 'no live run to cancel' }),
    execute: (project, id) => cancel(project, id),
  },
  archive: {
    tier: () => 'visible',
    // archiveCard releases the card's resources first, which removes its worktree
    label: (card, fx) => `archive ${card.data.id}${worktreeClause(fx)}`,
    eligible: (card, project, fx) => (card.data.archived
      ? { ok: false, error: `${card.data.id} is already archived` }
      : notWhileLive(card, fx) || notEpicCascade(card, fx) || { ok: true }),
    execute: (project, id) => archiveCard(project, id, true),
  },
  unarchive: {
    tier: () => 'reversible',
    label: (card) => `restore ${card.data.id} from the archive`,
    eligible: (card) => (card.data.archived
      ? { ok: true } : { ok: false, error: `${card.data.id} is not archived` }),
    execute: (project, id) => archiveCard(project, id, false),
  },
};

function defaultTtlMs() {
  const n = Number(process.env.TODOMD_VOICE_PROPOSAL_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000; // short-lived by default: a spoken confirmation window
}

// proposal id -> proposal. In-memory and per-process, like the rest of the
// pipeline's run state — a restart drops any pending proposal, which is the
// correct failure mode (nothing was executed).
const proposals = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [id, p] of proposals) if (now > p.expiresAt) proposals.delete(id);
}

// Identity is the resolved repo path, not the display name — registry names
// are reused (a removed project's basename is free again for an unrelated
// repo), so binding to name alone would let a proposal prepared against one
// repository be confirmed against a different one that later claims the name.
function pendingFor(projectPath, cardId) {
  const now = Date.now();
  for (const p of proposals.values()) {
    if (p.projectPath === projectPath && p.cardId === cardId && now <= p.expiresAt) return p;
  }
  return null;
}

// Drop every pending proposal for a repository that's been unregistered — a
// name freed by removal must never let a stale proposal resurface against
// whatever project claims that name (or, path being primary, that path) next.
export function invalidateProject(projectPath) {
  for (const [id, p] of proposals) if (p.projectPath === projectPath) proposals.delete(id);
}

// Returns { ok:true, proposal } or { ok:false, reason: 'missing' | 'expired' }.
// Expired proposals are swept on lookup so a client can't keep one alive by
// polling it.
function getProposal(id) {
  const p = proposals.get(id);
  if (!p) return { ok: false, reason: 'missing' };
  if (Date.now() > p.expiresAt) { proposals.delete(id); return { ok: false, reason: 'expired' }; }
  return { ok: true, proposal: p };
}

function checkPhrase(proposal, body) {
  if (proposal.tier === 'visible') {
    return body.visibleApproval === true
      ? { ok: true }
      : { ok: false, error: 'this action requires visible approval in the app, not a spoken confirmation' };
  }
  if (proposal.tier === 'agent') {
    return normalizePhrase(body.confirmation) === normalizePhrase(proposal.challenge)
      ? { ok: true }
      : { ok: false, error: 'repeat the exact challenge phrase to confirm this action' };
  }
  return normalizePhrase(body.confirmation) === 'yes to do'
    ? { ok: true }
    : { ok: false, error: 'say "Yes To-do" to confirm this action' };
}

// List at most MAX_SUMMARY_ITEMS by name, then say how many more exist —
// keeps the spoken text short and, since the count itself is exact, still
// deterministic and non-misleading on a busy board.
function describeList(list, render) {
  const shown = list.slice(0, MAX_SUMMARY_ITEMS).map(render).join(', ');
  const more = list.length - MAX_SUMMARY_ITEMS;
  return more > 0 ? `${shown}, and ${more} more` : shown;
}

// A deterministic, sanitized status summary for the "Report To-do" phrase and
// the Realtime read_board_report() tool. Pure function of THIS project's live
// board and in-memory run state — no process-global data (banners span every
// open project, not just this one) and no wall-clock timestamp, so the same
// board state always produces byte-identical output.
export function buildVoiceSummary(project) {
  const board = loadBoard(project.path);
  const runStates = getRunStates(project.name);
  const counts = {};
  for (const col of board.config.columns) counts[col] = 0;
  for (const c of board.cards) counts[c.status] = (counts[c.status] || 0) + 1;

  const activeRuns = Object.entries(runStates)
    .map(([card, s]) => ({ card, state: s.state, stage: boundedText(s.stage) }))
    .sort((a, b) => a.card.localeCompare(b.card));
  const needsHuman = board.cards
    .filter((c) => c.status === 'Needs Human')
    .map((c) => ({
      id: c.id,
      title: boundedText(c.title),
      reason: boundedText(c.needs_human_reason),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const parts = [`${board.cards.length} card${board.cards.length === 1 ? '' : 's'} on the board.`];
  parts.push(activeRuns.length
    ? `${activeRuns.length} active: ${describeList(activeRuns, (r) => `${r.card} ${r.state === 'queued' ? 'queued for' : 'running'} ${r.stage}`)}.`
    : 'Nothing building right now.');
  parts.push(needsHuman.length
    ? `${needsHuman.length} need${needsHuman.length === 1 ? 's' : ''} you: ${describeList(needsHuman, (n) => `${n.id}${n.reason ? ` (${n.reason})` : ''}`)}.`
    : 'Nothing needs you.');

  return { text: boundedText(parts.join(' '), MAX_SUMMARY_TEXT_CHARS), counts, activeRuns, needsHuman };
}

// A concise, deterministic diagnostic for one card — "Ask about a card".
export async function buildCardStatus(project, cardId) {
  const board = loadBoard(project.path, { includeArchived: true });
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const run = getRunStates(project.name)[cardId];
  const recovery = await recoveryActions(project, cardId);

  const bits = [`${cardId}: ${card.title || '(untitled)'} — ${card.status}`];
  if (card.archived) bits.push('archived');
  if (run) bits.push(run.state === 'queued' ? `queued for ${run.stage}` : `running ${run.stage}`);
  if (card.status === 'Needs Human' && card.needs_human_reason) bits.push(`reason: ${card.needs_human_reason}`);
  if (card.criteria) bits.push(`${card.criteria.done} of ${card.criteria.total} acceptance criteria met`);
  const available = ['resume_build', 'restart_build', 'retry_verification']
    .filter((k) => recovery[k]).map((k) => k.replace(/_/g, ' '));
  if (available.length) bits.push(`available: ${available.join(', ')}`);

  return { text: bits.join(' — '), id: cardId, status: card.status, archived: !!card.archived };
}

// Prepare an action: validate + read back, but never touch the board. Returns
// { status, ... } — status is the HTTP status the caller should reply with.
//
// The (project, card) reservation is inserted into `proposals` synchronously,
// before `def.eligible()` is awaited below. Some eligible() checks do real
// async work (recoveryActions reads the filesystem and validates a git
// worktree), and without a synchronous reservation two concurrent prepares for
// the same card would both find "nothing pending" and both succeed — this is
// what makes the ambiguity check race-free rather than merely a best effort.
export async function prepareVoiceAction(project, fields = {}) {
  pruneExpired();
  const requestedCardId = String(fields.cardId || '');
  const action = String(fields.action || '');
  const normalizedArguments = argumentless(fields);
  if (!normalizedArguments.ok) return { status: 400, ok: false, error: normalizedArguments.error };
  if (!CARD_ID.test(requestedCardId)) return { status: 400, ok: false, error: 'invalid card id' };
  const def = ALLOWED_ACTIONS[action];
  if (!def) return { status: 400, ok: false, error: `unknown or disallowed voice action: ${action}` };
  const card = readCard(project.path, requestedCardId);
  if (!card) return { status: 404, ok: false, error: `card not found: ${requestedCardId}` };
  // readCard accepts a filename prefix for existing UI routes. Voice proposals
  // must collapse every such alias onto the physical card's frontmatter id, or
  // two aliases can reserve and execute against the same card concurrently.
  const cardId = String(card.data.id || '');
  if (!CARD_ID.test(cardId)) return { status: 400, ok: false, error: 'card has an invalid canonical id' };
  if (pendingFor(project.path, cardId)) {
    return { status: 409, ok: false, error: 'ambiguous: a pending proposal already exists for this card — confirm or reject it first' };
  }

  // synchronous like readCard above (board and run state are both in-memory or
  // sync reads), so the reservation below is still inserted before any await
  const effects = computeEffects(project, card);
  const tier = def.tier(effects);

  const now = Date.now();
  const ttlMs = defaultTtlMs();
  const proposalId = crypto.randomBytes(16).toString('hex');
  const proposal = {
    id: proposalId, projectName: project.name, projectPath: project.path, cardId, action, tier,
    arguments: normalizedArguments.value,
    createdAt: now, expiresAt: now + ttlMs,
  };
  proposals.set(proposalId, proposal); // reserved — no other prepare can claim this card until this settles

  const elig = await def.eligible(card, project, effects);
  if (!elig.ok) {
    proposals.delete(proposalId); // nothing was proposed; release the reservation
    return { status: 400, ok: false, error: elig.error };
  }

  // fingerprinted from the SAME snapshot the tier and read-back were derived
  // from: anything that moved during the eligibility await makes this stale at
  // confirm time rather than silently re-classifying the action
  proposal.expectedFingerprint = fingerprint(card, effects);
  proposal.challenge = tier === 'agent' ? buildChallenge(action, cardId) : null;

  return {
    status: 200, ok: true, proposalId, cardId, action, arguments: proposal.arguments,
    readback: def.label(card, effects),
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    ttlMs,
    confirmation: {
      tier,
      phrase: tier === 'reversible' ? 'Yes To-do' : null,
      challenge: proposal.challenge,
      visibleApprovalRequired: tier === 'visible',
    },
  };
}

// Confirm binds to the exact proposal id — project-, card-, and action-bound —
// revalidates the live card, and executes at most once (the proposal is
// consumed before the guarded operation runs, so a slow or failing execute
// still can't be replayed).
export async function confirmVoiceAction(project, proposalId, body = {}) {
  const found = getProposal(proposalId);
  if (!found.ok) {
    return found.reason === 'expired'
      ? { status: 410, ok: false, error: 'proposal expired' }
      : { status: 404, ok: false, error: 'no such pending proposal' };
  }
  const p = found.proposal;
  if (p.projectPath !== project.path) return { status: 404, ok: false, error: 'no such pending proposal' };
  if ((body.cardId && body.cardId !== p.cardId) || (body.action && body.action !== p.action)) {
    return { status: 409, ok: false, error: 'ambiguous: does not match the pending proposal' };
  }
  const normalizedArguments = argumentless(body);
  if (!normalizedArguments.ok) return { status: 409, ok: false, error: 'ambiguous: arguments do not match the pending proposal' };
  const phrase = checkPhrase(p, body);
  if (!phrase.ok) return { status: 400, ok: false, error: phrase.error };

  // Consume now that the confirmation itself checks out — a concurrent or
  // replayed confirm loses the race here and gets "already used", never a
  // second execution.
  if (!proposals.delete(proposalId)) return { status: 409, ok: false, error: 'proposal already used' };

  const card = readCard(project.path, p.cardId);
  if (!card || fingerprint(card, computeEffects(project, card)) !== p.expectedFingerprint) {
    return { status: 409, ok: false, error: `stale: ${p.cardId} changed since this action was prepared` };
  }

  const def = ALLOWED_ACTIONS[p.action];
  const result = await def.execute(project, p.cardId, card);
  // status last: it must win over anything (unexpectedly) named `status` in a
  // guarded function's own result — the HTTP status code is never negotiable.
  return { ...result, proposalId, action: p.action, cardId: p.cardId, status: result.ok ? 200 : 400 };
}

export function rejectVoiceAction(project, proposalId, body = {}) {
  const found = getProposal(proposalId);
  if (!found.ok) {
    return found.reason === 'expired'
      ? { status: 410, ok: false, error: 'proposal expired' }
      : { status: 404, ok: false, error: 'no such pending proposal' };
  }
  const p = found.proposal;
  if (p.projectPath !== project.path) return { status: 404, ok: false, error: 'no such pending proposal' };
  if ((body.cardId && body.cardId !== p.cardId) || (body.action && body.action !== p.action)) {
    return { status: 409, ok: false, error: 'ambiguous: does not match the pending proposal' };
  }
  const normalizedArguments = argumentless(body);
  if (!normalizedArguments.ok) return { status: 409, ok: false, error: 'ambiguous: arguments do not match the pending proposal' };
  if (!proposals.delete(proposalId)) return { status: 409, ok: false, error: 'proposal already used' };
  return { status: 200, ok: true, rejected: true, proposalId, action: p.action, cardId: p.cardId };
}
