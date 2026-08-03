import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { loadConfig, normalizeConfig, loadBoard, readCard, moveCard, reorderCards, sortCardsByBoardOrder, patchFrontmatter, appendRunLog, commitCardChanges, withRepoLock, withoutRepoLockContext, parseChunks, setArchived, readLocalPrompt } from './board.js';
import { materializeChunks, advanceEpicChildren } from './chunks.js';
import { isGitRepo, addWorktree, archiveBranchForRestart, removeWorktree, mergeBranch, branchTouchesBoard, branchAddedForbidden, linkIntoWorktree, baseBranch, currentBranch, git } from './git.js';
import { runStage, stopHookSettings } from './runner.js';
import { claim as coordClaim, release as coordRelease, readAllClaims as coordClaims, planFiles as coordPlanFiles, workerName as coordWorker } from './coordination.js';
import { runs, runKey, persistRuns, readPriorRuns, addCost, monthCost } from './runstore.js';
import * as scheduler from './scheduler.js';

const VERDICT_SCHEMA = {
  // todomd.verdict/1
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'criteria', 'findings', 'setup_error', 'question'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'met'],
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' } },
      },
    },
    findings: { type: 'string' },
    // set ONLY when the verify command couldn't run at all (missing dep/file/env
    // var/service) — a worktree-environment problem, not a test-assertion failure
    setup_error: { type: ['string', 'null'] },
    // set ONLY when a genuine human decision is required to proceed (ambiguous
    // spec, a product choice) — not a code defect you can describe as a finding
    question: { type: ['string', 'null'] },
  },
};

const ESCALATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'repair_strategy'],
  properties: {
    diagnosis: { type: 'string' },
    repair_strategy: { type: 'string' },
  },
};

const IN_FLIGHT = new Set(['Plan', 'Build', 'Verify', 'Escalate']);
// statuses where a coordination claim is legitimately held (assigned-and-parked, or building)
const BUILD_FLOW = new Set(['Queue', 'Build', 'Verify']);
const ORCH_ONLY = new Set(['Planned', 'Build', 'Verify', 'Done', 'Needs Human']);

let broadcast = () => {};
const children = new Map();          // runKey → ChildProcess
// runKey → { project, card, child, cancelled, timedOut } for a live CI stage
// (the board's verify_command). Tracked separately from `children`, which is
// specifically the agent-CLI children runstore.js persists and reconcileOnBoot
// reaps by PID — a shell command has no session, envelope or transcript.
const ciRuns = new Map();
const finalizationWaiters = new WeakMap(); // retained trigger run → completion signal for direct human moves
// runKey → { cancelled, revertTo, cascadeArchive, noRequeue } — a build flow
// claimed at its first admission and held until it fully settles, spanning
// every scheduler admission in between (admit → spawn, build done → verify
// admission, verify fail → retry-build admission). Covers the windows where
// `children` has no entry so hasLiveRun/cancel/humanMove never see a false "idle".
const pending = new Map();
// Plan/custom-stage work claimed synchronously after the card move but before
// async config loading and child registration. Without this claim, voice can
// authorize a conflicting move in the background-handoff window.
const triggerClaims = new Map();      // runKey → exact pre-spawn stage claim
// Exact identity of the latest run/queue claim for a card. This advances in
// memory before work starts, so cancel-and-requeue cannot recreate an earlier
// identity even when Git is temporarily unable to commit the card transitions.
// Voice proposals use it only for stale detection; it grants no capability.
const runGenerations = new Map();     // runKey → { project, card, generation }
let nextRunGeneration = 0;
const banners = new Map();           // key → { level, text }
const quotaPaused = new Set();        // project names paused on a usage limit

// A manual queue pause is local operational state, not shared board metadata:
// committing it would unexpectedly pause teammates' machines too. Keep one
// marker per project under the already-gitignored .todomd/local directory so
// it survives this board process restarting without touching cards or Git.
function queuePauseFile(project) {
  return path.join(project.path, '.todomd', 'local', 'queue-paused');
}

export function isQueuePaused(project) {
  if (!project?.path) return false;
  try { return fs.statSync(queuePauseFile(project)).isFile(); }
  catch { return false; }
}

function persistQueuePause(project, paused) {
  const file = queuePauseFile(project);
  if (!paused) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The file's contents are informational; existence is the fail-safe state.
  // A direct tiny write is portable when replacing an existing marker too
  // (Windows rename-over-existing behavior differs from POSIX).
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}
const retryFindings = new Map();      // runKey → { project, card, findings }
const recoveryBuilds = new Map();     // runKey → guarded continuation state with exact project/card ownership

function saveRetryFindings(project, id, findings) {
  const key = runKey(project.name, id);
  if (findings) retryFindings.set(key, { project: project.name, card: id, findings });
  else retryFindings.delete(key);
}

function bumpRunGeneration(projectName, id) {
  const generation = ++nextRunGeneration;
  runGenerations.set(runKey(projectName, id), { project: projectName, card: id, generation });
  return generation;
}

export function getRunGeneration(projectName, id) {
  return runGenerations.get(runKey(projectName, id))?.generation || 0;
}

// On a usage limit the card is parked back in Queue with its attempt rolled
// back; resume (or boot) re-enqueues it through the normal queue, so accounting
// and dedup guards always apply. No continuations run outside the queue.
function pauseForQuota(project) {
  quotaPaused.add(project.name);
  setBanner('quota', 'warn', 'usage limit reached — paused; resume when your usage resets');
}

async function parkForQuota(project, id, attempt, maxAttempts, findings) {
  const card = readCard(project.path, id);
  const lastVerdict = card?.data?.verification?.last_verdict || '';
  await patchFrontmatter(project.path, id, {
    verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: lastVerdict },
  });
  saveRetryFindings(project, id, findings);
  await orchMove(project, id, 'Queue', 'usage limit; will resume');
  pauseForQuota(project);
  sendState(project, id, 'idle');
}

// Re-enqueue every Queue card that has no live run (used by resume and boot).
// enqueueBuild dedupes, so this is safe to call repeatedly.
function enqueueQueue(project) {
  try {
    for (const card of sortCardsByBoardOrder(loadBoard(project.path).cards.filter((c) => c.status === 'Queue'))) {
      // epics sit in Queue as trackers — they never build (their chunks do)
      if (card.id && !card.epic &&
          !children.has(runKey(project.name, card.id)) && !pending.has(runKey(project.name, card.id))) {
        enqueueBuild(project, card.id);
      }
    }
  } catch { /* never fatal */ }
}

export function init(opts) {
  broadcast = opts.broadcast;
  preflight();
}

/* ── helpers ── */

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';

function setBanner(key, level, text) {
  if (text === null) banners.delete(key);
  else banners.set(key, { level, text });
  broadcast({ type: 'banners', banners: [...banners.values()] });
}

export function getBanners() {
  return [...banners.values()];
}

// 'idle' is the single choke point where a card's build-flow claim (`pending`)
// is released: every terminal exit (Done, Needs Human, cancelled, quota-park)
// already calls sendState(..., 'idle') exactly once, and no in-flow
// continuation (a retry, the Build→Verify handoff) ever does — so clearing
// `pending` here, instead of at each of those call sites individually, can't
// miss one and can't fire early.
function sendState(project, cardId, state, stage, reason, pendingOwner) {
  if (state === 'idle') {
    const key = runKey(project.name, cardId);
    const current = pending.get(key);
    // Abnormal promise catches can settle after a replacement run has already
    // claimed the same card. When a caller supplies the claim it owns, never
    // clear or overwrite a newer claim's live UI state.
    if (pendingOwner !== undefined && current && current !== pendingOwner) return;
    if (pendingOwner === undefined || current === pendingOwner) pending.delete(key);
  }
  broadcast({ type: 'run-state', project: project.name, card: cardId, state, stage, ...(reason ? { reason } : {}) });
}

async function orchMove(project, id, to, reason) {
  return moveCard(project.path, id, to, { reason });
}

const SUPPORTED_VENDORS = new Set(['claude', 'codex']);

// Override precedence is normally card → column → board. Verify is the one
// deliberate exception: an explicitly routed Verify column owns its provider
// so a card's Build agent cannot silently replace independent quality control.
function cardVendor(config, card, stageName) {
  const stageAgent = stageName && (config.stages || {})[stageName]?.agent;
  if (stageName === 'Verify' && stageAgent) return stageAgent;
  return card?.data?.agent || stageAgent || config.default_agent || 'claude';
}

// The complete state-independent approval gate shared by the board UI and
// voice prepare/confirm. Live-run handling stays immediately above the Queue
// branch in humanMove (voice applies the same guard from its fresh effects).
// Keeping the remaining checks here prevents a voice read-back from promising
// an approval that humanMove already knows it will refuse.
export async function approvalEligibility(project, card, config = loadConfig(project.path)) {
  if (!card) return { ok: false, error: 'card not found' };
  const id = card.data.id;
  if (card.data.status !== 'Planned') {
    return { ok: false, error: 'cards are assigned from Planned (approve a plan first)' };
  }
  if (!(await isGitRepo(project.path))) return { ok: false, error: 'pipeline needs a git repo' };
  const agent = cardVendor(config, card, 'Build');
  if (!SUPPORTED_VENDORS.has(agent)) {
    return { ok: false, error: `agent "${agent}" not supported (have: ${[...SUPPORTED_VENDORS].join(', ')})` };
  }
  // Epic approval follows its separate child-cascade path and does not build
  // the epic's own plan or apply the ordinary card dependency gate.
  if (card.data.epic) return { ok: true };
  if (parseChunks(card.body).length >= 2) {
    return { ok: false, error: `${id}'s plan was split into chunks that were never materialized (the plan was split into chunks but no chunk cards were created). Re-plan it as a single task, or run \`todomd fanout ${id}\` first.` };
  }
  // Include archived cards so a completed-then-archived dependency still counts.
  // loadBoard normalizes a hand-edited scalar `dependencies: task-0002` to the
  // same one-item list as YAML array syntax. Using the raw readCard value here
  // used to silently drop that dependency and approve blocked work.
  const board = loadBoard(project.path, { includeArchived: true });
  const deps = board.cards.find((c) => c.id === id)?.dependencies || [];
  const blocked = deps.filter((d) => board.cards.find((c) => c.id === d)?.status !== 'Done');
  return blocked.length
    ? { ok: false, error: `blocked by: ${blocked.join(', ')}` }
    : { ok: true };
}

function stageConfig(config, stageName, card) {
  const stage = (config.stages || {})[stageName] || {};
  const independentVerify = stageName === 'Verify' && !!stage.agent;
  const workflow = card?.data?.workflow || stage.workflow || '';
  let effort = independentVerify
    ? (stage.effort || config.default_effort)
    : (card?.data?.effort || stage.effort || config.default_effort);
  // Ultra Code is the board's high-rigor Build contract, not merely an extra
  // sentence in the prompt. A stale per-card Low/Medium/High override must not
  // silently weaken that contract. Preserve Max, otherwise enforce XHigh as
  // the minimum while leaving ordinary stage/card precedence unchanged.
  const effortRank = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  if (stageName === 'Build' && workflow === 'ultra_code' &&
      (effortRank[effort] ?? -1) < effortRank.xhigh) effort = 'xhigh';
  return {
    command: stage.command || `todomd-${stageName.toLowerCase()}`,
    // A model selected for the card's Build provider may be invalid for the
    // independent verifier. Prefer Verify's own routing (or provider default).
    model: independentVerify ? (stage.model || undefined) : (card?.data?.model || stage.model || config.default_model),
    effort,
    workflow,
    // Zero deliberately means "let the provider choose its per-session cap".
    // Build continuations below still turn a provider cap into a checkpoint.
    maxTurns: stage.max_turns ?? 30,
    allowedTools: stage.allowed_tools || [],
  };
}

// A provider's max-turn result is a checkpoint, not automatically a human
// blocker. Build continues in the same worktree/session while it is changing
// the candidate. A run that repeatedly makes no git-visible progress is the
// useful signal that a human or the escalation path is needed.
function buildContinuationConfig(config) {
  const c = config.build_continuation || {};
  const n = Number(c.max_no_progress_slices);
  return {
    enabled: c.enabled !== false,
    maxNoProgressSlices: Number.isInteger(n) && n > 0 ? n : 2,
  };
}

async function progressSnapshot(worktreeAbs) {
  const head = await git(worktreeAbs, ['rev-parse', 'HEAD']);
  const changed = await git(worktreeAbs, ['status', '--porcelain']);
  return {
    head: head.ok ? head.stdout : '',
    changed: changed.ok ? changed.stdout : '',
  };
}

function hasProgress(before, after) {
  return before.head !== after.head || before.changed !== after.changed;
}

function escalationConfig(config) {
  const e = config.escalation || {};
  if (e.enabled !== true) return null;
  const after = Number(e.after_failed_reviews);
  return {
    afterFailedReviews: Number.isInteger(after) && after > 0 ? after : 2,
    diagnosis: {
      agent: e.diagnosis?.agent === 'codex' ? 'codex' : 'claude',
      model: e.diagnosis?.model || 'claude-fable-5',
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.diagnosis?.effort) ? e.diagnosis.effort : 'xhigh',
    },
    repair: {
      agent: e.repair?.agent === 'codex' ? 'codex' : 'claude',
      model: e.repair?.model || 'claude-opus-5',
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.repair?.effort) ? e.repair.effort : 'xhigh',
    },
  };
}

function ultraCodeInstructions() {
  return '\n\nUltra Code workflow: before reporting ready, inspect the surrounding implementation, complete every acceptance criterion, run the relevant tests, review your own diff for regressions, and commit the finished repair. The Stop hook remains mandatory.';
}

// Config for EXECUTION (stage tools/models, the verify_command Stop hook) is
// read from the COMMITTED config at HEAD, not the working tree. Otherwise a
// `git pull` or a mid-run agent edit to .todomd/config.yml would arm a new
// verify_command (a shell hook) or widen a stage's tool allowlist for a run
// that was resolved under the old rules. Board display paths keep reading the
// working tree. Falls back to the working-tree file when it isn't committed
// yet (fresh `todomd init` before the first commit).
// Keys that can make something RUN, or widen what a run is allowed to do:
// verify_command is a shell hook; stages carries each column's command, model
// and allowed_tools; default_agent picks the CLI (and codex ignores the tool
// allowlist entirely); worktree_link decides which gitignored paths get linked
// into the worktree an agent reads. These are taken from the COMMITTED config
// ALONE — including when it omits them, in which case the caller's own default
// applies and NOT the working-tree value. Add any new key here that can execute
// something or loosen a guard.
const EXEC_KEYS = ['verify_command', 'stages', 'default_agent', 'worktree_link', 'escalation', 'build_continuation'];

