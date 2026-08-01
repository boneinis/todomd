import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadBoard, loadConfig, readCard, withRepoLock } from './board.js';
import {
  humanMove, cancel, resumeBuild, restartBuild, retryVerification, archiveCard,
  recoveryActions, getRunStates, getRunGeneration, approvalEligibility,
} from './pipeline.js';

// Spoken summaries stay short even on a busy board — list at most this many
// active runs / Needs Human cards by name, then say how many more there are.
const MAX_SUMMARY_ITEMS = 5;
const MAX_SUMMARY_FIELD_CHARS = 160;
const MAX_SUMMARY_TEXT_CHARS = 1200;
// Must match the budget dispatcher's documented lease freshness window in
// templates.js. A fresh lease is the ownership signal while Plan/Triage runs
// outside this server and the card has not changed columns yet.
const BUDGET_LEASE_TTL_SEC = 900;

// Same shape createCard uses: task-0001, zero-padded, growing past 4 digits.
// Voice card ids arrive in a JSON body rather than a URL path, so this route
// validates them itself instead of relying on server.js's path-level guard.
const CARD_ID = /^task-\d{1,6}(-[\w-]*)?$/;

function safeText(value) {
  try { return String(value ?? ''); } catch { return ''; }
}

function normalizePhrase(s) {
  return safeText(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function boundedText(value, max = MAX_SUMMARY_FIELD_CHARS) {
  const clean = safeText(value)
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

function requestObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasFreshBudgetLease(card, nowSec) {
  const [claimedAt = ''] = safeText(card.lease).trim().split(/\s+/);
  if (!/^\d+$/.test(claimedAt)) return false;
  const timestamp = Number(claimedAt);
  const age = nowSec - timestamp;
  return Number.isSafeInteger(timestamp) && age >= 0 && age <= BUDGET_LEASE_TTL_SEC;
}

// The card body alone cannot distinguish an ABA transition such as
// Queue -> Planned -> Queue: the final bytes can be identical even though the
// proposal's original queue claim was replaced. Bind to the latest commit that
// touched this exact card. Unrelated board commits do not invalidate it, and an
// empty revision is still useful for a just-created/untracked test fixture —
// the first committed transition changes it from empty to a real object id.
function cardRevision(project, card) {
  try {
    return execFileSync('git', [
      'log', '-1', '--format=%H', '--', `.todomd/tasks/${card.file}`,
    ], { cwd: project.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Launcher runs live in pipeline.js's process maps. Budget-mode Build/Verify
// runs belong to the external dispatcher, so their execution column is the
// conservative ownership signal. Plan/Triage run before their column changes,
// so the dispatcher's fresh card lease is their ownership signal instead.
function effectiveRunStates(project, board) {
  const states = { ...getRunStates(project.name) };
  if ((board.config.mode || 'launcher') !== 'budget') return states;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const card of board.cards) {
    if (card.archived || states[card.id]) continue;
    if (['Build', 'Verify'].includes(card.status)) {
      states[card.id] = { state: 'running', stage: card.status, external: true };
    } else if (['Plan', 'Review'].includes(card.status) && hasFreshBudgetLease(card, nowSec)) {
      states[card.id] = {
        state: 'running',
        stage: card.status === 'Review' ? 'Triage' : 'Plan',
        external: true,
      };
    }
  }
  return states;
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
  // mirrors cascadeEpicCleanup's own filter (active, non-Done, non-epic children)
  const board = loadBoard(project.path, { includeArchived: true });
  const localRunState = getRunStates(project.name)[id] || null;
  const runState = effectiveRunStates(project, board)[id] || null;
  const cascadeChildren = card.data.epic
    ? board.cards.filter((c) => c.parent === id && c.status !== 'Done' && !c.epic && !c.archived).length
    : 0;
  // The board view normalizes scalar list fields from hand-edited YAML. Derive
  // the fingerprint/read-back from that same canonical dependency list so a
  // scalar dependency is neither ignored nor allowed to bypass approval.
  const dependencies = board.cards.find((c) => c.id === id)?.dependencies || [];
  const blockedDependencies = dependencies
    .filter((dep) => board.cards.find((c) => c.id === dep)?.status !== 'Done')
    .sort();
  let mode = 'launcher';
  try { mode = loadConfig(project.path).mode || 'launcher'; } catch { /* unreadable config reads as the default */ }
  return {
    // runState adds dispatcher-owned budget work for safety/reporting. Only the
    // local state is cancellable through pipeline.cancel.
    runState,
    cancellableRunState: localRunState,
    epic: !!card.data.epic,
    cascadeChildren,
    blockedDependencies,
    cardRevision: cardRevision(project, card),
    runGeneration: getRunGeneration(project.name, id),
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
  // Bind the complete persisted card record, not merely the presence of fields
  // that affect policy. In particular, replacing one preserved worktree/branch
  // with another must invalidate an approval that could otherwise discard the
  // replacement. This also covers recovery stage, reason, verification state,
  // and future execution-relevant frontmatter without another partial list.
  const cardDigest = crypto.createHash('sha256')
    .update(typeof card.raw === 'string' ? card.raw : JSON.stringify({ data: card.data, body: card.body }))
    .digest('hex');
  return [
    `card:${cardDigest}`,
    `revision:${fx.cardRevision || '(uncommitted)'}`,
    `run-generation:${fx.runGeneration}`,
    card.data.status || '(none)',
    card.data.archived ? 'archived' : 'active',
    fx.runState ? `run:${fx.runState.state}:${fx.runState.stage}:${fx.runState.external ? 'external' : 'local'}` : 'no-run',
    fx.cancellableRunState ? 'cancellable' : 'not-cancellable',
    `worktree:${safeText(card.data.worktree)}`,
    `children:${fx.cascadeChildren}`,
    `blocked:${fx.blockedDependencies.join(',')}`,
    fx.budget ? 'budget' : 'launcher',
  ].join(' ');
}

// "Fresh" (changes every proposal) and "task-specific" (names the card), so a
// stray "yes" overheard on the microphone can never satisfy it by accident.
function buildChallenge(action, cardId, proposalId) {
  // Bind 64 bits from the proposal's cryptographic nonce into the phrase. The
  // old one-word vocabulary repeated quickly enough that an earlier spoken
  // challenge could authorize a later proposal for the same card/action.
  const nonce = proposalId.slice(0, 16);
  return `Confirm ${action.replace(/_/g, ' ')} ${cardId} ${nonce}`;
}

// Voice never cancels or dequeues a run as a side effect of a move. humanMove's
// Review branch kills a live child but leaves a queued Build claimed for later,
// so every voice move that could reach a claimed card is refused outright rather
// than smuggled in behind a "Yes To-do".
// Cancelling stays reachable only through the explicit `cancel` action.
function notWhileLive(card, fx) {
  if (!fx.runState) return null;
  if (fx.runState.external) {
    return { ok: false, error: `${card.data.id} has an external ${fx.runState.stage} run — stop it in the dispatcher first` };
  }
  return fx.runState.state === 'queued'
    ? { ok: false, error: `${card.data.id} has a queued ${fx.runState.stage} run — cancel it in the app first` }
    : { ok: false, error: `${card.data.id} has a live run — cancel it in the app first` };
}

// Archived cards are hidden from the operational board. Letting any normal
// action run against one can queue or mutate invisible work, so restoration is
// the sole voice operation available until the card is visible again.
function archivedEligibility(card, action) {
  if (!card.data.archived || action === 'unarchive') return { ok: true };
  return action === 'archive'
    ? { ok: false, error: `${card.data.id} is already archived` }
    : { ok: false, error: `${card.data.id} is archived — restore it before using voice actions` };
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
    eligible: async (card, project, fx) => (card.data.epic
      ? (notEpicCascade(card, fx) || { ok: false, error: 'epic approvals are not available by voice' })
      : (notWhileLive(card, fx) || approvalEligibility(project, card))),
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
    label: (card, fx) => {
      const run = fx.cancellableRunState;
      if (run?.state === 'queued') return `take ${card.data.id} out of the ${run.stage.toLowerCase()} queue`;
      if (run?.stage === 'Build') return `cancel the running build for ${card.data.id}`;
      if (run?.stage === 'in progress') return `cancel the active run for ${card.data.id}`;
      return `cancel the running ${run?.stage || 'agent'} run for ${card.data.id}`;
    },
    // Only cancellableRunState (local runs ∪ pending ∪ queues) is actionable by
    // pipeline.cancel. Dispatcher-owned budget work is reported but refused.
    eligible: (card, project, fx) => (fx.cancellableRunState
      ? { ok: true }
      : fx.runState?.external
        ? { ok: false, error: 'external dispatcher run — cancel it in the dispatcher first' }
        : { ok: false, error: 'no live run to cancel' }),
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
// board and effective run state — no process-global data (banners span every
// open project, not just this one) and no wall-clock timestamp, so the same
// board state always produces byte-identical output.
export function buildVoiceSummary(project) {
  const board = loadBoard(project.path);
  const runStates = effectiveRunStates(project, board);
  // A board may define any custom column name, including Object prototype
  // names. Count in a Map, then materialize own data properties so statuses
  // such as `constructor` and `__proto__` cannot read or mutate the prototype.
  const countEntries = new Map();
  for (const col of board.config.columns) countEntries.set(safeText(col), 0);
  for (const c of board.cards) {
    const status = safeText(c.status);
    countEntries.set(status, (countEntries.get(status) ?? 0) + 1);
  }
  const counts = Object.fromEntries(countEntries);

  const activeRuns = Object.entries(runStates)
    .map(([card, s]) => ({ card, state: s.state, stage: boundedText(s.stage), external: !!s.external }))
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
    ? `${activeRuns.length} active: ${describeList(activeRuns, (r) => `${r.card} ${r.state === 'queued' ? 'queued for' : 'running'} ${r.stage}${r.external ? ' through the dispatcher' : ''}`)}.`
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
  const run = effectiveRunStates(project, board)[cardId];
  const recovery = await recoveryActions(project, cardId);

  const bits = [`${cardId}: ${boundedText(card.title || '(untitled)')} — ${boundedText(card.status)}`];
  if (card.archived) bits.push('archived');
  if (run) bits.push(run.state === 'queued'
    ? `queued for ${boundedText(run.stage)}`
    : `running ${boundedText(run.stage)}${run.external ? ' through the dispatcher' : ''}`);
  if (card.status === 'Needs Human' && card.needs_human_reason) bits.push(`reason: ${boundedText(card.needs_human_reason)}`);
  if (card.criteria) bits.push(`${card.criteria.done} of ${card.criteria.total} acceptance criteria met`);
  const available = ['resume_build', 'restart_build', 'retry_verification']
    .filter((k) => recovery[k]).map((k) => k.replace(/_/g, ' '));
  if (available.length) bits.push(`available: ${available.join(', ')}`);

  return {
    text: boundedText(bits.join(' — '), MAX_SUMMARY_TEXT_CHARS),
    id: cardId,
    status: boundedText(card.status),
    archived: !!card.archived,
  };
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
  if (!requestObject(fields)) return { status: 400, ok: false, error: 'request body must be a JSON object' };
  if (typeof fields.cardId !== 'string' || typeof fields.action !== 'string') {
    return { status: 400, ok: false, error: 'cardId and action must be strings' };
  }
  const requestedCardId = fields.cardId;
  const action = fields.action;
  const normalizedArguments = argumentless(fields);
  if (!normalizedArguments.ok) return { status: 400, ok: false, error: normalizedArguments.error };
  if (!CARD_ID.test(requestedCardId)) return { status: 400, ok: false, error: 'invalid card id' };
  const def = Object.hasOwn(ALLOWED_ACTIONS, action) ? ALLOWED_ACTIONS[action] : null;
  if (!def) return { status: 400, ok: false, error: `unknown or disallowed voice action: ${action}` };
  const card = readCard(project.path, requestedCardId);
  if (!card) return { status: 404, ok: false, error: `card not found: ${requestedCardId}` };
  // readCard accepts a filename prefix for existing UI routes. Voice proposals
  // must collapse every such alias onto the physical card's frontmatter id, or
  // two aliases can reserve and execute against the same card concurrently.
  if (typeof card.data.id !== 'string') return { status: 400, ok: false, error: 'card has an invalid canonical id' };
  const cardId = card.data.id;
  if (!CARD_ID.test(cardId)) return { status: 400, ok: false, error: 'card has an invalid canonical id' };
  const archived = archivedEligibility(card, action);
  if (!archived.ok) return { status: 400, ok: false, error: archived.error };
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

  // Project removal invalidates outstanding proposals. It can run while an
  // asynchronous eligibility check above is in flight, so do not return a
  // successful id that was already removed (or expired) during preparation.
  const current = getProposal(proposalId);
  if (!current.ok || current.proposal !== proposal) {
    return current.reason === 'expired'
      ? { status: 410, ok: false, error: 'proposal expired while preparing' }
      : { status: 409, ok: false, error: 'proposal invalidated while preparing' };
  }

  // fingerprinted from the SAME snapshot the tier and read-back were derived
  // from: anything that moved during the eligibility await makes this stale at
  // confirm time rather than silently re-classifying the action
  proposal.expectedFingerprint = fingerprint(card, effects);
  proposal.challenge = tier === 'agent' ? buildChallenge(action, cardId, proposalId) : null;

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
  if (!requestObject(body)) return { status: 400, ok: false, error: 'request body must be a JSON object' };
  const found = getProposal(proposalId);
  if (!found.ok) {
    return found.reason === 'expired'
      ? { status: 410, ok: false, error: 'proposal expired' }
      : { status: 404, ok: false, error: 'no such pending proposal' };
  }
  const p = found.proposal;
  if (p.projectPath !== project.path) return { status: 404, ok: false, error: 'no such pending proposal' };
  if ((Object.hasOwn(body, 'cardId') && body.cardId !== p.cardId)
    || (Object.hasOwn(body, 'action') && body.action !== p.action)) {
    return { status: 409, ok: false, error: 'ambiguous: does not match the pending proposal' };
  }
  const normalizedArguments = argumentless(body);
  if (!normalizedArguments.ok) return { status: 409, ok: false, error: 'ambiguous: arguments do not match the pending proposal' };
  const phrase = checkPhrase(p, body);
  if (!phrase.ok) return { status: 400, ok: false, error: phrase.error };

  // Revalidation + eligibility + consumption + mutation are one repository
  // transaction. Every board writer uses this same cross-process lock, and its
  // reentrant in-process layer lets the guarded pipeline operation call its
  // normal board helpers without deadlocking.
  return withRepoLock(project.path, async () => {
    const current = getProposal(proposalId);
    if (!current.ok) {
      return current.reason === 'expired'
        ? { status: 410, ok: false, error: 'proposal expired' }
        : { status: 404, ok: false, error: 'no such pending proposal' };
    }
    if (current.proposal !== p) return { status: 409, ok: false, error: 'proposal already used' };

    const card = readCard(project.path, p.cardId);
    const effects = card ? computeEffects(project, card) : null;
    if (!card || fingerprint(card, effects) !== p.expectedFingerprint) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${p.cardId} changed since this action was prepared` };
    }

    const def = ALLOWED_ACTIONS[p.action];
    const archived = archivedEligibility(card, p.action);
    if (!archived.ok) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${archived.error}` };
    }
    const eligible = await def.eligible(card, project, effects);
    if (!eligible.ok) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${eligible.error}` };
    }

    // Consume only after the locked live checks pass. A concurrent or replayed
    // confirm then loses on getProposal above and can never execute twice.
    if (!proposals.delete(proposalId)) return { status: 409, ok: false, error: 'proposal already used' };
    const result = await def.execute(project, p.cardId, card);
    // status last: it must win over anything (unexpectedly) named `status` in a
    // guarded function's own result — the HTTP status code is never negotiable.
    return { ...result, proposalId, action: p.action, cardId: p.cardId, status: result.ok ? 200 : 400 };
  });
}

export async function rejectVoiceAction(project, proposalId, body = {}) {
  if (!requestObject(body)) return { status: 400, ok: false, error: 'request body must be a JSON object' };
  const found = getProposal(proposalId);
  if (!found.ok) {
    return found.reason === 'expired'
      ? { status: 410, ok: false, error: 'proposal expired' }
      : { status: 404, ok: false, error: 'no such pending proposal' };
  }
  const p = found.proposal;
  if (p.projectPath !== project.path) return { status: 404, ok: false, error: 'no such pending proposal' };
  if ((Object.hasOwn(body, 'cardId') && body.cardId !== p.cardId)
    || (Object.hasOwn(body, 'action') && body.action !== p.action)) {
    return { status: 409, ok: false, error: 'ambiguous: does not match the pending proposal' };
  }
  const normalizedArguments = argumentless(body);
  if (!normalizedArguments.ok) return { status: 409, ok: false, error: 'ambiguous: arguments do not match the pending proposal' };

  // Rejection consumes no board action, but it is still a result about this
  // exact proposal. Revalidate under the same transaction as confirmation so
  // stale/expired/now-ineligible proposals are rejected rather than reported
  // as a successful human rejection of an action that no longer exists.
  return withRepoLock(project.path, async () => {
    const current = getProposal(proposalId);
    if (!current.ok) {
      return current.reason === 'expired'
        ? { status: 410, ok: false, error: 'proposal expired' }
        : { status: 404, ok: false, error: 'no such pending proposal' };
    }
    if (current.proposal !== p) return { status: 409, ok: false, error: 'proposal already used' };

    const card = readCard(project.path, p.cardId);
    const effects = card ? computeEffects(project, card) : null;
    if (!card || fingerprint(card, effects) !== p.expectedFingerprint) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${p.cardId} changed since this action was prepared` };
    }

    const def = ALLOWED_ACTIONS[p.action];
    const archived = archivedEligibility(card, p.action);
    if (!archived.ok) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${archived.error}` };
    }
    const eligible = await def.eligible(card, project, effects);
    if (!eligible.ok) {
      proposals.delete(proposalId);
      return { status: 409, ok: false, error: `stale: ${eligible.error}` };
    }

    if (!proposals.delete(proposalId)) return { status: 409, ok: false, error: 'proposal already used' };
    return { status: 200, ok: true, rejected: true, proposalId, action: p.action, cardId: p.cardId };
  });
}
