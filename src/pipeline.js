import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig, loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog } from './board.js';
import { isGitRepo, addWorktree, removeWorktree, mergeBranch, branchTouchesBoard, git } from './git.js';
import { runStage, stopHookSettings } from './runner.js';
import { runs, runKey, persistRuns, addCost, monthCost } from './runstore.js';

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
  },
};

const IN_FLIGHT = new Set(['Plan', 'Build', 'Verify']);
const ORCH_ONLY = new Set(['Planned', 'Build', 'Verify', 'Done', 'Needs Human']);

let broadcast = () => {};
const children = new Map();          // runKey → ChildProcess
const queues = new Map();            // project name → [cardId]
const active = new Map();            // project name → running build/verify chains
const banners = new Map();           // key → { level, text }
let quotaPaused = false;

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

function cardVendor(config, card) {
  return card?.data?.agent || config.default_agent || 'claude';
}

function stageConfig(config, stageName, card) {
  const stage = (config.stages || {})[stageName] || {};
  return {
    command: stage.command || `todomd-${stageName.toLowerCase()}`,
    model: card?.data?.model || stage.model,
    maxTurns: stage.max_turns || 30,
    allowedTools: stage.allowed_tools || [],
  };
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

function classifyFailure({ envelope, exitCode, spawnError, stderr }) {
  if (spawnError === 'ENOENT') return { kind: 'cli_missing', detail: 'claude CLI not found on PATH' };
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
  await patchFrontmatter(project.path, id, { needs_human_reason: reason });
  if (detail) await appendRunLog(project.path, id, `  - ${reason}: ${detail.slice(0, 400)}`);
  await orchMove(project, id, 'Needs Human', reason);
  sendState(project, id, 'idle');
}

function runLogFile(project, id, stage, attempt) {
  return path.join(project.path, '.todomd', 'runs', id, `${stage.toLowerCase()}-${attempt || Date.now()}.jsonl`);
}

function spawnTracked(project, id, stage, prevStatus, attempt, opts) {
  const key = runKey(project.name, id);
  const { child, done } = runStage({
    ...opts,
    onEvent: (event) => {
      if (event.type === 'assistant' || event.type === 'rate_limit_event' ||
          (event.type === 'system' && event.subtype === 'init')) {
        broadcast({ type: 'run-event', project: project.name, card: id, event });
      }
    },
  });
  runs.set(key, {
    project: project.name, card: id, stage, pid: child.pid,
    startedAt: new Date().toISOString(), prevStatus, attempt,
  });
  children.set(key, child);
  persistRuns();
  sendState(project, id, 'running', stage);
  return done.then((result) => {
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

  if (live && to !== 'Review') {
    return { ok: false, error: 'run in progress — drag to Review to cancel it first' };
  }

  // always allowed: retriage to Review (cancels a live run)
  if (to === 'Review') {
    if (live) {
      const run = runs.get(key);
      run.cancelled = true;
      run.revertTo = 'Review';
      live.kill('SIGTERM');
      return { ok: true, cancelled: true };
    }
    await patchFrontmatter(project.path, id, { needs_human_reason: '' });
    return moveCard(project.path, id, 'Review', { reason: 'retriage' });
  }

  // approval gate: Planned → Assigned
  if (to === 'Assigned') {
    if (from !== 'Planned') return { ok: false, error: 'cards are assigned from Planned (approve a plan first)' };
    if (!(await isGitRepo(project.path))) return { ok: false, error: 'pipeline needs a git repo' };
    const agent = cardVendor(config, card);
    if (!SUPPORTED_VENDORS.has(agent)) {
      return { ok: false, error: `agent "${agent}" not supported (have: ${[...SUPPORTED_VENDORS].join(', ')})` };
    }
    const deps = card.data.dependencies || [];
    const board = loadBoard(project.path);
    const blocked = deps.filter((d) => board.cards.find((c) => c.id === d)?.status !== 'Done');
    if (blocked.length) return { ok: false, error: `blocked by: ${blocked.join(', ')}` };
    const moved = await moveCard(project.path, id, 'Assigned', { reason: 'approved' });
    if (moved.ok) enqueueBuild(project, id);
    return moved;
  }

  // retry path: Needs Human → Planned (resets the attempt counter)
  if (to === 'Planned') {
    if (from !== 'Needs Human') return { ok: false, error: 'Planned is set by the orchestrator' };
    const ver = card.data.verification || {};
    await patchFrontmatter(project.path, id, {
      needs_human_reason: '',
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
    if (moved.ok) runTriggerStage(project, id, to).catch(() => {});
    return moved;
  }

  if (ORCH_ONLY.has(to)) return { ok: false, error: `${to} is set by the orchestrator` };

  // free human move between non-pipeline columns
  return moveCard(project.path, id, to);
}

export function cancel(project, id) {
  const key = runKey(project.name, id);
  const live = children.get(key);
  if (!live) {
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
  run.revertTo = run.prevStatus;
  live.kill('SIGTERM');
  return { ok: true };
}

/* ── plan & custom trigger stages ── */

async function runTriggerStage(project, id, stageName) {
  const config = loadConfig(project.path);
  const card = readCard(project.path, id);
  const stage = stageConfig(config, stageName, card);
  const vendor = cardVendor(config, card);

  const { result, run } = await spawnTracked(project, id, stageName, 'Review', 0, {
    vendor,
    cwd: project.path,
    prompt: stagePrompt(project, vendor, stage, id),
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
  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (ok) {
    await recordRun(project, id, stageName, 0, result, 'ok');
    if (stageName === 'Plan') await orchMove(project, id, 'Planned', 'plan complete');
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
    quotaPaused = true;
    setBanner('quota', 'warn', 'usage limit reached — queue paused; card returned to its column');
    await orchMove(project, id, revertTo, 'usage limit');
  } else {
    await toNeedsHuman(project, id, stageName, failure.kind === 'agent' ? failure.detail : 'agent_error', result.stderr);
    return;
  }
  sendState(project, id, 'idle');
}

/* ── build/verify chain ── */

function enqueueBuild(project, id) {
  if (!queues.has(project.name)) queues.set(project.name, []);
  queues.get(project.name).push(id);
  sendState(project, id, 'queued', 'Build');
  processQueue(project);
}

function processQueue(project) {
  if (quotaPaused) return;
  const config = loadConfig(project.path);
  const limit = config.concurrency || 1;
  const q = queues.get(project.name) || [];
  while (q.length && (active.get(project.name) || 0) < limit) {
    const id = q.shift();
    active.set(project.name, (active.get(project.name) || 0) + 1);
    buildChain(project, id)
      .catch(() => {})
      .finally(() => {
        active.set(project.name, (active.get(project.name) || 0) - 1);
        processQueue(project);
      });
  }
}

async function buildChain(project, id, retry = null) {
  const config = loadConfig(project.path);
  const card = readCard(project.path, id);
  if (!card) return;
  const ver = card.data.verification || {};
  const attempt = (Number(ver.attempts) || 0) + 1;
  const maxAttempts = Number(ver.max_attempts) || config.max_attempts || 3;
  const branch = `${config.branch_prefix || 'todomd/'}${id}`;
  const worktreeRel = path.join(config.worktree_dir || '.todomd/worktrees', id);
  const worktreeAbs = path.join(project.path, worktreeRel);
  const fromStatus = retry ? 'Verify' : 'Assigned';

  // worktree exists across retries; create on first attempt
  if (!fs.existsSync(worktreeAbs)) {
    const wt = await addWorktree(project.path, worktreeAbs, branch);
    if (!wt.ok) return toNeedsHuman(project, id, fromStatus, 'worktree_failed', wt.reason);
  }

  await patchFrontmatter(project.path, id, {
    worktree: branch,
    verification: { attempts: attempt, max_attempts: maxAttempts, last_verdict: ver.last_verdict || '' },
  });
  await orchMove(project, id, 'Build', `attempt ${attempt}`);

  const stage = stageConfig(config, 'Build', card);
  const vendor = cardVendor(config, card);
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

  const { result, run } = await spawnTracked(project, id, 'Build', fromStatus, attempt, buildOpts);

  if (run?.cancelled) {
    await recordRun(project, id, 'Build', attempt, result, 'cancelled');
    await orchMove(project, id, run.revertTo, 'cancelled');
    return sendState(project, id, 'idle');
  }
  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (!ok) {
    const failure = classifyFailure(result);
    await recordRun(project, id, 'Build', attempt, result, `failed: ${failure.kind}`);
    if (failure.kind === 'quota') {
      quotaPaused = true;
      setBanner('quota', 'warn', 'usage limit reached — queue paused');
      await orchMove(project, id, 'Assigned', 'usage limit; will retry');
      queues.get(project.name)?.unshift(id);
      return sendState(project, id, 'queued', 'Build');
    }
    return toNeedsHuman(project, id, 'Build', failure.kind === 'agent' ? failure.detail : failure.kind, result.stderr);
  }

  await recordRun(project, id, 'Build', attempt, result, 'ok');
  const buildSession = result.sessionId;
  await orchMove(project, id, 'Verify', `attempt ${attempt}`);
  return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, false);
}

async function verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, isRerun) {
  const config = loadConfig(project.path);
  const card = readCard(project.path, id);
  const stage = stageConfig(config, 'Verify', card);
  const vendor = cardVendor(config, card);

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
    await orchMove(project, id, run.revertTo, 'cancelled');
    return sendState(project, id, 'idle');
  }

  const verdict = result.envelope?.structured_output;
  if (!result.envelope || result.envelope.is_error || !verdict || !verdict.verdict) {
    const failure = classifyFailure(result);
    if (failure.kind === 'quota') {
      quotaPaused = true;
      setBanner('quota', 'warn', 'usage limit reached — queue paused');
      await orchMove(project, id, 'Assigned', 'usage limit during verify');
      queues.get(project.name)?.unshift(id) ?? queues.set(project.name, [id]);
      return sendState(project, id, 'queued', 'Build');
    }
    if (!isRerun && failure.kind === 'agent') {
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · malformed verdict, re-running once`);
      return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, true);
    }
    await recordRun(project, id, 'Verify', attempt, result, 'failed: bad_verdict');
    return toNeedsHuman(project, id, 'Verify', 'bad_verdict', result.stderr);
  }

  const unmet = (verdict.criteria || []).filter((c) => !c.met).map((c) => c.criterion);
  const note = `verdict: ${verdict.verdict}${unmet.length ? ` (unmet: ${unmet.length})` : ''}`;
  await recordRun(project, id, 'Verify', attempt, result, note);
  await patchFrontmatter(project.path, id, {
    verification: { attempts: attempt, max_attempts: maxAttempts, last_verdict: verdict.verdict },
  });

  if (verdict.verdict === 'pass') {
    // §3.4: board tampering guard, then merge
    if (await branchTouchesBoard(project.path, branch)) {
      return toNeedsHuman(project, id, 'Verify', 'board_tampering', 'task branch modifies .todomd/');
    }
    const merged = await mergeBranch(project.path, branch, `chore(todomd): merge ${id} (verified, attempt ${attempt})`);
    if (!merged.ok) return toNeedsHuman(project, id, 'Verify', 'merge_conflict', merged.reason);
    await removeWorktree(project.path, worktreeAbs, branch);
    await patchFrontmatter(project.path, id, { worktree: '' });
    await orchMove(project, id, 'Done', `verdict: pass, attempt ${attempt}`);
    return sendState(project, id, 'idle');
  }

  // fail → retry loop or escalation
  const findings = `${verdict.findings}\n${unmet.map((c) => `- unmet: ${c}`).join('\n')}`;
  if (attempt >= maxAttempts) {
    return toNeedsHuman(project, id, 'Verify', 'attempts_exhausted', findings);
  }
  await appendRunLog(project.path, id, `  - retrying with findings (attempt ${attempt + 1}/${maxAttempts})`);
  return buildChain(project, id, { sessionId: buildSession, findings });
}

/* ── boot-time duties ── */

function preflight() {
  execFile('claude', ['--version'], (err) => {
    if (err) setBanner('cli_missing', 'error', 'claude CLI not found — pipeline columns disabled');
  });
}

export async function reconcileOnBoot() {
  for (const project of (await import('./registry.js')).listProjects()) {
    try {
      const board = loadBoard(project.path);
      for (const card of board.cards) {
        if (IN_FLIGHT.has(card.status) && !children.has(runKey(project.name, card.id))) {
          await toNeedsHuman(project, card.id, card.status, 'orphaned_run', 'server restarted during a run');
        }
      }
      await git(project.path, ['worktree', 'prune']);
    } catch { /* per-project, never fatal */ }
  }
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

export function usage() {
  return { month_cost_usd: monthCost(), quota_paused: quotaPaused };
}

export function resumeQueues(projects) {
  quotaPaused = false;
  setBanner('quota', null, null);
  for (const p of projects) processQueue(p);
}