async function execConfig(repoPath) {
  const workingTree = loadConfig(repoPath);
  const res = await git(repoPath, ['show', 'HEAD:.todomd/config.yml']);
  // no committed config at all (fresh `init` before the first commit) — the
  // working tree is all there is
  if (!res.ok || !res.stdout) return workingTree;
  let committed;
  try {
    committed = normalizeConfig(yaml.load(res.stdout) || {});
  } catch {
    return workingTree; // an unparseable committed config must not crash a run
  }
  // Operational keys (mode, concurrency, max_attempts, columns …) still let an
  // uncommitted edit through, so the board behaves as it displays — and so an
  // uncommitted `mode: budget` is honored rather than auto-spending credits.
  // A plain spread can't express the rule for EXEC_KEYS: it would let any of
  // them that the committed config OMITS be supplied by the working tree, which
  // is how a poisoned edit ADDING a verify_command armed the next build's Stop
  // hook with arbitrary shell.
  const out = { ...workingTree, ...committed };
  for (const key of EXEC_KEYS) {
    delete out[key];
    if (key in committed) out[key] = committed[key];
  }
  return out;
}

// claude invokes the repo's command file as a slash command; codex doesn't
// read .claude/commands, so the command body is inlined with the id filled in.
function commandBody(project, command, id) {
  const file = path.join(project.path, '.claude', 'commands', `${command}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  return raw.replace(/^---[\s\S]*?---\s*/, '').replaceAll('$ARGUMENTS', id);
}

function stagePrompt(project, vendor, stage, id) {
  // .todomd/local/<command>.md is the private half of a prompt: gitignored, so
  // it can hold what the committed file must not (client names, internal URLs).
  const local = readLocalPrompt(project.path, stage.command);
  if (!local) {
    // unchanged path: claude resolves the slash command itself, codex can't
    return vendor === 'codex' ? commandBody(project, stage.command, id) : `/${stage.command} ${id}`;
  }
  // With a local layer we inline the body for BOTH vendors rather than appending
  // after `/command id` — text trailing a slash command is the CLI's to
  // interpret, and a silently-dropped addendum is worse than none. Inlining is
  // exactly what codex has always received, so the content is identical either
  // way; only the delivery changes.
  return `${commandBody(project, stage.command, id)}\n\n` +
    `## Project conventions (local, not committed)\n\n` +
    `Treat the following as additional instructions for this repo:\n\n${local}\n`;
}

// Per-card skill override: a card with `skill:` frontmatter dragged into a
// trigger column invokes that skill (any repo command, user skill, or plugin
// skill) with the card as context, instead of the column's default command.
function skillPrompt(project, vendor, skill, id, card) {
  const safe = String(skill).replace(/[^\w:-]/g, '');
  const ctx = `\n\nThis run is for todomd card ${id} ("${card.data.title || ''}") in this repository.` +
    ` If the work produces findings or output worth keeping, append them under a "## Findings"` +
    ` section of the card file .todomd/tasks/${card.file} (create the section if needed).` +
    ` Never modify the YAML frontmatter or the "## Run Log" section.`;
  if (vendor !== 'codex') return `/${safe} ${id}${ctx}`;
  const file = path.join(project.path, '.claude', 'commands', `${safe}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`skill "${safe}" has no .claude/commands file — codex cards can only run repo commands`);
  }
  const body = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  return body.replaceAll('$ARGUMENTS', id) + ctx;
}

function classifyFailure({ envelope, exitCode, spawnError, stderr }, cwd) {
  if (spawnError === 'ENOENT') {
    // spawn ENOENT is ambiguous: the CLI binary is missing, OR the cwd (the
    // worktree) was deleted out from under the run — the runner only forwards
    // err.code, so disambiguate here. Only a missing binary means the CLI is
    // gone; a vanished worktree is an environment failure, not a banner.
    if (cwd && !fs.existsSync(cwd)) return { kind: 'worktree_failed', detail: `worktree is gone: ${cwd}` };
    return { kind: 'cli_missing', detail: 'claude CLI not found on PATH' };
  }
  const text = `${envelope?.result || ''} ${envelope?.subtype || ''} ${stderr || ''}`;
  if (/hook.*cancelled|cancelled.*hook/i.test(text)) {
    return { kind: 'hook_cancelled', detail: 'the provider cancelled a lifecycle hook before it returned a verdict' };
  }
  if (/rate.?limit|quota|credit|usage limit|exhausted|exceeded/i.test(text)) {
    return { kind: 'quota', detail: 'usage limit reached' };
  }
  if (/logged.?in|log in|authentication|unauthorized|invalid api key/i.test(text)) {
    return { kind: 'auth', detail: 'claude CLI is not authenticated' };
  }
  if (envelope?.subtype === 'error_max_turns') return { kind: 'agent', detail: 'max turns reached' };
  return { kind: 'agent', detail: envelope?.subtype || `exit ${exitCode}` };
}

function diagnosticSnippet(value, max = 220) {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Card history gets a concise, explicitly infrastructural explanation. The
// complete bounded fields remain in runner-diagnostic inside the private jsonl.
function codexVerifierDiagnostic(result) {
  const d = result?.diagnostic || {};
  const executable = d.executable || 'codex';
  const cwd = d.cwd || '(unknown working directory)';
  const exit = d.spawnError
    ? `could not start (${d.spawnError})`
    : d.signal
      ? `ended by ${d.signal}${d.exitCode == null ? '' : `, exit ${d.exitCode}`}`
      : `exited ${d.exitCode ?? result?.exitCode ?? 'unknown'}`;
  const stderr = diagnosticSnippet(d.stderr || result?.stderr);
  const output = d.structuredOutput !== undefined && d.structuredOutput !== null
    ? `structured output: ${diagnosticSnippet(d.structuredOutput)}`
    : d.finalMessage
      ? `final message: ${diagnosticSnippet(d.finalMessage)}`
      : 'no final message or structured output';
  return `Codex verification infrastructure: ${executable} in ${cwd} ${exit}; ` +
    `${stderr ? `stderr: ${stderr}; ` : 'stderr: (empty); '}${output}; no valid verdict`;
}

async function recordRun(project, id, stage, attempt, result, note) {
  const cost = result?.envelope?.total_cost_usd || 0;
  const turns = result?.envelope?.num_turns ?? '?';
  addCost(cost);
  const card = readCard(project.path, id);
  const prevCost = Number(card?.data?.cost_usd) || 0;
  const patch = { cost_usd: Math.round((prevCost + cost) * 10000) / 10000 };
  if (result?.sessionId) patch.session_id = result.sessionId;
  await patchFrontmatter(project.path, id, patch);
  await appendRunLog(
    project.path, id,
    `- ${now()} · ${stage}${attempt ? ` attempt ${attempt}` : ''} · ${turns} turns · $${cost.toFixed(3)} · ${note}`
  );
}

async function toNeedsHuman(project, id, from, reason, detail = '', pendingOwner) {
  retryFindings.delete(runKey(project.name, id)); // a card leaving the flow keeps no stale findings
  await releaseCoordination(project, id);
  await patchFrontmatter(project.path, id, {
    needs_human_reason: reason,
    recovery_stage: reason === 'orphaned_run' ? from : '',
  });
  if (detail) {
    const text = String(detail);
    // Preserve both the failure context and the newest diagnostic output. CI
    // and test runners commonly print their actionable summary last.
    const concise = text.length <= 400 ? text
      : `${text.slice(0, 120).trimEnd()}\n…\n${text.slice(-275).trimStart()}`;
    await appendRunLog(project.path, id, `  - ${reason}: ${concise}`);
  }
  await orchMove(project, id, 'Needs Human', reason);
  sendState(project, id, 'idle', undefined, undefined, pendingOwner);
}

async function releaseCoordination(project, id) {
  const coord = loadConfig(project.path).coordination || {};
  if (coord.enabled) { try { await coordRelease(project.path, id, { sync: coord.sync }); } catch {} }
}

// Free a card's build resources (queue slot, retry findings, coordination claim,
// worktree) so it can be archived or deleted without leaking anything. The
// caller must ensure there's no LIVE run first (cancel it).
export async function releaseCardResources(project, id) {
  scheduler.dequeue(project.name, id);
  retryFindings.delete(runKey(project.name, id));
  recoveryBuilds.delete(runKey(project.name, id));
  await releaseCoordination(project, id);
  const card = readCard(project.path, id);
  if (card?.data?.worktree) {
    const wtDir = loadConfig(project.path).worktree_dir || '.todomd/worktrees';
    await withRepoLock(project.path, () => removeWorktree(project.path, path.join(project.path, wtDir, id), card.data.worktree));
  }
}

export async function cascadeEpicCleanup(project, epicId) {
  const board = loadBoard(project.path); // active (non-archived) children only
  const remaining = board.cards.filter((c) => c.parent === epicId && c.status !== 'Done' && !c.epic);
  for (const child of remaining) {
    const childKey = runKey(project.name, child.id);
    const childLive = children.get(childKey);
    const childPend = pending.get(childKey);
    if (childLive) {
      const run = runs.get(childKey);
      run.cancelled = true;
      run.revertTo = 'Review';
      run.cascadeArchive = true;
      killWithEscalation(childLive);
      // cancel handler will setArchived after cleanup (cascadeArchive flag), skipping orchMove
    } else if (childPend) {
      // claimed but between spawns — the chain's cancel checkpoint archives it
      childPend.cancelled = true;
      childPend.cascadeArchive = true;
    } else {
      await releaseCardResources(project, child.id);
      await setArchived(project.path, child.id, true);
    }
  }
  if (remaining.length) {
    await appendRunLog(project.path, epicId,
      `- ${now()} · cascade-archive: archived ${remaining.length} pending child(ren)`);
  }
}

// The human answered the card's pending question (needs_answer). Thread the Q&A
// into the next build (via the retry-findings channel the build prompt already
// injects) and re-drive the card back into the build queue. No live run expected.
export async function answerCard(project, id, answer) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: `card not found: ${id}` };
  const text = String(answer || '').trim();
  if (!text) return { ok: false, error: 'answer is required' };
  const question = card.data.question || '';
  saveRetryFindings(project, id,
    `A human answered your earlier question — use this decision to proceed.\nQuestion: ${question}\nAnswer: ${text}`);
  await patchFrontmatter(project.path, id, { question: '', needs_human_reason: '' });
  await appendRunLog(project.path, id, `- ${now()} · human answered: ${text.slice(0, 200)}`);
  await orchMove(project, id, 'Queue', 'answered; resuming');
  enqueueBuild(project, id);
  return { ok: true };
}

function runLogFile(project, id, stage, attempt) {
  const dir = path.join(project.path, '.todomd', 'runs', id);
  const stem = `${stage.toLowerCase()}-${attempt || Date.now()}`;
  const first = path.join(dir, `${stem}.jsonl`);
  // Direct Verify retries and the one-time malformed-verdict rerun reuse the
  // same attempt number. Never truncate the earlier attempt's raw diagnostic.
  return fs.existsSync(first) ? path.join(dir, `${stem}-${Date.now()}.jsonl`) : first;
}

// Wall-clock cap for one stage child, in minutes. 0 disables the cap; a
// missing/non-numeric/negative value falls back to the 45m default; the value
// is clamped under the setTimeout 32-bit ceiling (~24.8 days in minutes) so a
// huge config value doesn't overflow into a ~1ms timer that would instantly
// kill every run. Shared by the agent stages and the CI command.
function stageTimeoutMinutes(project) {
  const cfgTimeout = loadConfig(project.path).stage_timeout_min;
  const n = cfgTimeout == null ? NaN : Number(cfgTimeout);
  return n === 0 ? 0 : !Number.isFinite(n) || n < 0 ? 45 : Math.min(n, 35791);
}

function spawnTracked(project, id, stage, prevStatus, attempt, opts) {
  const key = runKey(project.name, id);
  if (children.has(key)) {
    // never overwrite a live run's tracking entry — that would orphan it
    return Promise.resolve({
      result: { envelope: null, exitCode: -1, stderr: 'already running' },
      run: null,
      finishTracking: () => {},
    });
  }
  bumpRunGeneration(project.name, id);
  let run;
  let observedSession = null;
  const saveSession = (sessionId) => {
    if (!sessionId || sessionId === observedSession) return;
    observedSession = sessionId;
    if (run) {
      run.sessionId = sessionId;
      persistRuns();
    }
    // A Build process can be killed by a service restart before recordRun sees
    // its final envelope. Save its provider session as soon as init arrives so
    // Resume Build can continue that exact run in the preserved worktree.
    if (stage === 'Build') patchFrontmatter(project.path, id, { session_id: sessionId }).catch(() => {});
  };
  const { retainUntilFinalized = false, triggerClaim = null, ...stageOpts } = opts;
  const { child, done } = runStage({
    ...stageOpts,
    onEvent: (event) => {
      saveSession(event.session_id || event.thread_id || event?.thread?.id);
      if (event.type === 'assistant' || event.type === 'rate_limit_event' ||
          (event.type === 'system' && event.subtype === 'init')) {
        broadcast({ type: 'run-event', project: project.name, card: id, event });
      }
    },
  });
  run = {
    project: project.name, card: id, stage, pid: child.pid,
    startedAt: new Date().toISOString(), prevStatus, attempt,
    ...(observedSession ? { sessionId: observedSession } : {}),
  };
  if (triggerClaim) {
    run.cancelled = !!triggerClaim.cancelled;
    run.revertTo = triggerClaim.revertTo || prevStatus;
    run.noRequeue = !!triggerClaim.noRequeue;
    if (triggerClaims.get(key) === triggerClaim) triggerClaims.delete(key);
  }
  let resolveFinalized;
  const finalized = new Promise((resolve) => { resolveFinalized = resolve; });
  finalizationWaiters.set(run, { finalized, resolve: resolveFinalized });
  runs.set(key, run);
  children.set(key, child);
  persistRuns();
  sendState(project, id, 'running', stage);
  // wall-clock cap: a hung agent must not hold a concurrency slot forever. On
  // expiry the child is killed (TERM → KILL backstop) and the stage's caller
  // routes the card to Needs Human (run.timedOut).
  const timeoutMin = stageTimeoutMinutes(project);
  run.timeoutMin = timeoutMin;
  let stageTimer;
  if (timeoutMin > 0) {
    stageTimer = setTimeout(() => {
      run.timedOut = true;
      killWithEscalation(child);
    }, timeoutMin * 60_000);
    stageTimer.unref?.();
  }
  return done.then((result) => {
    clearTimeout(stageTimer);
    const run = runs.get(key);
    children.delete(key);
    const finishTracking = () => {
      // Do not delete a newer run if a late finalizer somehow overlaps it.
      if (runs.get(key) === run) runs.delete(key);
      finalizationWaiters.get(run)?.resolve();
      finalizationWaiters.delete(run);
      persistRuns();
    };
    if (!retainUntilFinalized) finishTracking();
    else persistRuns();
    return { result, run, finishTracking };
  });
}

/* ── human transitions (the §3.1 table) ── */

export async function humanMove(project, id, to) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: `card not found: ${id}` };
  const from = card.data.status;
  const config = loadConfig(project.path);
  const key = runKey(project.name, id);
  const live = children.get(key);
  const pend = pending.get(key);
  const tracked = runs.get(key);
  const triageClaim = triaging.get(key);
  const triggerClaim = triggerClaims.get(key);
  const queued = scheduler.isQueued(project.name, id);

  // Preserve the long-standing "approve as soon as Planned appears" behavior:
  // a direct human move waits for the last trigger-stage commit to settle, then
  // revalidates from the new state. Voice preparation remains non-blocking and
  // sees hasLiveRun=true throughout this window, so it cannot race finalization.
  if (tracked && !live && to !== 'Review') {
    const waiter = finalizationWaiters.get(tracked);
    if (waiter) {
      await waiter.finalized;
      return humanMove(project, id, to);
    }
  }
  if ((tracked || pend || triageClaim || triggerClaim || queued) && to !== 'Review') {
    return { ok: false, error: 'run in progress — drag to Review to cancel it first' };
  }

  // always allowed: retriage to Review (cancels a live run)
  if (to === 'Review') {
    if (tracked) {
      tracked.cancelled = true;
      tracked.revertTo = 'Review';
      if (live) killWithEscalation(live);
      return { ok: true, cancelled: true };
    }
    if (pend) {
      // A pending flow is normally between agent spawns, but the independently
      // tracked CI command can be live in this state. Flag the owner first,
      // then stop CI so its existing checkpoint performs the single revert.
      pend.cancelled = true;
      pend.revertTo = 'Review';
      const ci = ciRuns.get(key);
      if (ci) {
        ci.cancelled = true;
        killWithEscalation(ci.child);
      } else if (queued) {
        scheduler.dequeue(project.name, id);
        await unwindQueuedPending(project, id, pend);
      }
      return { ok: true, cancelled: true };
    }
    if (triageClaim) {
      triageClaim.cancelled = true;
      return { ok: true, cancelled: true };
    }
    if (triggerClaim) {
      triggerClaim.cancelled = true;
      triggerClaim.revertTo = 'Review';
      return { ok: true, cancelled: true };
    }
    // A first Build has no worktree/pending owner until admission. If it is
    // still queued (manual pause, capacity, or governor pressure), remove that
    // exact scheduler entry before moving the card so it cannot later wake up
    // and overwrite this human retriage.
    if (queued) {
      scheduler.dequeue(project.name, id);
      sendState(project, id, 'idle');
    }
    retryFindings.delete(key);
    recoveryBuilds.delete(key);
    await releaseCoordination(project, id); // a card pulled back out of the build flow drops its claim
    // discard any stale worktree (like the Planned retry path) so a re-driven
    // card starts fresh instead of building on abandoned commits
    if (card.data.worktree) {
      const wtDir = config.worktree_dir || '.todomd/worktrees';
      await withRepoLock(project.path, () => removeWorktree(project.path, path.join(project.path, wtDir, id), card.data.worktree));
    }
    await patchFrontmatter(project.path, id, { needs_human_reason: '', recovery_stage: '', worktree: '', base_branch: '' });
    const result = await moveCard(project.path, id, 'Review', { reason: 'retriage' });
    if (card.data.epic) await cascadeEpicCleanup(project, id);
    return result;
  }

  // approval gate: Planned → Queue
  if (to === 'Queue') {
    const eligible = await approvalEligibility(project, card, config);
    if (!eligible.ok) return eligible;
    if (card.data.epic) {
      // approving an epic starts the cascade — it never builds itself; it parks
      // in Queue as a tracker while its chunk children build in sequence
      const moved = await moveCard(project.path, id, 'Queue', { reason: 'epic approved — chunks building' });
      if (moved.ok && !moved.unchanged) {
        if ((config.mode || 'launcher') !== 'budget') {
          await advanceChildren(project, id);
        } else {
          // budget mode: move chunk-1 to Queue so the dispatcher picks it up;
          // enqueueBuild is not called — the /loop dispatcher drives builds
          await advanceEpicChildren(project.path, id);
        }
      }
      return moved;
    }
    const moved = await moveCard(project.path, id, 'Queue', { reason: 'approved' });
    // budget mode: the /todomd-dispatch session picks the card up from here.
    // `unchanged` guards a concurrent double-approval: only the transition that
    // actually moved Planned→Queue enqueues (enqueueBuild also dedupes).
    if (moved.ok && !moved.unchanged && (config.mode || 'launcher') !== 'budget') enqueueBuild(project, id);
    return moved;
  }

  // retry path: Needs Human → Planned (resets the attempt counter)
  if (to === 'Planned') {
    if (from !== 'Needs Human') return { ok: false, error: 'Planned is set by the orchestrator' };
    retryFindings.delete(key);
    recoveryBuilds.delete(key);
    const ver = card.data.verification || {};
    // discard the rejected worktree so the fresh attempt doesn't build on top of it
    if (card.data.worktree) {
      const wtDir = config.worktree_dir || '.todomd/worktrees';
      // serialize shared-index git ops (worktree add/remove/merge/prune) so two
      // cards finishing at concurrency>1 can't race the .git index
      await withRepoLock(project.path, () => removeWorktree(project.path, path.join(project.path, wtDir, id), card.data.worktree));
    }
    await patchFrontmatter(project.path, id, {
      needs_human_reason: '',
      recovery_stage: '',
      worktree: '',
      base_branch: '',
      verification: { attempts: 0, max_attempts: ver.max_attempts || config.max_attempts || 3, last_verdict: '' },
    });
    return moveCard(project.path, id, 'Planned', { reason: 'human retry' });
  }

  // stage-trigger columns: Plan, plus any custom column with a stages entry
  const isStageCol = (config.stages || {})[to] && !['Build', 'Verify'].includes(to);
  if (isStageCol) {
    if (to === 'Plan' && !['Review', 'Planned', 'Needs Human'].includes(from)) {
      return { ok: false, error: `Plan is entered from Review/Planned/Needs Human, not ${from}` };
    }
    if (IN_FLIGHT.has(from)) return { ok: false, error: `cannot leave ${from} while a stage may be active` };
    await patchFrontmatter(project.path, id, { needs_human_reason: '' });
    const moved = await moveCard(project.path, id, to, { reason: 'queued by human' });
    if (moved.ok && (config.mode || 'launcher') !== 'budget') {
      const claim = {
        project: project.name, card: id, stage: to,
        cancelled: false, revertTo: 'Review', noRequeue: false,
      };
      triggerClaims.set(key, claim);
      bumpRunGeneration(project.name, id);
      withoutRepoLockContext(() => runTriggerStage(project, id, to, claim).catch(() => {}));
    }
    return moved;
  }

  if (ORCH_ONLY.has(to)) return { ok: false, error: `${to} is set by the orchestrator` };

  // free human move between non-pipeline columns
  return moveCard(project.path, id, to);
}

// Reorder a card without changing its status. Queue order is mirrored into the
// live in-memory scheduler immediately; the persisted board_order values make
// the same priority survive a server restart. A column with active agent work
// is left alone because rebalancing writes every card file in that column.
export async function reorder(project, id, beforeId = null) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: `card not found: ${id}` };
  const status = card.data.status;
  const peers = loadBoard(project.path, { includeArchived: true }).cards
    .filter((c) => c.status === status && !!c.archived === !!card.data.archived);
  if (status !== 'Queue' && peers.some((c) => c.id && hasLiveRun(project.name, c.id))) {
    return { ok: false, error: 'cannot reorder a column while one of its cards is running' };
  }

  const result = await reorderCards(project.path, id, beforeId);
  if (!result.ok || result.status !== 'Queue') return result;

  scheduler.reorderQueue(project.name, 'Build', result.order);
  return result;
}

// A verifier that could not return a verdict may be retried without throwing
// away a completed build. This is deliberately narrower than Needs Human →
// Planned: that route starts a fresh worktree and build attempt.
async function preservedWorktree(project, card) {
  if (!card?.data?.worktree) return null;
  const config = await execConfig(project.path);
  const worktreeAbs = path.join(project.path, config.worktree_dir || '.todomd/worktrees', card.data.id);
  if (!fs.existsSync(worktreeAbs)) return null;
  if (!(await worktreeValid(worktreeAbs, card.data.worktree))) return null;
  return { config, worktreeAbs, branch: card.data.worktree };
}

function canRetryVerification(card) {
  const reason = card?.data?.needs_human_reason;
  return ['bad_verdict', 'hook_cancelled', 'attempts_exhausted'].includes(reason)
    || (reason === 'orphaned_run' && card?.data?.recovery_stage === 'Verify')
    // A real fail followed by an infrastructure error in the repair Build can
    // be fixed manually in the preserved worktree, then re-verified in place.
    || (['error', 'retry_failed'].includes(reason) && card?.data?.verification?.last_verdict === 'fail');
}

export async function recoveryActions(project, id) {
  const card = readCard(project.path, id);
  if (!card || card.data.status !== 'Needs Human' || hasLiveRun(project.name, id)) {
    return { resume_build: false, restart_build: false, retry_verification: false };
  }
  const kept = await preservedWorktree(project, card);
  // Older orphan records predate recovery_stage. orphaned_run was only emitted
  // for Build at that point, so keep those cards recoverable too.
  const orphanedBuild = card.data.needs_human_reason === 'orphaned_run'
    && (!card.data.recovery_stage || card.data.recovery_stage === 'Build');
  return {
    resume_build: !!kept && orphanedBuild,
    restart_build: !kept && orphanedBuild,
    retry_verification: !!kept && canRetryVerification(card),
  };
}

// Resume only a Build that reconcileOnBoot positively identified as orphaned.
// The preserved git worktree and its checked-out branch are validated twice
// (here and when the queued continuation starts); neither path can recreate it.
export async function resumeBuild(project, id) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: 'card not found' };
  if (card.data.status !== 'Needs Human' || card.data.needs_human_reason !== 'orphaned_run'
      || (card.data.recovery_stage && card.data.recovery_stage !== 'Build')) {
    return { ok: false, error: 'card is not an eligible orphaned Build run' };
  }
  const key = runKey(project.name, id);
  if (hasLiveRun(project.name, id) || scheduler.isQueued(project.name, id)) {
    return { ok: false, error: 'run already in progress' };
  }
  const kept = await preservedWorktree(project, card);
  if (!kept) return { ok: false, error: 'the preserved Build worktree is unavailable or no longer valid' };
  const verification = card.data.verification || {};
  const attempt = Math.max(1, Number(verification.attempts) || 1);
  const maxAttempts = Number(verification.max_attempts) || kept.config.max_attempts || 3;
  await patchFrontmatter(project.path, id, { needs_human_reason: '', recovery_stage: '' });
  await appendRunLog(project.path, id,
    `- ${now()} · Resume Build · continuing attempt ${attempt} in preserved worktree ${kept.branch}`);
  const moved = await orchMove(project, id, 'Build', 'resuming orphaned run in preserved worktree');
  if (!moved.ok) return moved;
  recoveryBuilds.set(key, {
    project: project.name,
    card: id,
    attempt,
    maxAttempts,
    branch: kept.branch,
    worktreeAbs: kept.worktreeAbs,
    sessionId: card.data.session_id || '',
  });
  enqueueBuild(project, id);
  return { ok: true, worktree: kept.branch, attempt };
}

// A legacy orphan may already have lost its worktree/branch. There is nothing
// left to resume, but the prior human approval still stands: clear only the
// stale recovery metadata and enqueue a fresh Build. If preservation is still
// available, refuse this path so the Resume Build action cannot be bypassed.
export async function restartBuild(project, id) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: 'card not found' };
  if (card.data.status !== 'Needs Human' || card.data.needs_human_reason !== 'orphaned_run'
      || (card.data.recovery_stage && card.data.recovery_stage !== 'Build')) {
    return { ok: false, error: 'card is not an eligible orphaned Build run' };
  }
  const key = runKey(project.name, id);
  if (hasLiveRun(project.name, id) || scheduler.isQueued(project.name, id)) {
    return { ok: false, error: 'run already in progress' };
  }
  if (await preservedWorktree(project, card)) {
    return { ok: false, error: 'preserved work is available — use Resume Build instead' };
  }
  const config = await execConfig(project.path);
  const verification = card.data.verification || {};
  const branch = card.data.worktree || `${config.branch_prefix || 'todomd/'}${id}`;
  const archived = await withRepoLock(project.path, () => archiveBranchForRestart(project.path, branch));
  if (!archived.ok) {
    return { ok: false, error: `could not preserve the existing task branch: ${archived.reason}` };
  }
  retryFindings.delete(key);
  recoveryBuilds.delete(key);
  await patchFrontmatter(project.path, id, {
    needs_human_reason: '',
    recovery_stage: '',
    session_id: '',
    worktree: '',
    base_branch: '',
    verification: { attempts: 0, max_attempts: verification.max_attempts || config.max_attempts || 3, last_verdict: '' },
  });
  await appendRunLog(project.path, id,
    `- ${now()} · Restart Build · preserved worktree unavailable; starting a fresh build` +
    (archived.archived ? ` (prior branch kept as ${archived.archived})` : ''));
  const moved = await orchMove(project, id, 'Queue', 'retrying orphaned build from scratch');
  if (!moved.ok) return moved;
  enqueueBuild(project, id);
  return { ok: true };
}

export async function retryVerification(project, id) {
  const card = readCard(project.path, id);
  if (!card) return { ok: false, error: 'card not found' };
  if (card.data.status !== 'Needs Human') return { ok: false, error: 'card is not waiting for verification retry' };
  if (!canRetryVerification(card)) {
    return { ok: false, error: 'only an unavailable verification verdict can be retried directly' };
  }
  const kept = await preservedWorktree(project, card);
  if (!kept) return { ok: false, error: 'the preserved worktree is unavailable or no longer valid' };
  const { config, worktreeAbs } = kept;
  if (hasLiveRun(project.name, id) || scheduler.isQueued(project.name, id)) {
    return { ok: false, error: 'run already in progress' };
  }
  const verification = card.data.verification || {};
  const attempt = Math.max(1, Number(verification.attempts) || 1);
  const maxAttempts = Number(verification.max_attempts) || config.max_attempts || 3;
  await patchFrontmatter(project.path, id, { needs_human_reason: '', recovery_stage: '' });
  const moved = await orchMove(project, id, 'Verify', 'retrying unavailable verifier');
  if (!moved.ok) return moved;
  const key = runKey(project.name, id);
  const claim = {
    project: project.name, card: id, stage: 'Verify',
    cancelled: false, revertTo: 'Queue', noRequeue: false,
    worktreeAbs, branch: card.data.worktree, attempt, maxAttempts,
    lastVerdict: verification.last_verdict || '',
  };
  // Unlike a one-shot custom trigger, Retry Verification can continue into a
  // repair Build. Use the same object as the persistent build-flow owner so
  // the card remains live across Verify -> queued Build.
  pending.set(key, claim);
  bumpRunGeneration(project.name, id);
  // A human-triggered retry is still a Verify: it asks the scheduler for a
  // Verify-column admission like every other start point, so the global,
  // column, per-project and governor gates all apply to it (a retry pressed
  // under resource pressure stays queued with a deferredReason instead of
  // spawning). The persistent claim above is set BEFORE scheduling and covers
  // both this queued window and any repair Build that follows. A cancel()
  // landing in that window flips claim.cancelled, which verify() unwinds at
  // admission. No explicit
  // withoutRepoLockContext here: scheduler.admitEntry() already wraps run().
  scheduler.schedule(project, id, 'Verify',
    () => verify(project, id, attempt, maxAttempts, card.data.session_id || '', worktreeAbs, card.data.worktree, false, '', claim),
    { onDefer: onDeferState(project, id, 'Verify') })
    .catch((err) => toNeedsHuman(project, id, 'Verify', 'retry_failed', String(err?.message || err), claim));
  return { ok: true };
}

// SIGTERM a child with a SIGKILL backstop: a child that ignores TERM would
// otherwise hold its concurrency slot (and keep billing) forever. The kill
// timer is cleared when the child's close fires. (TODOMD_KILL_GRACE_MS is a
// test steering knob, like TODOMD_CLAUDE_BIN.)
function killWithEscalation(child, { graceMs = Number(process.env.TODOMD_KILL_GRACE_MS) || 10000 } = {}) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, graceMs);
  killTimer.unref?.();
  child.once('close', () => clearTimeout(killTimer));
}

export function cancel(project, id) {
  const key = runKey(project.name, id);
  const live = children.get(key);
  if (!live) {
    // The agent child has exited but a Plan/custom-stage finalizer can still be
    // committing its result. Keep cancellation meaningful in that window; the
    // finalizer checks this flag before it drops tracking.
    const run = runs.get(key);
    if (run) {
      run.cancelled = true;
      run.revertTo = run.stage === 'Verify' || run.prevStatus === 'Verify' ? 'Queue' : run.prevStatus;
      return { ok: true };
    }
    const triageClaim = triaging.get(key);
    if (triageClaim) {
      triageClaim.cancelled = true;
      return { ok: true };
    }
    const triggerClaim = triggerClaims.get(key);
    if (triggerClaim) {
      triggerClaim.cancelled = true;
      triggerClaim.revertTo = triggerClaim.stage === 'Verify' ? 'Queue' : 'Review';
      return { ok: true };
    }
    // chain claimed but between spawns (pre-spawn, mid-retry-ladder waiting on
    // scheduler admission, or post-verify/pre-merge) — nothing to SIGTERM yet.
    // Flag it so the chain reverts at its next checkpoint (buildChain/verify's
    // pendingCancelled() check) instead of proceeding. Do NOT dequeue here: a
    // mid-flow entry may already have real worktree/coordination state that
    // only that checkpoint's revertPendingCancel() knows how to unwind.
    const pend = pending.get(key);
    if (pend) {
      pend.cancelled = true;
      pend.revertTo = 'Queue';
      // The one thing that CAN actually be running in this "between agent
      // spawns" window is the CI command. Stop it now instead of making a
      // cancelled card wait out a full test suite; its stage then unwinds
      // through the same pendingCancelled() checkpoint as everything else.
      const ci = ciRuns.get(key);
      if (ci) { ci.cancelled = true; killWithEscalation(ci.child); }
      // A queued mid-flow stage may never be admitted (permanent pressure or
      // a hung capacity holder). Remove it and run the same worktree/attempt
      // unwind immediately instead of making cancellation depend on capacity.
      if (!ci && scheduler.dequeue(project.name, id)) {
        withoutRepoLockContext(() => unwindQueuedPending(project, id, pend))
          .catch((err) => pipelineError(project, id, err, pend));
      }
      return { ok: true };
    }
    // not running — maybe just queued (never admitted at all, so nothing to unwind)
    if (scheduler.dequeue(project.name, id)) {
      const recovery = recoveryBuilds.get(key);
      recoveryBuilds.delete(key);
      sendState(project, id, 'idle');
      if (recovery) {
        return toNeedsHuman(project, id, 'Build', 'orphaned_run',
          'Resume Build was cancelled before it started; the worktree remains preserved').then(() => ({ ok: true }));
      }
      return moveCard(project.path, id, 'Planned', { reason: 'dequeued' }).then(() => ({ ok: true }));
    }
    return { ok: false, error: 'no live run' };
  }
  const run = runs.get(key);
  run.cancelled = true;
  // a cancelled Verify run — or a retry Build (prevStatus Verify) — would
  // revert to a column humanMove refuses to leave, with no run to re-drive it;
  // send it back to Queue so the cancel handler re-enqueues it
  run.revertTo = run.stage === 'Verify' || run.prevStatus === 'Verify' ? 'Queue' : run.prevStatus;
  killWithEscalation(live);
  return { ok: true };
}

// Archive/unarchive with the same guards the HTTP route (and voice actions)
// need: taking a card off the board while it — or, for an epic, one of its
// children — is building would leak a live run, so archiving requires the same
// live-run/building-child checks DELETE uses, plus the epic cascade.
export async function archiveCard(project, id, on) {
  if (on && hasLiveRun(project.name, id)) return { ok: false, error: 'run in progress — cancel it first' };
  const card = readCard(project.path, id);
  if (on && card?.data?.epic && hasLiveBuildingChild(project, id)) return { ok: false, error: 'a child card is building — cancel it first' };
  if (on) await releaseCardResources(project, id); // taking it off the board frees its build resources
  if (on && card?.data?.epic) await cascadeEpicCleanup(project, id);
  return setArchived(project.path, id, !!on);
}

// Server shutdown: SIGTERM every tracked agent child, then SIGKILL any still
// alive after a short grace — an exiting server must never orphan a running
// (billing) agent CLI. Each child goes through the normal cancel path (run
// flagged cancelled so its exit handler reverts the card instead of treating
// the kill as an agent failure). Resolves once all children are dead or
// force-killed.
export async function killAllChildren({ graceMs = 5000, preserveWorktrees = false } = {}) {
  for (const [key, child] of children) {
    const run = runs.get(key);
    if (run) {
      run.cancelled = true;
      run.preserveWorktree = preserveWorktrees &&
        (run.stage === 'Build' || run.stage === 'Verify' || run.prevStatus === 'Build' || run.prevStatus === 'Verify');
      run.revertTo = run.stage === 'Verify' || run.prevStatus === 'Verify' ? 'Queue' : run.prevStatus;
      // shutdown: the card parks in Queue and the next boot's reconcile
      // re-enqueues it — the verify cancel handler must not respawn a build
      // into a dying process
      run.noRequeue = true;
    }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // A trigger-stage child may already be gone while its final card/Git writes
  // remain tracked. Cancel that finalizer too, and wait for it below, so a board
  // shutdown cannot interrupt the very window voice now protects.
  for (const [key, run] of runs) {
    if (children.has(key)) continue;
    run.cancelled = true;
    run.preserveWorktree = preserveWorktrees &&
      (run.stage === 'Build' || run.stage === 'Verify' || run.prevStatus === 'Build' || run.prevStatus === 'Verify');
    run.revertTo = run.stage === 'Verify' || run.prevStatus === 'Verify' ? 'Queue' : run.prevStatus;
    run.noRequeue = true;
  }
  for (const claim of triaging.values()) claim.cancelled = true;
  for (const claim of triggerClaims.values()) {
    claim.cancelled = true;
    claim.preserveWorktree = preserveWorktrees && claim.stage === 'Verify';
    claim.revertTo = claim.stage === 'Verify' ? 'Queue' : 'Review';
    claim.noRequeue = true;
  }
  // chains claimed but between spawns have no child to kill — flag them so they
  // park in Queue at their next checkpoint instead of spawning into a dying
  // process
  for (const pend of pending.values()) {
    pend.cancelled = true;
    pend.preserveWorktree = preserveWorktrees;
    pend.revertTo = 'Queue';
    pend.noRequeue = true;
  }
  // A CI command is a child of this process too — an exiting server must not
  // leave a test suite running against a worktree it no longer supervises.
  // Its pending claim was just flagged above, so its stage unwinds normally.
  for (const ci of ciRuns.values()) {
    ci.cancelled = true;
    try { ci.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while ((children.size || runs.size || triaging.size || triggerClaims.size || ciRuns.size) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitForExit(graceMs);
  for (const child of children.values()) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const ci of ciRuns.values()) { try { ci.child.kill('SIGKILL'); } catch { /* already gone */ } }
  await waitForExit(1000); // let the close handlers reap and drop tracking entries
}

/* ── plan & custom trigger stages ── */

async function runTriggerStage(project, id, stageName, triggerClaim = null) {
  const key = runKey(project.name, id);
  const finishPreSpawnCancellation = async () => {
    if (!triggerClaim?.cancelled) return false;
    await orchMove(project, id, triggerClaim.revertTo || 'Review', 'cancelled');
    sendState(project, id, 'idle');
    return true;
  };

  try {
  const config = await execConfig(project.path);
  if (await finishPreSpawnCancellation()) return;
  const card = readCard(project.path, id);
  const stage = stageConfig(config, stageName, card);
  const vendor = cardVendor(config, card, stageName);
  const skill = card.data.skill;

  let prompt;
  try {
    prompt = skill
      ? skillPrompt(project, vendor, skill, id, card)
      : stagePrompt(project, vendor, stage, id);
  } catch (e) {
    return toNeedsHuman(project, id, stageName, 'skill_not_found', String(e.message || e));
  }

  const { result, run, finishTracking } = await spawnTracked(project, id, stageName, 'Review', 0, {
    retainUntilFinalized: true,
    triggerClaim,
    vendor,
    cwd: project.path,
    prompt,
    model: stage.model,
    effort: stage.effort,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    logFile: runLogFile(project, id, stageName),
  });

  let cancellationHandled = false;
  let trackingFinished = false;
  const releaseTracking = () => {
    if (trackingFinished) return;
    trackingFinished = true;
    finishTracking();
  };
  const finishCancellation = async () => {
    if (!run?.cancelled || cancellationHandled) return false;
    cancellationHandled = true;
    const revertTo = run.revertTo || 'Review';
    await recordRun(project, id, stageName, 0, result, 'cancelled');
    await orchMove(project, id, revertTo, 'cancelled');
    // A Plan can be cancelled while fanOutChunks is between child commits.
    // Re-read after finalization settles and restore the same invariant as a
    // normal epic retriage: no non-Done child from the cancelled plan remains
    // active on the board.
    if (revertTo === 'Review' && readCard(project.path, id)?.data?.epic) {
      await cascadeEpicCleanup(project, id);
    }
    sendState(project, id, 'idle');
    return true;
  };

  try {
    if (await finishCancellation()) return;
    if (run?.timedOut) {
      await recordRun(project, id, stageName, 0, result, 'run timeout');
      await toNeedsHuman(project, id, stageName, 'run_timeout',
        `${stageName} exceeded the ${run.timeoutMin}m stage timeout`);
      return;
    }
    const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
    if (ok) {
      await recordRun(project, id, stageName, 0, result, skill ? `ok (/${skill})` : 'ok');
      if (await finishCancellation()) return;
      if (stageName === 'Plan') {
        // skill cards return to Review (human reads the findings and decides);
        // staying in Plan would read as an orphaned run after a restart
        if (skill) {
          await orchMove(project, id, 'Review', `findings ready (/${skill})`);
        } else {
          // the plan agent may have split the work into a `## Chunks` breakdown —
          // fan it out into sequential child cards; otherwise it's a normal plan
          const chunks = parseChunks(readCard(project.path, id)?.body || '');
          if (chunks.length >= 2) {
            await fanOutChunks(project, id, chunks);
          } else {
            if (chunks.length === 1) {
              await withRepoLock(project.path, async () => {
                const card = readCard(project.path, id);
                if (card) {
                  const plan = (chunks[0].plan || '').trimEnd();
                  const header = '## Implementation Plan\n';
                  const idx = card.raw.indexOf(header);
                  if (idx !== -1) {
                    const afterHeader = idx + header.length;
                    const nextSection = card.raw.indexOf('\n## ', afterHeader);
                    const end = nextSection >= 0 ? nextSection + 1 : card.raw.length;
                    const updated = card.raw.slice(0, afterHeader) + `\n${plan}\n\n` + card.raw.slice(end);
                    fs.writeFileSync(path.join(project.path, '.todomd', 'tasks', card.file), updated);
                  }
                }
              });
              await appendRunLog(project.path, id, '  - note: single-chunk plan folded into Implementation Plan');
            }
            await orchMove(project, id, 'Planned', 'plan complete');
          }
        }
      }
      // A cancel can arrive while the result or final card move is committing.
      // Re-check after those awaits so the explicit cancellation wins.
      if (await finishCancellation()) return;
      releaseTracking();
      sendState(project, id, 'idle');
      return;
    }
    await handleRunFailure(project, id, stageName, result, run?.prevStatus || 'Review');
    if (await finishCancellation()) return;
    releaseTracking();
  } finally {
    try { await finishCancellation(); }
    finally { releaseTracking(); }
  }
  } finally {
    if (triggerClaim && triggerClaims.get(key) === triggerClaim) triggerClaims.delete(key);
  }
}

