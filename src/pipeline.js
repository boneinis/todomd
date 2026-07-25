import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { loadConfig, normalizeConfig, loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog, commitCardChanges, withRepoLock, parseChunks, setArchived } from './board.js';
import { materializeChunks, advanceEpicChildren } from './chunks.js';
import { isGitRepo, addWorktree, removeWorktree, mergeBranch, branchTouchesBoard, branchAddedForbidden, linkIntoWorktree, baseBranch, currentBranch, git } from './git.js';
import { runStage, stopHookSettings } from './runner.js';
import { claim as coordClaim, release as coordRelease, readAllClaims as coordClaims, planFiles as coordPlanFiles, workerName as coordWorker } from './coordination.js';
import { runs, runKey, persistRuns, readPriorRuns, addCost, monthCost } from './runstore.js';

const VERDICT_SCHEMA = {
  // todomd.verdict/1
  type: 'object',
  required: ['verdict', 'criteria', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met'],
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' } },
      },
    },
    findings: { type: 'string' },
    // set ONLY when the verify command couldn't run at all (missing dep/file/env
    // var/service) — a worktree-environment problem, not a test-assertion failure
    setup_error: { type: 'string' },
    // set ONLY when a genuine human decision is required to proceed (ambiguous
    // spec, a product choice) — not a code defect you can describe as a finding
    question: { type: 'string' },
  },
};

const IN_FLIGHT = new Set(['Plan', 'Build', 'Verify']);
// statuses where a coordination claim is legitimately held (assigned-and-parked, or building)
const BUILD_FLOW = new Set(['Queue', 'Build', 'Verify']);
const ORCH_ONLY = new Set(['Planned', 'Build', 'Verify', 'Done', 'Needs Human']);

let broadcast = () => {};
const children = new Map();          // runKey → ChildProcess
// runKey → { cancelled, revertTo, cascadeArchive, noRequeue } — a build chain
// claimed by processQueue but not yet fully settled. Covers the windows where
// `children` has no entry (queue shift → spawn, build done → verify spawn,
// verify done → merge) so hasLiveRun/cancel/humanMove never see a false "idle".
const pending = new Map();
const queues = new Map();            // project name → [cardId]
const active = new Map();            // project name → running build/verify chains
const banners = new Map();           // key → { level, text }
const quotaPaused = new Set();        // project names paused on a usage limit
const retryFindings = new Map();      // runKey → verifier findings to carry into a resumed build

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
  if (findings) retryFindings.set(runKey(project.name, id), findings);
  else retryFindings.delete(runKey(project.name, id));
  await orchMove(project, id, 'Queue', 'usage limit; will resume');
  pauseForQuota(project);
  sendState(project, id, 'idle');
}

