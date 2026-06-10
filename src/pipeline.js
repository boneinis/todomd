import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { loadConfig, loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog, commitCardChanges } from './board.js';
import { isGitRepo, addWorktree, removeWorktree, mergeBranch, branchTouchesBoard, branchAddedForbidden, linkIntoWorktree, git } from './git.js';
import { runStage, stopHookSettings } from './runner.js';
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
  },
};

const IN_FLIGHT = new Set(['Plan', 'Build', 'Verify']);
const ORCH_ONLY = new Set(['Planned', 'Build', 'Verify', 'Done', 'Needs Human']);

let broadcast = () => {};
const children = new Map();          // runKey → ChildProcess
const queues = new Map();            // project name → [cardId]
const active = new Map();            // project name → running build/verify chains
const banners = new Map();           // key → { level, text }
const quotaPaused = new Set();        // project names paused on a usage limit
const retryFindings = new Map();      // runKey → verifier findings to carry into a resumed build

// On a usage limit the card is parked back in Assigned with its attempt rolled
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
  await orchMove(project, id, 'Assigned', 'usage limit; will resume');
  pauseForQuota(project);
  sendState(project, id, 'idle');
}

// Re-enqueue every Assigned card that has no live run (used by resume and boot).
// enqueueBuild dedupes, so this is safe to call repeatedly.
function enqueueAssigned(project) {
  try {
    for (const card of loadBoard(project.path).cards) {
      if (card.status === 'Assigned' && card.id && !children.has(runKey(project.name, card.id))) {
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
  retryFindings.delete(runKey(project.name, id)); // a card leaving the flow keeps no stale findings
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
    retryFindings.delete(key);
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
    // budget mode: the /todomd-dispatch session picks the card up from here.
    // `unchanged` guards a concurrent double-approval: only the transition that
    // actually moved Planned→Assigned enqueues (enqueueBuild also dedupes).
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
      await removeWorktree(project.path, path.join(project.path, wtDir, id), card.data.worktree);
    }
    await patchFrontmatter(project.path, id, {
      needs_human_reason: '',
      worktree: '',
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
  // a cancelled Verify run would revert to Build (prevStatus), which humanMove
  // then refuses to leave — send it back to Assigned so it can be re-driven
  run.revertTo = run.stage === 'Verify' ? 'Assigned' : run.prevStatus;
  live.kill('SIGTERM');
  return { ok: true };
}

/* ── plan & custom trigger stages ── */

async function runTriggerStage(project, id, stageName) {
  const config = loadConfig(project.path);
  const card = readCard(project.path, id);
  const stage = stageConfig(config, stageName, card);
  const vendor = cardVendor(config, card);
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
  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (ok) {
    await recordRun(project, id, stageName, 0, result, skill ? `ok (/${skill})` : 'ok');
    if (stageName === 'Plan') {
      // skill cards return to Review (human reads the findings and decides);
      // staying in Plan would read as an orphaned run after a restart
      if (skill) await orchMove(project, id, 'Review', `findings ready (/${skill})`);
      else await orchMove(project, id, 'Planned', 'plan complete');
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
  const key = runKey(project.name, id);
  // a retry that arrives while the project is quota-paused (e.g. a concurrent
  // card's verify-fail at concurrency>1) must not spawn against the exhausted
  // quota — defer it to resume. processQueue already gates first builds, so
  // this only fires on the direct verify→retry path.
  if (quotaPaused.has(project.name)) {
    if (retry?.findings) retryFindings.set(key, retry.findings);
    await orchMove(project, id, 'Assigned', 'paused; will resume');
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
  const fromStatus = retry ? 'Verify' : 'Assigned';

  // worktree exists across retries; create on first attempt
  if (!fs.existsSync(worktreeAbs)) {
    const wt = await addWorktree(project.path, worktreeAbs, branch);
    if (!wt.ok) return toNeedsHuman(project, id, fromStatus, 'worktree_failed', wt.reason);
    // make the worktree runnable: link gitignored runtime deps from the repo
    linkIntoWorktree(project.path, worktreeAbs, config.worktree_link || ['node_modules']);
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
      // park back in Assigned (attempt rolled back); resume re-enqueues it
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
      // park back in Assigned; resume re-enters the build→verify chain (the
      // existing worktree is reused). Attempt rolled back so none is burned.
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · usage limit — will resume`);
      return parkForQuota(project, id, attempt, maxAttempts, priorFindings);
    }
    if (!isRerun && failure.kind === 'agent') {
      await appendRunLog(project.path, id, `- ${now()} · Verify attempt ${attempt} · malformed verdict, re-running once`);
      return verify(project, id, attempt, maxAttempts, buildSession, worktreeAbs, branch, true, priorFindings);
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
    // safety net: the branch must not have committed a linked dep (e.g. a
    // node_modules/.env symlink that slipped past the worktree exclude)
    const forbidden = await branchAddedForbidden(project.path, branch);
    if (forbidden) {
      return toNeedsHuman(project, id, 'Verify', 'committed_dependency', `branch added ${forbidden}`);
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

/* ── auto-triage: annotate incoming Review cards with insight + plan ── */

const triaging = new Set(); // synchronous claim — closes the check-then-spawn gap

export async function maybeTriage(project, id) {
  const config = loadConfig(project.path);
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

  const { result, run } = await spawnTracked(project, id, 'Triage', 'Review', 0, {
    vendor,
    cwd: project.path,
    prompt,
    model: t.model,
    maxTurns: t.max_turns || 15,
    // triage auto-fires on cards that may arrive from outside the UI (git pull,
    // email). It runs in the main checkout, so confine its writes to the board:
    // a poisoned card can't make it edit source via prompt injection.
    allowedTools: vendor === 'codex' ? ['Read', 'Glob', 'Grep', 'Edit'] : ['Read', 'Glob', 'Grep', 'Edit(.todomd/tasks/**)'],
    logFile: runLogFile(project, id, 'Triage'),
  });

  const ok = result.envelope && !result.envelope.is_error && result.envelope.subtype === 'success';
  if (run?.cancelled) {
    await patchFrontmatter(project.path, id, { triaged: '' });
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
    if (prev.pid && isOurAgentProcess(prev.pid)) {
      try { process.kill(prev.pid, 'SIGKILL'); } catch { /* gone already */ }
    }
  }
  for (const project of (await import('./registry.js')).listProjects()) {
    try {
      // budget-mode boards belong to the dispatcher session, which self-heals
      // its own interrupted cards — the server must not orphan-sweep them
      if ((loadConfig(project.path).mode || 'launcher') === 'budget') continue;
      const config = loadConfig(project.path);
      const wtDir = config.worktree_dir || '.todomd/worktrees';
      const branchPrefix = config.branch_prefix || 'todomd/';
      const board = loadBoard(project.path);
      for (const card of board.cards) {
        if (IN_FLIGHT.has(card.status) && !children.has(runKey(project.name, card.id))) {
          await toNeedsHuman(project, card.id, card.status, 'orphaned_run', 'server restarted during a run');
          // a fresh retry must not build on the abandoned worktree's rejected commits
          await removeWorktree(project.path, path.join(project.path, wtDir, card.id), `${branchPrefix}${card.id}`);
        }
        if (card.triaged === 'running') {
          await patchFrontmatter(project.path, card.id, { triaged: '' }); // interrupted triage — retry via sweep
        }
      }
      await git(project.path, ['worktree', 'prune']);
      // Assigned cards (quota-parked, or approved just before a restart) have
      // no live run and no in-memory queue entry — re-drive them.
      enqueueAssigned(project);
    } catch { /* per-project, never fatal */ }
  }
}

// Only kill a persisted PID if it still looks like our claude/codex child —
// guards against the OS having reassigned that PID after a crash.
function isOurAgentProcess(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    // Only the EXECUTABLE basename — never a substring elsewhere in argv (so
    // `grep claude file` can't be matched). Erring toward not-killing is safe:
    // an un-killed orphan is still handled by the card → Needs Human path.
    const exe = path.basename((out.trim().split(/\s+/)[0] || ''));
    return exe === 'claude' || exe === 'codex';
  } catch {
    return false; // no such process, or ps unavailable → don't kill
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

export function hasLiveRun(projectName, id) {
  return children.has(runKey(projectName, id));
}

// Any live agent run for this project (used to refuse removing a busy project).
export function projectHasLiveRun(projectName) {
  const prefix = `${projectName}:`;
  for (const key of children.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

// Drop all in-memory state for a removed project so a same-named re-add starts clean.
export function forgetProject(projectName) {
  queues.delete(projectName);
  active.delete(projectName);
  quotaPaused.delete(projectName);
  const prefix = `${projectName}:`;
  for (const k of retryFindings.keys()) if (k.startsWith(prefix)) retryFindings.delete(k);
}

export function usage(projectName) {
  return { month_cost_usd: monthCost(), quota_paused: projectName ? quotaPaused.has(projectName) : quotaPaused.size > 0 };
}

export function resumeQueues(projects) {
  for (const p of projects) {
    if (!quotaPaused.has(p.name)) continue;
    quotaPaused.delete(p.name);
    enqueueAssigned(p); // re-enqueue parked cards through the normal queue
    processQueue(p);
  }
  if (quotaPaused.size === 0) setBanner('quota', null, null);
}