async function handleRunFailure(project, id, stageName, result, revertTo) {
  const failure = classifyFailure(result);
  await recordRun(project, id, stageName, 0, result, `failed: ${failure.kind}`);
  if (failure.kind === 'cli_missing' || failure.kind === 'auth') {
    setBanner(failure.kind, 'error', failure.detail);
    await orchMove(project, id, revertTo, failure.kind);
  } else if (failure.kind === 'quota') {
    // trigger stages (Plan/skill) are human-initiated — revert and pause the
    // project; the human re-drags to retry
    pauseForQuota(project);
    await orchMove(project, id, revertTo, 'usage limit');
  } else {
    await toNeedsHuman(project, id, stageName, failure.kind === 'agent' ? failure.detail : 'agent_error', result.stderr);
    return;
  }
  sendState(project, id, 'idle');
}

/* ── epic chunking: fan-out + sequential cascade ── */

// The plan agent split a large card into a `## Chunks` breakdown. Materialize
// each chunk as a child card wired sequentially (chunk N depends on chunk N-1),
// pre-planned so it skips its own Plan stage, and flag the original as an epic
// tracker. Because each chunk is gated behind its predecessor's Done (= merged),
// its build worktree forks from a main that already contains the earlier chunks.
async function fanOutChunks(project, epicId, chunks) {
  return materializeChunks(project.path, epicId, chunks);
}