// Re-enqueue every Queue card that has no live run (used by resume and boot).
// enqueueBuild dedupes, so this is safe to call repeatedly.
function enqueueQueue(project) {
  try {
    for (const card of loadBoard(project.path).cards) {
      // epics sit in Queue as trackers — they never build (their chunks do)
      if (card.status === 'Queue' && card.id && !card.epic &&
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

function sendState(project, cardId, state, stage) {
  broadcast({ type: 'run-state', project: project.name, card: cardId, state, stage });
}

async function orchMove(project, id, to, reason) {
  return moveCard(project.path, id, to, { reason });
}

const SUPPORTED_VENDORS = new Set(['claude', 'codex']);

// Override precedence is card → column → board: a card's own `agent`/`model`
// wins; else the stage column's (`stages.<col>.agent|model`); else the board
// default (`default_agent` / `default_model`). Pass the stage so the column
// level resolves; omit it (e.g. triage) to fall straight through to the board.
function cardVendor(config, card, stageName) {
  const stageAgent = stageName && (config.stages || {})[stageName]?.agent;
  return card?.data?.agent || stageAgent || config.default_agent || 'claude';
}

function stageConfig(config, stageName, card) {
  const stage = (config.stages || {})[stageName] || {};
  return {
    command: stage.command || `todomd-${stageName.toLowerCase()}`,
    model: card?.data?.model || stage.model || config.default_model,
    maxTurns: stage.max_turns || 30,
    allowedTools: stage.allowed_tools || [],
  };
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
const EXEC_KEYS = ['verify_command', 'stages', 'default_agent', 'worktree_link'];

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
function stagePrompt(project, vendor, stage, id) {
  if (vendor !== 'codex') return `/${stage.command} ${id}`;
  const file = path.join(project.path, '.claude', 'commands', `${stage.command}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  const body = raw.replace(/^---[\s\S]*?---\s*/, '');
  return body.replaceAll('$ARGUMENTS', id);
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
  if (/rate.?limit|quota|credit|usage limit|exhausted|exceeded/i.test(text)) {
    return { kind: 'quota', detail: 'usage limit reached' };
  }
  if (/logged.?in|log in|authentication|unauthorized|invalid api key/i.test(text)) {
    return { kind: 'auth', detail: 'claude CLI is not authenticated' };
  }
  if (envelope?.subtype === 'error_max_turns') return { kind: 'agent', detail: 'max turns reached' };
  return { kind: 'agent', detail: envelope?.subtype || `exit ${exitCode}` };
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

async function toNeedsHuman(project, id, from, reason, detail = '') {
  retryFindings.delete(runKey(project.name, id)); // a card leaving the flow keeps no stale findings
  await releaseCoordination(project, id);
  await patchFrontmatter(project.path, id, { needs_human_reason: reason });
  if (detail) await appendRunLog(project.path, id, `  - ${reason}: ${detail.slice(0, 400)}`);
  await orchMove(project, id, 'Needs Human', reason);
  sendState(project, id, 'idle');
}

async function releaseCoordination(project, id) {
  const coord = loadConfig(project.path).coordination || {};
  if (coord.enabled) { try { await coordRelease(project.path, id, { sync: coord.sync }); } catch {} }
}

// Free a card's build resources (queue slot, retry findings, coordination claim,
// worktree) so it can be archived or deleted without leaking anything. The
// caller must ensure there's no LIVE run first (cancel it).
export async function releaseCardResources(project, id) {
  const q = queues.get(project.name);
  const qi = q ? q.indexOf(id) : -1;
  if (qi >= 0) q.splice(qi, 1);
  retryFindings.delete(runKey(project.name, id));
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
  retryFindings.set(runKey(project.name, id),
    `A human answered your earlier question — use this decision to proceed.\nQuestion: ${question}\nAnswer: ${text}`);
  await patchFrontmatter(project.path, id, { question: '', needs_human_reason: '' });
  await appendRunLog(project.path, id, `- ${now()} · human answered: ${text.slice(0, 200)}`);
  await orchMove(project, id, 'Queue', 'answered; resuming');
  enqueueBuild(project, id);
  return { ok: true };
}

function runLogFile(project, id, stage, attempt) {
  return path.join(project.path, '.todomd', 'runs', id, `${stage.toLowerCase()}-${attempt || Date.now()}.jsonl`);
}

function spawnTracked(project, id, stage, prevStatus, attempt, opts) {
  const key = runKey(project.name, id);
  if (children.has(key)) {
    // never overwrite a live run's tracking entry — that would orphan it
    return Promise.resolve({ result: { envelope: null, exitCode: -1, stderr: 'already running' }, run: null });
  }
  const { child, done } = runStage({
    ...opts,
    onEvent: (event) => {
      if (event.type === 'assistant' || event.type === 'rate_limit_event' ||
          (event.type === 'system' && event.subtype === 'init')) {
        broadcast({ type: 'run-event', project: project.name, card: id, event });
      }
    },
  });
  const run = {
    project: project.name, card: id, stage, pid: child.pid,
    startedAt: new Date().toISOString(), prevStatus, attempt,
  };
  runs.set(key, run);
  children.set(key, child);
  persistRuns();
  sendState(project, id, 'running', stage);
  // wall-clock cap: a hung agent must not hold a concurrency slot forever. On
  // expiry the child is killed (TERM → KILL backstop) and the stage's caller
  // routes the card to Needs Human (run.timedOut).
  const cfgTimeout = loadConfig(project.path).stage_timeout_min;
  const n = cfgTimeout == null ? NaN : Number(cfgTimeout);
  // 0 disables the cap; a missing/non-numeric/negative value falls back to the
  // 45m default; clamp under the setTimeout 32-bit ceiling (~24.8 days in
  // minutes) so a huge value doesn't overflow into a ~1ms timer that would
  // instantly kill every run
  const timeoutMin = n === 0 ? 0 : !Number.isFinite(n) || n < 0 ? 45 : Math.min(n, 35791);
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
    runs.delete(key);
    children.delete(key);
    persistRuns();
    return { result, run };
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

  if ((live || pend) && to !== 'Review') {
    return { ok: false, error: 'run in progress — drag to Review to cancel it first' };
  }

  // always allowed: retriage to Review (cancels a live run)
  if (to === 'Review') {
    if (live) {
      const run = runs.get(key);
      run.cancelled = true;
      run.revertTo = 'Review';
      killWithEscalation(live);
      return { ok: true, cancelled: true };
    }
    if (pend) {
      // chain claimed but between spawns — nothing to SIGTERM. Flag it and let
      // the chain's cancel checkpoint do the revert, so there is a single
      // writer and the chain can't stomp this move by continuing.
      pend.cancelled = true;
      pend.revertTo = 'Review';
      return { ok: true, cancelled: true };
    }
    retryFindings.delete(key);
    await releaseCoordination(project, id); // a card pulled back out of the build flow drops its claim
    // discard any stale worktree (like the Planned retry path) so a re-driven
    // card starts fresh instead of building on abandoned commits
    if (card.data.worktree) {
      const wtDir = config.worktree_dir || '.todomd/worktrees';
      await withRepoLock(project.path, () => removeWorktree(project.path, path.join(project.path, wtDir, id), card.data.worktree));
    }
    await patchFrontmatter(project.path, id, { needs_human_reason: '', worktree: '', base_branch: '' });
    const result = await moveCard(project.path, id, 'Review', { reason: 'retriage' });
    if (card.data.epic) await cascadeEpicCleanup(project, id);
    return result;
  }

  // approval gate: Planned → Queue
  if (to === 'Queue') {
    if (from !== 'Planned') return { ok: false, error: 'cards are assigned from Planned (approve a plan first)' };
    if (!(await isGitRepo(project.path))) return { ok: false, error: 'pipeline needs a git repo' };
    const agent = cardVendor(config, card, 'Build');
    if (!SUPPORTED_VENDORS.has(agent)) {
      return { ok: false, error: `agent "${agent}" not supported (have: ${[...SUPPORTED_VENDORS].join(', ')})` };
    }
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
    // a plan that was SPLIT into chunks but never fanned out into child cards has
    // no epic flag. Approving it would build the whole epic as one monolith, so
    // refuse with a clear path forward. A real launcher/budget epic that was
    // properly fanned out carries epic:true and already returned above, so this
    // only catches the unmaterialized case.
    if (parseChunks(card.body).length >= 2) {
      return { ok: false, error: `${id}'s plan was split into chunks that were never materialized (the plan was split into chunks but no chunk cards were created). Re-plan it as a single task, or run \`todomd fanout ${id}\` first.` };
    }
    const deps = card.data.dependencies || [];
    // include archived cards so a completed-then-archived dependency still counts
    const board = loadBoard(project.path, { includeArchived: true });
    const blocked = deps.filter((d) => board.cards.find((c) => c.id === d)?.status !== 'Done');
    if (blocked.length) return { ok: false, error: `blocked by: ${blocked.join(', ')}` };
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
      runTriggerStage(project, id, to).catch(() => {});
    }
    return moved;
  }

  if (ORCH_ONLY.has(to)) return { ok: false, error: `${to} is set by the orchestrator` };

  // free human move between non-pipeline columns
  return moveCard(project.path, id, to);
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
    // chain claimed but between spawns (pre-spawn, or post-verify/pre-merge) —
    // nothing to SIGTERM. Flag it so the chain reverts at its next checkpoint
    // instead of proceeding, and drop any queued re-entry so the abort sticks.
    const pend = pending.get(key);
    if (pend) {
      pend.cancelled = true;
      pend.revertTo = 'Queue';
      const q = queues.get(project.name) || [];
      const qi = q.indexOf(id);
      if (qi >= 0) q.splice(qi, 1);
      return { ok: true };
    }
    // not running — maybe just queued
    const q = queues.get(project.name) || [];
    const qi = q.indexOf(id);
    if (qi >= 0) {
      q.splice(qi, 1);
      sendState(project, id, 'idle');
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

// Server shutdown: SIGTERM every tracked agent child, then SIGKILL any still
// alive after a short grace — an exiting server must never orphan a running
// (billing) agent CLI. Each child goes through the normal cancel path (run
// flagged cancelled so its exit handler reverts the card instead of treating
// the kill as an agent failure). Resolves once all children are dead or
// force-killed.
export async function killAllChildren({ graceMs = 5000 } = {}) {
  for (const [key, child] of children) {
    const run = runs.get(key);
    if (run) {
      run.cancelled = true;
      run.revertTo = run.stage === 'Verify' || run.prevStatus === 'Verify' ? 'Queue' : run.prevStatus;
      // shutdown: the card parks in Queue and the next boot's reconcile
      // re-enqueues it — the verify cancel handler must not respawn a build
      // into a dying process
      run.noRequeue = true;
    }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // chains claimed but between spawns have no child to kill — flag them so they
  // park in Queue at their next checkpoint instead of spawning into a dying
  // process
  for (const pend of pending.values()) {
    pend.cancelled = true;
    pend.revertTo = 'Queue';
    pend.noRequeue = true;
  }
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (children.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  };
  await waitForExit(graceMs);
  for (const child of children.values()) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  await waitForExit(1000); // let the close handlers reap and drop tracking entries
}

/* ── plan & custom trigger stages ── */

async function runTriggerStage(project, id, stageName) {
  const config = await execConfig(project.path);
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

  const { result, run } = await spawnTracked(project, id, stageName, 'Review', 0, {
    vendor,
    cwd: project.path,
    prompt,
    model: stage.model,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    logFile: runLogFile(project, id, stageName),
  });

  if (run?.cancelled) {
    await recordRun(project, id, stageName, 0, result, 'cancelled');
    await orchMove(project, id, run.revertTo, 'cancelled');
    sendState(project, id, 'idle');
    return;
  }
  if (run?.timedOut) {
    await recordRun(project, id, stageName, 0, result, 'run timeout');
    return toNeedsHuman(project, id, stageName, 'run_timeout',
      `${stageName} exceeded the ${run.timeoutMin}m stage timeout`);
  }
  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (ok) {
    await recordRun(project, id, stageName, 0, result, skill ? `ok (/${skill})` : 'ok');
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
    sendState(project, id, 'idle');
    return;
  }
  await handleRunFailure(project, id, stageName, result, run?.prevStatus || 'Review');
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

function enqueueBuild(project, id) {
  if (!queues.has(project.name)) queues.set(project.name, []);
  const q = queues.get(project.name);
  // dedupe: a concurrent double-approval or re-approval must not queue twice
  if (q.includes(id) || children.has(runKey(project.name, id))) return;
  q.push(id);
  sendState(project, id, 'queued', 'Build');
  processQueue(project);
}

function processQueue(project) {
  if (quotaPaused.has(project.name)) return;
  const config = loadConfig(project.path);
  const limit = config.concurrency || 1;
  const q = queues.get(project.name) || [];
  while (q.length && (active.get(project.name) || 0) < limit) {
    const id = q.shift();
    // claim the card synchronously (before any await) so the shift→spawn
    // window still counts as a live run; cleared only when the WHOLE chain
    // settles (the finally below — success: after merge + the Done move;
    // failure: after toNeedsHuman/revert completes)
    const key = runKey(project.name, id);
    const entry = { cancelled: false, revertTo: null, cascadeArchive: false, noRequeue: false };
    pending.set(key, entry);
    active.set(project.name, (active.get(project.name) || 0) + 1);
    buildChain(project, id)
      .catch((err) => pipelineError(project, id, err))
      .finally(() => {
        // a re-enqueue (e.g. a verify-cancel at concurrency>1) may already have
        // shifted a FRESH entry for this card — don't clear that one
        if (pending.get(key) === entry) pending.delete(key);
        active.set(project.name, (active.get(project.name) || 0) - 1);
        processQueue(project);
      });
  }
}

// A cancel that landed while the chain was between spawns (no live child to
// SIGTERM) is flagged on the pending entry; chain checkpoints honor it.
function pendingCancelled(project, id) {
  const p = pending.get(runKey(project.name, id));
  return p?.cancelled ? p : null;
}

// Revert for a between-spawns cancel, mirroring the spawn-path cancel handlers:
// abandon the worktree, roll the burned attempt back (a cancel is an abort,
// not a failed try), honor cascadeArchive, and re-drive a Queue revert unless
// shutdown (noRequeue) or budget mode opted out.
async function revertPendingCancel(project, id, pc, { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict }) {
  await releaseCoordination(project, id);
  await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
  await patchFrontmatter(project.path, id, {
    worktree: '', base_branch: '',
    verification: { attempts: Math.max(0, attempt - 1), max_attempts: maxAttempts, last_verdict: lastVerdict || '' },
  });
  if (pc.cascadeArchive) {
    await setArchived(project.path, id, true);
    return sendState(project, id, 'idle');
  }
  await orchMove(project, id, pc.revertTo || 'Queue', 'cancelled');
  sendState(project, id, 'idle');
  if (pc.revertTo === 'Queue' && !pc.noRequeue && (config.mode || 'launcher') !== 'budget') {
    enqueueBuild(project, id);
  }
}

// An unexpected throw anywhere in the build→verify chain would otherwise
// strand the card in Build/Verify with no live run, no banner, and no log.
async function pipelineError(project, id, err) {
  const detail = String(err?.stack || err || 'unknown error');
  setBanner(`pipeline:${project.name}:${id}`, 'error', `${id}: unexpected pipeline error — routed to Needs Human`);
  try {
    await toNeedsHuman(project, id, 'Build', 'pipeline_error', detail);
  } catch { /* a failed recovery must not rethrow into the same catch chain */ }
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

async function buildChain(project, id, retry = null) {
  const config = await execConfig(project.path);
  const card = readCard(project.path, id);
  if (!card) return;
  const key = runKey(project.name, id);
  // a retry that arrives while the project is quota-paused (e.g. a concurrent
  // card's verify-fail at concurrency>1) must not spawn against the exhausted
  // quota — defer it to resume. processQueue already gates first builds, so
  // this only fires on the direct verify→retry path.
  if (quotaPaused.has(project.name)) {
    if (retry?.findings) retryFindings.set(key, retry.findings);
    await orchMove(project, id, 'Queue', 'paused; will resume');
    return sendState(project, id, 'idle');
  }
  // carry findings from a verify-fail build that was then quota-parked
  if (!retry && retryFindings.has(key)) { retry = { findings: retryFindings.get(key) }; retryFindings.delete(key); }
  const ver = card.data.verification || {};
  const attempt = (Number(ver.attempts) || 0) + 1;
  const maxAttempts = Number(ver.max_attempts) || config.max_attempts || 3;
  const branch = `${config.branch_prefix || 'todomd/'}${id}`;
  const worktreeRel = path.join(config.worktree_dir || '.todomd/worktrees', id);
  const worktreeAbs = path.join(project.path, worktreeRel);
  const fromStatus = retry ? 'Verify' : 'Queue';

  // worktree exists across retries; create on first attempt. A leftover dir is
  // only reusable if it's a real git worktree checked out on THIS task's branch
  // — a user-switched or half-removed one must be recreated, not built upon.
  let forkedFrom = null;
  if (fs.existsSync(worktreeAbs) && !(await worktreeValid(worktreeAbs, branch))) {
    await withRepoLock(project.path, () => removeWorktree(project.path, worktreeAbs, branch));
    if (fs.existsSync(worktreeAbs)) {
      // a dir at the worktree path that isn't a registered worktree can't be
      // git-removed — never build inside it (its git ops would hit the main
      // checkout); refuse and let a human clear it
      return toNeedsHuman(project, id, fromStatus, 'worktree_failed',
        'a stale directory at the worktree path is not a git worktree and could not be removed — remove it manually, then drag the card back to Queue');
    }
  }
  if (!fs.existsSync(worktreeAbs)) {
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
  if (coord.enabled && attempt === 1) {
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
  const vendor = cardVendor(config, card, 'Build');
  const buildOpts = {
    vendor,
    cwd: worktreeAbs,
    model: stage.model,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    logFile: runLogFile(project, id, 'Build', attempt),
  };
  // Stop-hook quality gate is claude-only; for other vendors the independent
  // Verify stage is the gate.
  if (vendor === 'claude') buildOpts.settings = stopHookSettings(config.verify_command || 'npm test');
  if (retry?.sessionId) {
    buildOpts.resume = retry.sessionId;
    buildOpts.prompt = `The independent verifier failed your work (attempt ${attempt - 1}):\n\n${retry.findings}\n\nFix every finding, re-run the verify command until it passes, and commit on this branch.`;
  } else {
    buildOpts.prompt = stagePrompt(project, vendor, stage, id);
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

  const { result, run } = await spawnTracked(project, id, 'Build', fromStatus, attempt, buildOpts);

  if (run?.cancelled) {
    await recordRun(project, id, 'Build', attempt, result, 'cancelled');
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

  await recordRun(project, id, 'Build', attempt, result, 'ok');
  const buildSession = result.sessionId;
  await orchMove(project, id, 'Verify', `attempt ${attempt}`);
  // thread the findings that drove this attempt so a verify-quota resume can
  // rebuild with them (the build code is in the worktree; this keeps context)
  return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, false, retry?.findings);
}

async function verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, isRerun, priorFindings) {
  const config = await execConfig(project.path);
  const card = readCard(project.path, id);
  const stage = stageConfig(config, 'Verify', card);
  const vendor = cardVendor(config, card, 'Verify');

  // same between-spawns cancel window as buildChain (build done, verify not
  // yet spawned) — honor it before spawning
  const pc = pendingCancelled(project, id);
  if (pc) {
    return revertPendingCancel(project, id, pc,
      { worktreeAbs, branch, config, attempt, maxAttempts, lastVerdict: card?.data?.verification?.last_verdict });
  }

  const { result, run } = await spawnTracked(project, id, 'Verify', 'Build', attempt, {
    vendor,
    cwd: worktreeAbs,
    prompt: stagePrompt(project, vendor, stage, id),
    model: stage.model,
    maxTurns: stage.maxTurns,
    allowedTools: stage.allowedTools,
    jsonSchema: VERDICT_SCHEMA,
  });

  if (run?.cancelled) {
    await recordRun(project, id, 'Verify', attempt, result, 'cancelled');
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
    if (failure.kind === 'quota') {
      // park back in Queue; resume re-enters the build→verify chain (the
      // existing worktree is reused). Attempt rolled back so none is burned.
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · usage limit — will resume`);
      return parkForQuota(project, id, attempt, maxAttempts, priorFindings);
    }
    if (!isRerun && failure.kind === 'agent') {
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · malformed verdict, re-running once`);
      return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, true, priorFindings);
    }
    // a genuinely malformed verdict is bad_verdict; a spawn-level failure
    // (e.g. worktree_failed on a deleted cwd) keeps its own kind
    const reason = failure.kind === 'agent' ? 'bad_verdict' : failure.kind;
    await recordRun(project, id, 'Verify', attempt, result, `failed: ${reason}`);
    return toNeedsHuman(project, id, 'Verify', reason, result.stderr);
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
  const findings = `${verdict.findings}\n${unmet.map((c) => `- unmet: ${c}`).join('\n')}`;
  if (attempt >= maxAttempts) {
    return toNeedsHuman(project, id, 'Verify', 'attempts_exhausted', findings);
  }
  await appendRunLog(project.path, id, `  - retrying with findings (attempt ${attempt + 1}/${maxAttempts})`);
  return buildChain(project, id, { sessionId: buildSession, findings });
}

/* ── auto-triage: annotate incoming Review cards with insight + plan ── */

const triaging = new Set(); // synchronous claim — closes the check-then-spawn gap

export async function maybeTriage(project, id) {
  const config = await execConfig(project.path);
  const t = config.triage || {};
  if (t.enabled === false) return;
  if ((config.mode || 'launcher') === 'budget') return; // dispatcher's job there
  const key = runKey(project.name, id);
  if (triaging.has(key)) return;                         // already claimed this tick
  const card = readCard(project.path, id);
  if (!card || card.data.status !== 'Review') return;
  if (card.data.triaged) return;                         // idempotent across restarts
  if (card.data.skill) return;                           // skill cards have their own flow
  const vendor = cardVendor(config, card);
  if (!SUPPORTED_VENDORS.has(vendor)) return;
  if (children.has(key)) return;
  triaging.add(key); // claimed before any await — no two concurrent calls proceed

  try {
    await runTriage(project, id, config, t, vendor);
  } finally {
    triaging.delete(key);
  }
}

async function runTriage(project, id, config, t, vendor) {
  // stamp so a restart-time sweep treats an interrupted triage as retryable
  await patchFrontmatter(project.path, id, { triaged: 'running' });

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
  const { result, run } = await spawnTracked(project, id, 'Triage', 'Review', 0, {
    vendor,
    cwd: codexTriage ? path.join(project.path, '.todomd', 'tasks') : project.path,
    prompt: codexTriage ? prompt.replaceAll('.todomd/tasks/', '') : prompt,
    model: t.model,
    maxTurns: t.max_turns || 15,
    allowedTools: ['Read(./**)', 'Glob', 'Grep', 'Edit(.todomd/tasks/**)'], // claude-only; codex ignores this
    logFile: runLogFile(project, id, 'Triage'),
  });

  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (run?.cancelled) {
    await patchFrontmatter(project.path, id, { triaged: '' });
  } else if (run?.timedOut) {
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
  // triage ends in Review with no moveCard — commit the annotations ourselves so
  // the board doesn't accumulate uncommitted working-tree changes
  if (!run?.cancelled) await commitCardChanges(project.path, id, `chore(todomd): ${id} triaged`);
  sendState(project, id, 'idle');
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
          const branch = `${branchPrefix}${card.id}`;
          const wtAbs = path.join(project.path, wtDir, card.id);
          const buildish = card.status === 'Build' || card.status === 'Verify';
          const landed = buildish &&
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
  for (const id of queues.get(projectName) || []) {
    states[id] = { state: 'queued', stage: 'Build' };
  }
  return states;
}

export function hasLiveRun(projectName, id) {
  const key = runKey(projectName, id);
  // children covers spawned runs; pending covers a claimed chain between
  // spawns (shift→spawn, build→verify, verify→merge) — both mean "hands off"
  return children.has(key) || pending.has(key);
}

export function hasLiveBuildingChild(project, epicId) {
  const board = loadBoard(project.path, { includeArchived: false });
  return board.cards
    .filter((c) => c.parent === epicId && !c.epic)
    .some((c) => hasLiveRun(project.name, c.id));
}

// Any live agent run for this project (used to refuse removing a busy project).
export function projectHasLiveRun(projectName) {
  const prefix = `${projectName}:`;
  for (const key of children.keys()) if (key.startsWith(prefix)) return true;
  for (const key of pending.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

// Drop all in-memory state for a removed project so a same-named re-add starts clean.
export function forgetProject(projectName) {
  queues.delete(projectName);
  active.delete(projectName);
  quotaPaused.delete(projectName);
  const prefix = `${projectName}:`;
  for (const k of retryFindings.keys()) if (k.startsWith(prefix)) retryFindings.delete(k);
  for (const k of pending.keys()) if (k.startsWith(prefix)) pending.delete(k);
}

export function usage(projectName) {
  return { month_cost_usd: monthCost(), quota_paused: projectName ? quotaPaused.has(projectName) : quotaPaused.size > 0 };
}

export function resumeQueues(projects) {
  for (const p of projects) {
    if (!quotaPaused.has(p.name)) continue;
    quotaPaused.delete(p.name);
    enqueueQueue(p); // re-enqueue parked cards through the normal queue
    processQueue(p);
  }
  if (quotaPaused.size === 0) setBanner('quota', null, null);
}