// Release every chunk child of an epic whose dependencies are all Done — move it
// Planned → Queue and enqueue its build. Called when the epic is approved
// (releases chunk 1) and each time a chunk finishes (releases the next one).
async function advanceChildren(project, epicId) {
  const moved = await advanceEpicChildren(project.path, epicId);
  for (const id of moved) enqueueBuild(project, id);
}

// A chunk child reached Done: release the next ready chunk and, once every chunk
// is Done, complete the epic. No-op for cards that aren't chunks of an epic.
async function maybeAdvanceEpic(project, childId) {
  const parentId = readCard(project.path, childId)?.data?.parent;
  if (!parentId) return;
  await advanceChildren(project, parentId);
}

/* ── build/verify chain ── */

// scheduler onDefer contract: a non-null reason means governor pressure is
// holding this entry back (render 'deferred' + why); null means it cleared —
// back to plain 'queued', whether that's because it just started (the next
// sendState('running', ...) supersedes this) or it's merely waiting on
// ordinary capacity again.
function onDeferState(project, id, column) {
  return (reason) => sendState(project, id, reason ? 'deferred' : 'queued', column, reason || undefined);
}

// The card's very first admission into the build flow — the ONLY point that
// creates its `pending` claim, and the only point manual/quota pause gates
// (an already-running chain's own later stage transitions are start gates
// scheduler.schedule() admits on their own merits, never re-gated by pause —
// "an already-running Build→Verify chain finishes normally").
function enqueueBuild(project, id) {
  const key = runKey(project.name, id);
  // dedupe: a concurrent double-approval or re-approval must not queue twice
  if (scheduler.isQueued(project.name, id) || children.has(key)) return;
  bumpRunGeneration(project.name, id);
  sendState(project, id, 'queued', 'Build');
  let owner = null;
  scheduler.schedule(project, id, 'Build', () => {
    // claim the card synchronously (before any await) so the admit→spawn
    // window still counts as a live run; cleared only when the WHOLE flow
    // settles (sendState(..., 'idle') — success: after merge + the Done move;
    // failure: after toNeedsHuman/revert completes)
    const recovery = recoveryBuilds.get(key) || null;
    recoveryBuilds.delete(key);
    owner = {
      project: project.name, card: id, stage: 'Build',
      cancelled: false, revertTo: null, cascadeArchive: false, noRequeue: false,
    };
    pending.set(key, owner);
    return buildChain(project, id, null, recovery, owner);
  }, {
    blocked: () => quotaPaused.has(project.name) || isQueuePaused(project),
    onDefer: onDeferState(project, id, 'Build'),
  }).catch((err) => pipelineError(project, id, err, owner));
}

// Fire-and-forget dispatch for a retry/escalation Build attempt: each attempt
// is its own scheduler admission (its own Build-column slot), never inherited
// from whichever slot ran the attempt before it — a long retry ladder must
// not pin one Build slot for its whole lifetime. `pending` is already held
// continuously from the card's first admission, so no re-claim here.
function scheduleBuild(project, id, retry) {
  const owner = pending.get(runKey(project.name, id)) || null;
  if (owner) owner.stage = 'Build';
  scheduler.schedule(project, id, 'Build', () => buildChain(project, id, retry, null, owner), {
    onDefer: onDeferState(project, id, 'Build'),
  }).catch((err) => pipelineError(project, id, err, owner));
}

// Fire-and-forget dispatch for a Verify attempt — its own admission against
// the Verify column, requested only once Build has actually finished (see
// buildChain's success path), so the Verify column limit is real instead of
// inert and a Build slot is never held for the whole Build-to-Verify chain.
function scheduleVerify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, isRerun, priorFindings) {
  const owner = pending.get(runKey(project.name, id)) || null;
  if (owner) owner.stage = 'Verify';
  scheduler.schedule(project, id, 'Verify',
    () => verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch,
      isRerun, priorFindings, null, owner),
    { onDefer: onDeferState(project, id, 'Verify') },
  ).catch((err) => pipelineError(project, id, err, owner));
}

// Bound on the CI output kept in memory, and on the tail carried into the
// card when it fails — a test suite can print megabytes.
const CI_OUTPUT_MAX = 64 * 1024;
const CI_DETAIL_MAX = 2000;

// Fire-and-forget dispatch for the CI stage: the board's own verify_command,
// admitted against the scheduler's CI column between Build and Verify. Two
// real things this buys beyond accounting: the command used to run ONLY as a
// claude Stop hook (runner.js), so codex builds never executed it at all, and
// a machine hosting several boards can now cap how many test suites run at
// once independently of how many agents may build or verify.
//
// The card's status stays 'Verify' throughout — 'CI' is the scheduler's
// work-type key, not a board column (a visible CI column, plus quick/full
// command profiles, is task-0041's scope).
function scheduleCi(project, id, command, next) {
  const owner = pending.get(runKey(project.name, id)) || null;
  if (owner) owner.stage = 'CI';
  scheduler.schedule(project, id, 'CI', () => ciStage(project, id, command, next, owner), {
    onDefer: onDeferState(project, id, 'CI'),
  }).catch((err) => pipelineError(project, id, err, owner));
}

async function ciStage(project, id, command, next, pendingOwner = null) {
  // The card can be removed outside the API while this stage waits for
  // scheduler admission. Never spawn or merge work for a card that no longer
  // exists; release only the flow owner captured when this entry was queued.
  if (!readCard(project.path, id)) {
    return sendState(project, id, 'idle', undefined, undefined, pendingOwner);
  }
  const { attempt, maxAttempts, buildSession, worktreeAbs, branch, findings, config, lastVerdict } = next;
  const revertArgs = { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict };
  // same between-spawns cancel checkpoint every other stage has
  const pc = pendingCancelled(project, id);
  if (pc) return revertPendingCancel(project, id, pc, revertArgs);

  sendState(project, id, 'running', 'CI');
  const startedAt = Date.now();
  const outcome = await runVerifyCommand(project, id, command, worktreeAbs);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

  // A cancel/shutdown that landed while the command ran killed the child; the
  // card unwinds through the same checkpoint the agent stages use.
  const cancelled = pendingCancelled(project, id);
  if (cancelled) {
    await appendRunLog(project.path, id, `- ${now()} · CI attempt ${attempt} · cancelled`);
    return revertPendingCancel(project, id, cancelled, revertArgs);
  }
  // killed with no claim left to unwind (the project was removed mid-run) —
  // there is nothing to route, and nothing was merged
  if (outcome.cancelled) return sendState(project, id, 'idle');

  // recordRun() is shaped around an agent envelope (turns, cost, session); a
  // shell command has none, so the card history gets the same run-log line
  // without the meaningless columns.
  if (outcome.ok) {
    await appendRunLog(project.path, id, `- ${now()} · CI attempt ${attempt} · ${secs}s · \`${command}\` passed`);
    return scheduleVerify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, false, findings);
  }
  await appendRunLog(project.path, id, `- ${now()} · CI attempt ${attempt} · ${secs}s · \`${command}\` failed`);
  // CI is the first thing to enter the worktree after Build. A worktree the
  // build deleted out from under itself is an environment failure, not a
  // failing test suite — the same disambiguation classifyFailure() makes for
  // an agent spawn's ENOENT.
  if (!fs.existsSync(worktreeAbs)) {
    return toNeedsHuman(project, id, 'CI', 'worktree_failed', `worktree is gone: ${worktreeAbs}`);
  }
  const why = outcome.timedOut ? `exceeded the ${outcome.timeoutMin}m stage timeout`
    : outcome.spawnError ? `could not start: ${outcome.spawnError}`
    : `exited ${outcome.signal || outcome.code}`;
  return toNeedsHuman(project, id, 'CI', 'ci_failed',
    `\`${command}\` ${why}\n${outcome.output.slice(-CI_DETAIL_MAX)}`);
}

// Run the board's verify_command as a captured child in the task worktree.
// Deliberately much smaller than spawnTracked: there is no session, envelope
// or jsonl transcript to collect — only the exit status, a bounded tail of the
// output for the card, and the ability to stop it on cancel/shutdown.
// `command` comes from execConfig (the COMMITTED config.yml), the same source
// as the Stop hook, so a working-tree edit can never arm a new command here.
function runVerifyCommand(project, id, command, cwd) {
  const key = runKey(project.name, id);
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { project: project.name, card: id, child, cancelled: false, timedOut: false };
  ciRuns.set(key, entry);
  let output = '';
  const capture = (chunk) => {
    output += chunk;
    // Retain a rolling tail, not the first 64 KiB. The final failure summary
    // is normally emitted after a test runner's verbose progress output.
    if (output.length > CI_OUTPUT_MAX) output = output.slice(-CI_OUTPUT_MAX);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', capture);
  }
  const timeoutMin = stageTimeoutMinutes(project);
  let stageTimer;
  if (timeoutMin > 0) {
    stageTimer = setTimeout(() => { entry.timedOut = true; killWithEscalation(child); }, timeoutMin * 60_000);
    stageTimer.unref?.();
  }
  return new Promise((resolve) => {
    const settle = (result) => {
      clearTimeout(stageTimer);
      if (ciRuns.get(key) === entry) ciRuns.delete(key);
      resolve({ ...result, cancelled: entry.cancelled, timedOut: entry.timedOut, timeoutMin, output });
    };
    child.on('error', (err) => settle({ ok: false, code: -1, signal: null, spawnError: String(err?.message || err) }));
    child.on('close', (code, signal) => settle({ ok: code === 0 && !signal, code, signal, spawnError: null }));
  });
}

// A cancel that landed while the chain was between spawns (no live child to
// SIGTERM) is flagged on the pending entry; chain checkpoints honor it.
function pendingCancelled(project, id) {
  const p = pending.get(runKey(project.name, id));
  return p?.cancelled ? p : null;
}

async function unwindQueuedPending(project, id, pc) {
  const card = readCard(project.path, id);
  if (!card) return sendState(project, id, 'idle', undefined, undefined, pc);
  const config = loadConfig(project.path);
  const verification = card.data.verification || {};
  const branch = card.data.worktree;
  const worktreeAbs = path.join(project.path, config.worktree_dir || '.todomd/worktrees', id);
  return revertPendingCancel(project, id, pc, {
    worktreeAbs,
    branch,
    config,
    attempt: Math.max(1, Number(verification.attempts) || 1),
    maxAttempts: Number(verification.max_attempts) || config.max_attempts || 3,
    lastVerdict: verification.last_verdict || '',
  });
}

// Revert for a between-spawns cancel, mirroring the spawn-path cancel handlers:
// abandon the worktree, roll the burned attempt back (a cancel is an abort,
// not a failed try), honor cascadeArchive, and re-drive a Queue revert unless
// shutdown (noRequeue) or budget mode opted out.
async function revertPendingCancel(project, id, pc, { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict }) {
  if (pc.preserveWorktree) {
    const stage = readCard(project.path, id)?.data?.status === 'Verify' ? 'Verify' : 'Build';
    return toNeedsHuman(project, id, stage, 'orphaned_run',
      'server stopped during a run — unmerged work is preserved in the worktree/branch', pc);
  }
  await releaseCoordination(project, id);
  await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
  await patchFrontmatter(project.path, id, {
    worktree: '', base_branch: '',
    verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: lastVerdict || '' },
  });
  if (pc.cascadeArchive) {
    await setArchived(project.path, id, true);
    return sendState(project, id, 'idle', undefined, undefined, pc);
  }
  await orchMove(project, id, pc.revertTo || 'Queue', 'cancelled');
  sendState(project, id, 'idle', undefined, undefined, pc);
  if (pc.revertTo === 'Queue' && !pc.noRequeue && (config.mode || 'launcher') !== 'budget') {
    enqueueBuild(project, id);
  }
}

// An unexpected throw anywhere in the build→verify chain would otherwise
// strand the card in Build/Verify with no live run, no banner, and no log.
async function pipelineError(project, id, err, pendingOwner) {
  const detail = String(err?.stack || err || 'unknown error');
  setBanner(`pipeline:${project.name}:${id}`, 'error', `${id}: unexpected pipeline error — routed to Needs Human`);
  try {
    await toNeedsHuman(project, id, 'Build', 'pipeline_error', detail, pendingOwner);
  } catch { /* a failed recovery must not rethrow into the same catch chain */ }
  finally {
    // toNeedsHuman normally settles the claim itself. If its Git/card recovery
    // also failed, still release only the exact claim whose pipeline rejected.
    sendState(project, id, 'idle', undefined, undefined, pendingOwner);
  }
}

// A leftover worktree dir is reusable only if it's a live git worktree checked
// out on this task's branch. A dir the user switched to another branch (or a
// stale copy whose gitlink is broken) must be recreated, never built upon.
async function worktreeValid(worktreeAbs, branch) {
  const inside = await git(worktreeAbs, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return false;
  const head = await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return head.ok && head.stdout === branch;
}

async function buildChain(project, id, retry = null, recovery = null, pendingOwner = null) {
  const config = await execConfig(project.path);
  const card = readCard(project.path, id);
  if (!card) return sendState(project, id, 'idle', undefined, undefined, pendingOwner);
  const key = runKey(project.name, id);
  // a retry that arrives while the project is quota-paused (e.g. a concurrent
  // card's verify-fail at concurrency>1) must not spawn against the exhausted
  // quota — defer it to resume. enqueueBuild's `blocked` gate already covers
  // first builds, so this only fires on the retry/escalation dispatch path.
  if (quotaPaused.has(project.name)) {
    if (retry?.findings) saveRetryFindings(project, id, retry.findings);
    await orchMove(project, id, 'Queue', 'paused; will resume');
    return sendState(project, id, 'idle');
  }
  // carry findings from a verify-fail build that was then quota-parked
  if (!retry && retryFindings.has(key)) {
    retry = { findings: retryFindings.get(key).findings };
    retryFindings.delete(key);
  }
  const ver = card.data.verification || {};
  const attempt = recovery?.attempt || (Number(ver.attempts) || 0) + 1;
  const maxAttempts = recovery?.maxAttempts || Number(ver.max_attempts) || config.max_attempts || 3;
  const branch = recovery?.branch || `${config.branch_prefix || 'todomd/'}${id}`;
  const worktreeRel = path.join(config.worktree_dir || '.todomd/worktrees', id);
  const worktreeAbs = recovery?.worktreeAbs || path.join(project.path, worktreeRel);
  const fromStatus = recovery ? 'Build' : retry ? 'Verify' : 'Queue';

  // worktree exists across retries; create on first attempt. A leftover dir is
  // only reusable if it's a real git worktree checked out on THIS task's branch
  // — a user-switched or half-removed one must be recreated, not built upon.
  let forkedFrom = null;
  if (recovery && (!fs.existsSync(worktreeAbs) || !(await worktreeValid(worktreeAbs, branch)))) {
    return toNeedsHuman(project, id, fromStatus, 'worktree_failed',
      'the preserved orphaned-Build worktree is no longer available or is checked out on a different branch; nothing was recreated');
  }
  if (!recovery && fs.existsSync(worktreeAbs) && !(await worktreeValid(worktreeAbs, branch))) {
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    if (fs.existsSync(worktreeAbs)) {
      // a dir at the worktree path that isn't a registered worktree can't be
      // git-removed — never build inside it (its git ops would hit the main
      // checkout); refuse and let a human clear it
      return toNeedsHuman(project, id, fromStatus, 'worktree_failed',
        'a stale directory at the worktree path is not a git worktree and could not be removed — remove it manually, then drag the card back to Queue');
    }
  }
  if (!recovery && !fs.existsSync(worktreeAbs)) {
    // capture the base branch BEFORE forking: the merge at the end must land on
    // this same branch — if the user switches branches mid-run, merging would
    // silently drop verified work on the wrong branch. A detached HEAD resolves
    // to nothing → stamp the literal 'unknown' so the merge step escalates to
    // Needs Human instead of silently skipping the guard (a MISSING base_branch
    // stays legacy-skip for cards created before this stamping existed).
    forkedFrom = (await baseBranch(project.path)) || 'unknown';
    const wt = await withRepoLock(project.path, () => addWorktree(project.path, worktreeAbs, branch));
    if (!wt.ok) return toNeedsHuman(project, id, fromStatus, 'worktree_failed', wt.reason);
    // make the worktree runnable: link gitignored runtime deps from the repo
    linkIntoWorktree(project.path, worktreeAbs, config.worktree_link || ['node_modules']);
  }

  await patchFrontmatter(project.path, id, {
    worktree: branch,
    ...(forkedFrom ? { base_branch: forkedFrom } : {}),
    verification: { attempts: attempt, max_attempts: maxAttempts, last_verdict: ver.last_verdict || '' },
  });
  await orchMove(project, id, 'Build', `attempt ${attempt}`);

  // multi-developer coordination: claim the files this card touches, surface
  // (or block on) overlap with another worker's active work
  const coord = config.coordination || {};
  if (coord.enabled && (attempt === 1 || recovery)) {
    try {
      const files = coordPlanFiles(card.body);
      const conflicts = await coordClaim(project.path,
        { card: id, title: card.data.title || id, branch, worker: coordWorker(config), files },
        { sync: coord.sync });
      if (conflicts.length) {
        const detail = conflicts.map((c) => `${c.card} by ${c.worker} (${c.files.join(', ')})`).join('; ');
        await appendRunLog(project.path, id, `  - ⚠ file overlap with active work: ${detail}`);
        setBanner('overlap', 'warn', `${id} overlaps active work: ${detail}`);
        if (coord.block) {
          await coordRelease(project.path, id, { sync: coord.sync });
          return toNeedsHuman(project, id, 'Build', 'work_conflict', detail);
        }
      }
    } catch { /* coordination is advisory — never block the pipeline on its errors */ }
  }

  const stage = stageConfig(config, 'Build', card);
  // An escalation repair intentionally starts a fresh Opus session. It must
  // not inherit the earlier Sonnet conversation or the Ultra Code preset.
  const repair = retry?.escalation?.repair;
  const vendor = repair?.agent || cardVendor(config, card, 'Build');
  const buildOpts = {
    vendor,
    cwd: worktreeAbs,
    model: repair?.model || stage.model,
    effort: repair?.effort || stage.effort,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    logFile: runLogFile(project, id, 'Build', attempt),
  };
  // Stop-hook quality gate is claude-only; for other vendors the independent
  // Verify stage is the gate.
  if (vendor === 'claude') buildOpts.settings = stopHookSettings(config.verify_command || 'npm test');
  if (recovery && !repair) {
    buildOpts.resume = recovery.sessionId || undefined;
    buildOpts.prompt = recovery.sessionId
      ? `Continue the approved task ${id} from its preserved Build session and current worktree state. Do not re-plan or restart. Finish the remaining acceptance criteria, run the verify command, and commit the completed work.`
      : `${stagePrompt(project, vendor, stage, id)}\n\nThis is a recovery of an interrupted Build. Continue from the existing worktree changes; do not discard them, recreate the worktree, re-plan, or restart the task from scratch.`;
  } else if (retry?.sessionId && !repair) {
    buildOpts.resume = retry.sessionId;
    buildOpts.prompt = `The independent verifier failed your work (attempt ${attempt - 1}):\n\n${retry.findings}\n\nFix every finding, re-run the verify command until it passes, and commit on this branch.`;
  } else {
    buildOpts.prompt = stagePrompt(project, vendor, stage, id);
    if (stage.workflow === 'ultra_code' && !repair) buildOpts.prompt += ultraCodeInstructions();
    if (retry?.findings) {
      buildOpts.prompt += `\n\nPrevious verifier findings to address:\n${retry.findings}`;
    }
  }

  // a cancel that landed while the chain was claimed-but-between-spawns (no
  // live child to SIGTERM) is honored right before any work starts
  const pc = pendingCancelled(project, id);
  if (pc) {
    return revertPendingCancel(project, id, pc,
      { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict: ver.last_verdict });
  }

  const continuation = buildContinuationConfig(config);
  let noProgressSlices = 0;
  let slice = 1;
  let before = await progressSnapshot(worktreeAbs);
  let { result, run } = await spawnTracked(project, id, 'Build', fromStatus, attempt, buildOpts);

  // Claude may impose its own default cap even when the board leaves
  // max_turns unset. Resume a productive session rather than converting that
  // normal checkpoint into Needs Human. This is intentionally a Build-only
  // policy: Plan and Verify should remain short, bounded reviews.
  while (!run?.cancelled && !run?.timedOut &&
         continuation.enabled && classifyFailure(result, worktreeAbs).detail === 'max turns reached') {
    const after = await progressSnapshot(worktreeAbs);
    const progressed = hasProgress(before, after);
    await recordRun(project, id, 'Build', attempt, result,
      progressed ? `checkpoint ${slice}: progress detected; continuing` : `checkpoint ${slice}: no git-visible progress`);
    noProgressSlices = progressed ? 0 : noProgressSlices + 1;
    if (noProgressSlices >= continuation.maxNoProgressSlices) {
      return toNeedsHuman(project, id, 'Build', 'stalled_build',
        `No git-visible progress across ${noProgressSlices} consecutive build checkpoints`);
    }

    slice++;
    before = after;
    const sessionId = result.sessionId;
    const continuationOpts = {
      ...buildOpts,
      resume: sessionId || undefined,
      logFile: runLogFile(project, id, 'Build', `${attempt}-continue-${slice}`),
      prompt: sessionId
        ? `Continue the approved task ${id} from the current worktree state. Do not re-plan. Finish the remaining acceptance criteria, run the verify command, and commit the completed work.`
        : `${buildOpts.prompt}\n\nContinue from the current worktree state. Do not re-plan; finish the remaining acceptance criteria, run the verify command, and commit the completed work.`,
    };
    ({ result, run } = await spawnTracked(project, id, 'Build', 'Build', attempt, continuationOpts));
  }

  if (run?.cancelled) {
    await recordRun(project, id, 'Build', attempt, result, 'cancelled');
    if (run.preserveWorktree) {
      return toNeedsHuman(project, id, 'Build', 'orphaned_run',
        'server stopped during Build — unmerged work is preserved in the worktree/branch');
    }
    await releaseCoordination(project, id);
    // abandon the worktree so the cancelled attempt's commits don't linger (and
    // the card's worktree: frontmatter isn't left stale) — a re-approval starts fresh
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    // roll the burned attempt back (like the quota park): a cancel is an
    // abort, not a failed try — it must not count toward attempts_exhausted
    await patchFrontmatter(project.path, id, {
      worktree: '', base_branch: '',
      verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: ver.last_verdict || '' },
    });
    if (run.cascadeArchive) {
      await setArchived(project.path, id, true);
      return sendState(project, id, 'idle');
    }
    await orchMove(project, id, run.revertTo, 'cancelled');
    sendState(project, id, 'idle');
    // same re-drive as the Verify cancel below: a cancel that reverts to Queue
    // (a plain Build cancel, or a retry-Build cancel) re-enqueues through the
    // normal queue so the card resumes on its own; killAllChildren opts out
    if (run.revertTo === 'Queue' && !run.noRequeue && (config.mode || 'launcher') !== 'budget') {
      enqueueBuild(project, id);
    }
    return;
  }
  if (run?.timedOut) {
    await recordRun(project, id, 'Build', attempt, result, 'run timeout');
    return toNeedsHuman(project, id, 'Build', 'run_timeout',
      `Build exceeded the ${run.timeoutMin}m stage timeout`);
  }
  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (!ok) {
    const failure = classifyFailure(result, worktreeAbs);
    await recordRun(project, id, 'Build', attempt, result, `failed: ${failure.kind}`);
    if (failure.kind === 'quota') {
      // park back in Queue (attempt rolled back); resume re-enqueues it
      return parkForQuota(project, id, attempt, maxAttempts, retry?.findings);
    }
    return toNeedsHuman(project, id, 'Build', failure.kind === 'agent' ? failure.detail : failure.kind, result.stderr);
  }

  await recordRun(project, id, 'Build', attempt, result, repair ? 'ok (escalation repair)' : 'ok');
  const buildSession = result.sessionId;
  await orchMove(project, id, 'Verify', `attempt ${attempt}`);
  // Release this Build-column slot now — CI and Verify are each admitted
  // independently (their own scheduler entries) rather than inline, so the
  // Build slot isn't held for the rest of the chain and neither the CI nor the
  // Verify column limit is inert.
  // thread the findings that drove this attempt so a verify-quota resume can
  // rebuild with them (the build code is in the worktree; this keeps context)
  const next = {
    attempt, maxAttempts, buildSession, worktreeAbs, branch, config,
    findings: retry?.findings, lastVerdict: ver.last_verdict,
  };
  const ciCommand = String(config.verify_command || '').trim();
  if (!ciCommand) {
    // Nothing configured to run — say so in the card history, so a missing CI
    // line reads as "this board has no verify_command", not "CI was skipped".
    await appendRunLog(project.path, id, `  - CI: skipped (no verify_command configured)`);
    return scheduleVerify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, false, retry?.findings);
  }
  scheduleCi(project, id, ciCommand, next);
}

async function diagnoseEscalation(project, id, attempt, worktreeAbs, findings, escalation) {
  const prompt = `You are TODOMD's escalation diagnostician. Task ${id} has failed two independent verification rounds. Do not edit code. Read the task, the current worktree, and the prior findings below. Return a concise root-cause diagnosis and a concrete repair strategy for the next build agent.\n\nPrior verification findings:\n${findings}`;
  const { result, run } = await spawnTracked(project, id, 'Escalate', 'Verify', attempt, {
    vendor: escalation.diagnosis.agent,
    cwd: worktreeAbs,
    prompt,
    model: escalation.diagnosis.model,
    effort: escalation.diagnosis.effort,
    jsonSchema: ESCALATION_SCHEMA,
    logFile: runLogFile(project, id, 'Escalate', attempt),
  });
  if (run?.cancelled) {
    await recordRun(project, id, 'Escalate', attempt, result, 'cancelled');
    return { ok: false, reason: 'cancelled', detail: 'escalation diagnosis cancelled' };
  }
  if (run?.timedOut) {
    await recordRun(project, id, 'Escalate', attempt, result, 'run timeout');
    return { ok: false, reason: 'run_timeout', detail: `Escalation diagnosis exceeded the ${run.timeoutMin}m stage timeout` };
  }
  const diagnosis = result.envelope?.structured_output;
  if (!result.envelope || result.envelope.is_error || !diagnosis?.diagnosis || !diagnosis?.repair_strategy) {
    await recordRun(project, id, 'Escalate', attempt, result, 'failed diagnosis');
    return { ok: false, reason: 'escalation_failed', detail: result.stderr || 'Fable did not return a usable repair strategy' };
  }
  await recordRun(project, id, 'Escalate', attempt, result, 'diagnosis complete');
  return { ok: true, findings: `${findings}\n\nFable diagnosis:\n${diagnosis.diagnosis}\n\nRequired repair strategy:\n${diagnosis.repair_strategy}` };
}

async function verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch,
  isRerun, priorFindings, triggerClaim = null, pendingOwner = triggerClaim) {
  const card = readCard(project.path, id);
  // Like Build, revalidate at admission: the queue wait can be arbitrarily
  // long, and an externally deleted card must never spawn Verify or merge.
  if (!card) return sendState(project, id, 'idle', undefined, undefined, pendingOwner);
  const config = await execConfig(project.path);
  const stage = stageConfig(config, 'Verify', card);
  const vendor = cardVendor(config, card, 'Verify');

  if (triggerClaim?.cancelled) {
    if (triggerClaim.preserveWorktree) {
      return toNeedsHuman(project, id, 'Verify', 'orphaned_run',
        'server stopped before Verify — completed Build work is preserved in the worktree/branch');
    }
    await releaseCoordination(project, id);
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    await patchFrontmatter(project.path, id, {
      worktree: '', base_branch: '',
      verification: {
        attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts,
        last_verdict: triggerClaim.lastVerdict || '',
      },
    });
    await orchMove(project, id, triggerClaim.revertTo || 'Queue', 'cancelled');
    sendState(project, id, 'idle');
    if (triggerClaim.revertTo === 'Queue' && !triggerClaim.noRequeue && (config.mode || 'launcher') !== 'budget') {
      enqueueBuild(project, id);
    }
    return;
  }

  // same between-spawns cancel window as buildChain (build done, verify not
  // yet spawned) — honor it before spawning
  const pc = pendingCancelled(project, id);
  if (pc) {
    return revertPendingCancel(project, id, pc,
      { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict: card?.data?.verification?.last_verdict });
  }

  const { result, run } = await spawnTracked(project, id, 'Verify', 'Build', attempt, {
    triggerClaim,
    vendor,
    cwd: worktreeAbs,
    prompt: stagePrompt(project, vendor, stage, id),
    model: stage.model,
    effort: stage.effort,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    jsonSchema: VERDICT_SCHEMA,
    logFile: runLogFile(project, id, 'Verify', attempt),
  });

  if (run?.cancelled) {
    await recordRun(project, id, 'Verify', attempt, result, 'cancelled');
    if (run.preserveWorktree) {
      return toNeedsHuman(project, id, 'Verify', 'orphaned_run',
        'server stopped during Verify — completed Build work is preserved in the worktree/branch');
    }
    await releaseCoordination(project, id);
    // abandon the worktree (see Build cancel) so nothing stale is left behind
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    // roll the burned attempt back (like the quota park): a cancel is an
    // abort, not a failed try — it must not count toward attempts_exhausted
    await patchFrontmatter(project.path, id, {
      worktree: '', base_branch: '',
      verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: card?.data?.verification?.last_verdict || '' },
    });
    if (run.cascadeArchive) {
      await setArchived(project.path, id, true);
      return sendState(project, id, 'idle');
    }
    await orchMove(project, id, run.revertTo, 'cancelled');
    sendState(project, id, 'idle');
    // a user-cancelled Verify reverts to Queue — re-drive it through the normal
    // queue (dedup/quota guards inside) so the card isn't stranded until a
    // restart. killAllChildren opts out (noRequeue): nothing spawns on shutdown.
    if (run.revertTo === 'Queue' && !run.noRequeue && (config.mode || 'launcher') !== 'budget') {
      enqueueBuild(project, id);
    }
    return;
  }
  if (run?.timedOut) {
    await recordRun(project, id, 'Verify', attempt, result, 'run timeout');
    return toNeedsHuman(project, id, 'Verify', 'run_timeout',
      `Verify exceeded the ${run.timeoutMin}m stage timeout`);
  }

  const verdict = result.envelope?.structured_output;
  if (!result.envelope || result.envelope.is_error || !verdict || !verdict.verdict) {
    const failure = classifyFailure(result, worktreeAbs);
    const infrastructure = vendor === 'codex' ? codexVerifierDiagnostic(result) : '';
    if (failure.kind === 'quota') {
      // park back in Queue; resume re-enters the build→verify chain (the
      // existing worktree is reused). Attempt rolled back so none is burned.
      if (infrastructure) await recordRun(project, id, 'Verify', attempt, result, `infrastructure: ${infrastructure}`);
      else await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · usage limit — will resume`);
      return parkForQuota(project, id, attempt, maxAttempts, priorFindings);
    }
    if (!isRerun && failure.kind === 'agent') {
      if (infrastructure) await recordRun(project, id, 'Verify', attempt, result, `infrastructure: ${infrastructure}`);
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · malformed verdict, re-running once`);
      return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch,
        true, priorFindings, triggerClaim, pendingOwner);
    }
    // a genuinely malformed verdict is bad_verdict; a spawn-level failure
    // (e.g. worktree_failed on a deleted cwd) keeps its own kind
    const codexUnavailable = vendor === 'codex' && failure.kind !== 'worktree_failed' && failure.kind !== 'hook_cancelled';
    const reason = codexUnavailable || failure.kind === 'agent' ? 'bad_verdict' : failure.kind;
    await recordRun(project, id, 'Verify', attempt, result,
      infrastructure ? `infrastructure: ${infrastructure}` : `failed: ${reason}`);
    return toNeedsHuman(project, id, 'Verify', reason, infrastructure || result.stderr);
  }

  const unmet = (verdict.criteria || []).filter((c) => !c.met).map((c) => c.criterion);
  const note = `verdict: ${verdict.verdict}${unmet.length ? ` (unmet: ${unmet.length})` : ''}`;
  await recordRun(project, id, 'Verify', attempt, result, note);
  await patchFrontmatter(project.path, id, {
    verification: { attempts: attempt, max_attempts: maxAttempts, last_verdict: verdict.verdict },
  });

  if (verdict.verdict === 'pass') {
    // last between-spawns window: a cancel flagged post-verify/pre-merge aborts
    // the merge too — the card reverts instead of landing Done under a cancel
    const pc2 = pendingCancelled(project, id);
    if (pc2) {
      return revertPendingCancel(project, id, pc2,
        { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict: card?.data?.verification?.last_verdict });
    }
    // §3.4: board tampering guard, then merge
    if (await branchTouchesBoard(project.path, branch)) {
      return toNeedsHuman(project, id, 'Verify', 'board_tampering', 'task branch modifies .todomd/');
    }
    // safety net: the branch must not have committed a linked dep (e.g. a
    // node_modules/.env symlink that slipped past the worktree exclude)
    const forbidden = await branchAddedForbidden(project.path, branch);
    if (forbidden) {
      return toNeedsHuman(project, id, 'Verify', 'committed_dependency', `branch added ${forbidden}`);
    }
    // base-branch guard: only merge onto the branch this run forked from. The
    // user may have switched branches mid-run — merging now would silently land
    // the work on the wrong branch. Route to Needs Human and KEEP the worktree.
    // 'unknown' (stamped when the fork happened on a detached HEAD) always
    // escalates; a MISSING base_branch is a pre-hardening card → legacy skip.
    const forkedFrom = card.data.base_branch;
    if (forkedFrom === 'unknown') {
      return toNeedsHuman(project, id, 'Verify', 'base_branch_unknown',
        'this run forked from a detached HEAD, so the merge target is unknown. ' +
        'Check out the intended branch, then drag the card back to Planned to retry.');
    }
    const head = await currentBranch(project.path);
    if (forkedFrom && head !== forkedFrom) {
      return toNeedsHuman(project, id, 'Verify', 'base_branch_moved',
        `repo is on "${head || 'detached HEAD'}" but this run forked from "${forkedFrom}" — ` +
        `merge refused. Check out ${forkedFrom}, then drag the card back to Planned to retry.`);
    }
    const merged = await withRepoLock(project.path, () => mergeBranch(project.path, branch, `chore(todomd): merge ${id} (verified, attempt ${attempt})`));
    if (!merged.ok) return toNeedsHuman(project, id, 'Verify', 'merge_conflict', merged.reason);
    // A merge that "succeeds" without the branch landing (git reports "Already
    // up to date" while the branch is NOT an ancestor — e.g. a messed-up
    // merge-base) must never mark the card Done: nothing actually merged.
    if (!(await git(project.path, ['merge-base', '--is-ancestor', branch, 'HEAD'])).ok) {
      return toNeedsHuman(project, id, 'Verify', 'merge_noop',
        'merge reported success but the task branch is not an ancestor of HEAD — nothing merged. Work is preserved on the branch.');
    }
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    await patchFrontmatter(project.path, id, { worktree: '', base_branch: '' });
    await releaseCoordination(project, id);
    await orchMove(project, id, 'Done', `verdict: pass, attempt ${attempt}`);
    // if this card is a chunk of an epic, release the next chunk (and complete
    // the epic when the last chunk lands) — the sequential build cascade
    await maybeAdvanceEpic(project, id);
    return sendState(project, id, 'idle');
  }

  // the verifier needs a human DECISION — record the question, roll the attempt
  // back (a pause, not a failed try), and escalate to needs_answer so the drawer
  // shows the question and the answer feeds the next build
  if (verdict.question) {
    await patchFrontmatter(project.path, id, {
      question: verdict.question,
      verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: verdict.verdict },
    });
    await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · needs a human decision`);
    return toNeedsHuman(project, id, 'Verify', 'needs_answer', verdict.question);
  }

  // a setup error means the verify command couldn't even RUN — retrying the
  // build won't fix a missing gitignored dep/env file, so escalate distinctly
  // (and immediately, not after burning every attempt) with a remediation hint
  if (verdict.setup_error) {
    return toNeedsHuman(project, id, 'Verify', 'worktree_env',
      `verify command couldn't run in the worktree: ${verdict.setup_error}. ` +
      `The worktree lacks a gitignored file/dep the tests need — add it to ` +
      `worktree_link in .todomd/config.yml (e.g. .env), then drag the card back to Queue.`);
  }

  // fail → retry loop or escalation
  const findings = `${verdict.findings}\n${unmet.map((c) => `- unmet: ${c}`).join('\n')}`.trim();
  const escalation = escalationConfig(config);
  if (escalation && attempt === escalation.afterFailedReviews && attempt < maxAttempts) {
    await appendRunLog(project.path, id, `  - escalating after ${attempt} failed reviews: Fable diagnosis → Opus repair → final Codex gate`);
    const diagnosis = await diagnoseEscalation(project, id, attempt, worktreeAbs, findings, escalation);
    if (!diagnosis.ok) return toNeedsHuman(project, id, 'Escalate', diagnosis.reason, diagnosis.detail);
    // This Verify slot is released now; the repair Build is its own fresh
    // scheduler admission, same as any other retry attempt.
    return scheduleBuild(project, id, { findings: diagnosis.findings, escalation });
  }
  if (attempt >= maxAttempts) {
    return toNeedsHuman(project, id, 'Verify', 'attempts_exhausted', findings);
  }
  await appendRunLog(project.path, id, `  - retrying with findings (attempt ${attempt + 1}/${maxAttempts})`);
  return scheduleBuild(project, id, { sessionId: buildSession, findings });
}

/* ── auto-triage: annotate incoming Review cards with insight + plan ── */

const triaging = new Map(); // runKey → exact claim spanning pre-spawn through final writes

export async function maybeTriage(project, id) {
  const key = runKey(project.name, id);
  if (triaging.has(key)) return;                         // already claimed this tick
  const card = readCard(project.path, id);
  if (!card || card.data.status !== 'Review') return;
  if (card.data.triaged) return;                         // idempotent across restarts
  if (card.data.skill) return;                           // skill cards have their own flow
  if (children.has(key)) return;
  let resolveClaim;
  const done = new Promise((resolve) => { resolveClaim = resolve; });
  const claim = { project: project.name, card: id, cancelled: false, done, resolve: resolveClaim };
  triaging.set(key, claim); // claimed before any await — no two concurrent calls proceed
  bumpRunGeneration(project.name, id);

  try {
    const config = await execConfig(project.path);
    const t = config.triage || {};
    if (t.enabled === false) return;
    if ((config.mode || 'launcher') === 'budget') return; // dispatcher's job there
    const vendor = cardVendor(config, card);
    if (!SUPPORTED_VENDORS.has(vendor)) return;
    await runTriage(project, id, config, t, vendor, claim);
  } finally {
    triaging.delete(key);
    claim.resolve();
  }
}

// The drawer can save routing immediately after creating a card, while its
// automatic Triage claim is still pre-spawn. Let that direct human edit wait
// for Triage and then revalidate; voice actions intentionally do not use this.
export function waitForTriage(projectName, id) {
  return triaging.get(runKey(projectName, id))?.done || Promise.resolve();
}

async function runTriage(project, id, config, t, vendor, claim) {
  const card = readCard(project.path, id);
  if (!card) return;
  // stamp so a restart-time sweep treats an interrupted triage as retryable
  await patchFrontmatter(project.path, id, { triaged: 'running' });
  if (claim.cancelled) {
    await patchFrontmatter(project.path, id, { triaged: '' });
    return;
  }

  let prompt;
  try {
    prompt = stagePrompt(project, vendor, { command: 'todomd-triage' }, id);
  } catch {
    return patchFrontmatter(project.path, id, { triaged: 'skipped (no command)' });
  }

  // triage auto-fires on cards that may arrive from outside the UI (git pull,
  // email). It runs in the main checkout, so confine its writes to the board
  // AND its reads to the repo: a poisoned card can't make it edit source via
  // prompt injection, or exfiltrate ~/.ssh / ~/.aws / a repo .env into a card
  // that then gets auto-committed.
  //  - claude: allowedTools paren-scoping restricts Read to the repo and Edit
  //    to the cards dir.
  //  - codex: its CLI has no allowedTools scoping (the runner never passes the
  //    list) — its confinement is `--sandbox workspace-write`, which keys the
  //    writable workspace on the cwd (reads stay repo-wide). So run codex
  //    triage with the tasks dir as cwd: writes are confined to the cards
  //    themselves, and the inlined command's board-relative paths are rewritten
  //    to match the new cwd.
  const codexTriage = vendor === 'codex';
  if (claim.cancelled) {
    await patchFrontmatter(project.path, id, { triaged: '' });
    return;
  }
  const { result, run, finishTracking } = await spawnTracked(project, id, 'Triage', 'Review', 0, {
    retainUntilFinalized: true,
    vendor,
    cwd: codexTriage ? path.join(project.path, '.todomd', 'tasks') : project.path,
    prompt: codexTriage ? prompt.replaceAll('.todomd/tasks/', '') : prompt,
    model: card.data.model || t.model || config.default_model,
    effort: card.data.effort || t.effort || config.default_effort,
    maxTurns: t.max_turns || 15,
    allowedTools: ['Read(./**)', 'Glob', 'Grep', 'Edit(.todomd/tasks/**)'], // claude-only; codex ignores this
    logFile: runLogFile(project, id, 'Triage'),
  });

  let cancellationHandled = false;
  const finishCancellation = async () => {
    if (!(claim.cancelled || run?.cancelled) || cancellationHandled) return false;
    cancellationHandled = true;
    await patchFrontmatter(project.path, id, { triaged: '' });
    await commitCardChanges(project.path, id, `chore(todomd): ${id} triage cancelled`);
    return true;
  };

  try {
    if (await finishCancellation()) return;
    const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
    if (run?.timedOut) {
      await recordRun(project, id, 'Triage', 0, result, 'run timeout');
      await patchFrontmatter(project.path, id, { triaged: 'failed (run_timeout)' });
    } else if (ok) {
      await recordRun(project, id, 'Triage', 0, result, 'ok');
      await patchFrontmatter(project.path, id, { triaged: new Date().toISOString().slice(0, 10) });
    } else {
      const failure = classifyFailure(result);
      // a failed triage never blocks the card — it just stays unannotated
      await patchFrontmatter(project.path, id, { triaged: `failed (${failure.kind})` });
      if (failure.kind === 'quota' || failure.kind === 'cli_missing' || failure.kind === 'auth') {
        setBanner(failure.kind, 'warn', `triage paused: ${failure.detail}`);
      }
    }
    if (await finishCancellation()) return;
    // triage ends in Review with no moveCard — commit the annotations ourselves so
    // the board doesn't accumulate uncommitted working-tree changes
    await commitCardChanges(project.path, id, `chore(todomd): ${id} triaged`);
    await finishCancellation();
  } finally {
    try { await finishCancellation(); }
    finally { finishTracking(); }
    sendState(project, id, 'idle');
  }
}

// Catch cards that arrive outside the API (git pull, email routine, editor).
export function triageSweep(project) {
  try {
    const board = loadBoard(project.path);
    for (const card of board.cards) {
      // an unparseable card can't be read or triaged — surface it once per file
      // (setBanner dedupes on the key) instead of burning a triage run every
      // sweep. `unparseable` is the board-payload flag; the title shape covers
      // a board.js that predates it.
      if (card.unparseable || String(card.title || '').startsWith('(unparseable)')) {
        setBanner(`unparseable:${project.name}:${card.file}`, 'error',
          `${project.name}: ${card.file} could not be parsed — fix or remove the card file`);
        continue;
      }
      if (card.status === 'Review' && card.id && !card.triaged && !card.skill) {
        maybeTriage(project, card.id).catch(() => {});
      }
    }
  } catch { /* never fatal */ }
}

/* ── boot-time duties ── */

function preflight() {
  execFile('claude', ['--version'], (err) => {
    if (err) setBanner('cli_missing', 'error', 'claude CLI not found — pipeline columns disabled');
  });
}

export async function reconcileOnBoot() {
  // A prior server's agent children were reparented to init and keep running —
  // editing worktrees behind our back. Kill any still-alive PIDs, but only if
  // the PID is still one of OUR agent CLIs (guard against PID reuse).
  for (const prev of readPriorRuns()) {
    if (prev.pid && isOurAgentProcess(prev.pid, prev.startedAt)) {
      try { process.kill(prev.pid, 'SIGKILL'); } catch { /* gone already */ }
    }
  }
  for (const project of (await import('./registry.js')).listProjects()) {
    try {
      // budget-mode boards belong to the dispatcher session, which self-heals
      // its own interrupted cards — the server must not orphan-sweep them. But
      // the server has no signal that the dispatcher is alive, so if cards sit
      // in Build/Verify with no file progress for 30+ min, nudge (don't act):
      // that's the common budget failure (no /loop running → cards stuck silent).
      if ((loadConfig(project.path).mode || 'launcher') === 'budget') {
        try {
          const tdir = path.join(project.path, '.todomd', 'tasks');
          const stuck = loadBoard(project.path).cards.filter((c) =>
            IN_FLIGHT.has(c.status) && c.file &&
            (Date.now() - fs.statSync(path.join(tdir, c.file)).mtimeMs) > 30 * 60 * 1000);
          if (stuck.length) {
            setBanner(`budget:${project.name}`, 'warn',
              `${project.name}: ${stuck.length} card(s) stuck in Build/Verify for 30+ min — ` +
              `if no \`/loop /todomd-dispatch\` is running, start it or drag them back to Queue.`);
          }
        } catch { /* nudge is best-effort */ }
        continue;
      }
      const config = loadConfig(project.path);
      const wtDir = config.worktree_dir || '.todomd/worktrees';
      const branchPrefix = config.branch_prefix || 'todomd/';
      const board = loadBoard(project.path);
      for (const card of board.cards) {
        if (IN_FLIGHT.has(card.status) && !children.has(runKey(project.name, card.id))) {
          // an orphaned Build|Verify card may hold real work on its branch —
          // never delete unmerged work. If the branch already landed (crash
          // between merge and the Done move), the work is safe: the card goes
          // straight to Done and the leftovers are cleaned up.
          const branch = card.worktree || `${branchPrefix}${card.id}`;
          const wtAbs = path.join(project.path, wtDir, card.id);
          const buildish = card.status === 'Build' || card.status === 'Verify';
          // The branch tip being on HEAD is not enough: an interrupted agent
          // may have valuable uncommitted or untracked work in its worktree.
          // Any dirty (or unreadable) preserved worktree makes this unlanded.
          let worktreeHasChanges = false;
          if (buildish && fs.existsSync(wtAbs)) {
            const status = await git(wtAbs, ['status', '--porcelain']);
            worktreeHasChanges = !status.ok || !!status.stdout;
          }
          const landed = buildish &&
            !worktreeHasChanges &&
            (await git(project.path, ['merge-base', '--is-ancestor', branch, 'HEAD'])).ok;
          if (landed) {
            await withRepoLock(project.path, () => removeWorktree(project.path, wtAbs, branch));
            await patchFrontmatter(project.path, card.id, { worktree: '', base_branch: '' });
            await releaseCoordination(project, card.id);
            await orchMove(project, card.id, 'Done', 'orphaned run; work already merged');
          } else {
            await toNeedsHuman(project, card.id, card.status, 'orphaned_run',
              buildish
                ? 'server restarted during a run — unmerged work is PRESERVED in the worktree/branch'
                : 'server restarted during a run');
            // a Plan-stage orphan has no work to preserve; a fresh retry must
            // not build on the abandoned worktree's rejected commits
            if (!buildish) {
              await withRepoLock(project.path, () => removeWorktree(project.path, wtAbs, branch));
            }
          }
        }
        // interrupted triage, OR a triage that failed on a TRANSIENT problem
        // (claude not on PATH, a usage limit, an auth blip) — clear the stamp so
        // it's retried now that the environment may have recovered
        if (card.triaged === 'running' || /^failed \((cli_missing|quota|auth)\)$/.test(String(card.triaged || ''))) {
          await patchFrontmatter(project.path, card.id, { triaged: '' });
        }
      }
      await withRepoLock(project.path, () => git(project.path, ['worktree', 'prune']));
      // Queue cards (quota-parked, or approved just before a restart) have
      // no live run and no in-memory queue entry — re-drive them.
      enqueueQueue(project);
      // an approved epic re-releases any ready chunk (a crash between epic
      // approval and the chunk-1 enqueue would otherwise strand it in Planned)
      for (const card of board.cards) {
        if (card.epic && card.status === 'Queue') await advanceChildren(project, card.id);
      }
      // re-triage anything now eligible (incl. the transient-failure cards just reset)
      triageSweep(project);
      // prune stale coordination claims for cards no longer in the build flow
      // (e.g. moved out while the server was down) so ACTIVE.md doesn't leak
      if ((config.coordination || {}).enabled) {
        const building = new Set(board.cards.filter((c) => BUILD_FLOW.has(c.status)).map((c) => c.id));
        for (const claimed of await coordClaims(project.path, { sync: false })) {
          if (!building.has(claimed.card)) await coordRelease(project.path, claimed.card, { sync: (config.coordination || {}).sync });
        }
      }
    } catch { /* per-project, never fatal */ }
  }
}

// `ps` lstart is the fixed 24-char ctime prefix ("Www Mmm dd hh:mm:ss yyyy");
// the command follows it. Returns { exe, startMs } or null.
function processInfo(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
    const line = out.replace(/\n+$/, '');
    if (!line.trim()) return null;
    const exe = path.basename((line.slice(24).trim().split(/\s+/)[0] || ''));
    return { exe, startMs: new Date(line.slice(0, 24)).getTime() };
  } catch {
    return null; // no such process, or ps unavailable
  }
}

// Only kill a persisted PID if it still looks like OUR specific agent child.
// Two guards against the OS having reassigned the PID after a crash:
//  - the executable basename is still claude/codex (never a substring of argv);
//  - the process did NOT start after our run began — a reused PID belongs to a
//    later process (e.g. the user's own interactive `claude`), so we spare it.
// Erring toward not-killing is safe: an un-killed orphan is still caught by the
// card → Needs Human sweep on this same boot.
function isOurAgentProcess(pid, startedAtIso) {
  const info = processInfo(pid);
  if (!info) return false;
  if (info.exe !== 'claude' && info.exe !== 'codex') return false;
  const ourStart = startedAtIso ? new Date(startedAtIso).getTime() : NaN;
  // lstart is second-resolution; a 2s margin still kills a genuine orphan
  // (started at/just-before our run) but spares a clearly-later PID reuse.
  if (Number.isFinite(info.startMs) && Number.isFinite(ourStart) && info.startMs > ourStart + 2000) {
    return false;
  }
  return true;
}

export function getRunStates(projectName) {
  const states = {};
  for (const run of runs.values()) {
    if (run.project === projectName) states[run.card] = { state: 'running', stage: run.stage };
  }
  // A live CI command has no `runs` entry (it isn't an agent child), so name it
  // explicitly — otherwise the pending fallback below would report the whole
  // stage as the generic 'in progress'.
  for (const ci of ciRuns.values()) {
    if (ci.project === projectName && !states[ci.card]) states[ci.card] = { state: 'running', stage: 'CI' };
  }
  // Covers both a never-yet-admitted first entry AND a mid-flow retry/Verify
  // entry the scheduler is currently holding on admission — either shows
  // 'queued', or 'deferred' with the governor/capacity reason once one exists.
  for (const entry of scheduler.queuedEntries(projectName)) {
    if (states[entry.card]) continue;
    states[entry.card] = entry.deferredReason
      ? { state: 'deferred', stage: entry.column, reason: entry.deferredReason }
      : { state: 'queued', stage: entry.column };
  }
  // A chain claimed but between spawns (admit→spawn, build→verify handoff
  // before the Verify entry above exists yet, verify→merge) has no `runs`
  // entry yet still counts as live for hasLiveRun/cancel/humanMove. Report it
  // too, or callers that ask "what is running?" see a false idle in exactly
  // the windows the pipeline treats as hands-off. Owners created by the shared
  // scheduler carry their latest stage; legacy/custom owners keep the generic
  // fallback.
  for (const entry of pending.values()) {
    if (entry.project !== projectName) continue;
    if (!states[entry.card]) states[entry.card] = { state: 'running', stage: entry.stage || 'in progress' };
  }
  for (const claim of triaging.values()) {
    if (claim.project === projectName && !states[claim.card]) {
      states[claim.card] = { state: 'running', stage: 'Triage' };
    }
  }
  for (const claim of triggerClaims.values()) {
    if (claim.project === projectName && !states[claim.card]) {
      states[claim.card] = { state: 'running', stage: claim.stage };
    }
  }
  return states;
}

export function hasLiveRun(projectName, id) {
  const key = runKey(projectName, id);
  // runs also covers a trigger-stage child that exited while its final Git/card
  // writes are still settling. That window remains hands-off until finalization.
  // ciRuns is inside the same chain's `pending` window today; it is named here
  // so a live CI command is self-evidently a live run rather than one that
  // depends on another map's bookkeeping.
  return runs.has(key) || pending.has(key) || ciRuns.has(key) || triaging.has(key) || triggerClaims.has(key);
}

export function hasLiveBuildingChild(project, epicId) {
  const board = loadBoard(project.path, { includeArchived: false });
  return board.cards
    .filter((c) => c.parent === epicId && !c.epic)
    .some((c) => hasLiveRun(project.name, c.id));
}

// Any live agent run for this project (used to refuse removing a busy project).
export function projectHasLiveRun(projectName) {
  // Plan/custom-trigger children are tracked in `runs` but do not belong to a
  // pending Build chain. Check both structured values; project names may
  // contain `:`, so composite-key prefix matching is not safe here.
  for (const run of runs.values()) if (run.project === projectName) return true;
  for (const entry of pending.values()) if (entry.project === projectName) return true;
  for (const ci of ciRuns.values()) if (ci.project === projectName) return true;
  for (const claim of triaging.values()) if (claim.project === projectName) return true;
  for (const claim of triggerClaims.values()) if (claim.project === projectName) return true;
  return false;
}

// Drop all in-memory state for a removed project so a same-named re-add starts clean.
export function forgetProject(projectName) {
  scheduler.forgetProject(projectName);
  quotaPaused.delete(projectName);
  for (const [k, entry] of retryFindings) if (entry.project === projectName) retryFindings.delete(k);
  for (const [k, entry] of recoveryBuilds) if (entry.project === projectName) recoveryBuilds.delete(k);
  for (const [k, entry] of pending) if (entry.project === projectName) pending.delete(k);
  // its board is gone — stop the CI command instead of letting it run on
  // against a worktree nothing is watching any more
  for (const [k, ci] of ciRuns) {
    if (ci.project !== projectName) continue;
    ci.cancelled = true;
    killWithEscalation(ci.child);
    ciRuns.delete(k);
  }
  for (const [k, claim] of triaging) if (claim.project === projectName) triaging.delete(k);
  for (const [k, claim] of triggerClaims) if (claim.project === projectName) triggerClaims.delete(k);
  for (const [k, entry] of runGenerations) if (entry.project === projectName) runGenerations.delete(k);
}

export function usage(projectOrName) {
  const projectName = typeof projectOrName === 'string' ? projectOrName : projectOrName?.name;
  return {
    month_cost_usd: monthCost(),
    quota_paused: projectName ? quotaPaused.has(projectName) : quotaPaused.size > 0,
    queue_paused: typeof projectOrName === 'object' && isQueuePaused(projectOrName),
  };
}

export function pauseQueue(project) {
  persistQueuePause(project, true);
  return { ok: true, queue_paused: true };
}

export function resumeQueue(project) {
  persistQueuePause(project, false);
  if ((loadConfig(project.path).mode || 'launcher') === 'budget') {
    return { ok: true, queue_paused: false };
  }
  // Rehydrate cards that were parked across a restart as well as entries still
  // present in the in-memory queue; both helpers dedupe before starting work.
  enqueueQueue(project);
  scheduler.rescan(); // entries only held back by the (now-lifted) pause gate start now
  return { ok: true, queue_paused: false };
}

export function resumeQueues(projects) {
  for (const p of projects) {
    if (!quotaPaused.has(p.name)) continue;
    quotaPaused.delete(p.name);
    enqueueQueue(p); // re-enqueue parked cards through the normal queue
  }
  scheduler.rescan();
  if (quotaPaused.size === 0) setBanner('quota', null, null);
}
