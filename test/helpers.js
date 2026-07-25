import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let counter = 0;

// A fresh temp dir, isolated TODOMD_HOME, auto-cleaned when the test process exits.
const tmpDirs = [];
export function tmp(label = 't') {
  const dir = path.join(os.tmpdir(), `todomd-test-${label}-${process.pid}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
// one synchronous sweep at exit removes every temp dir this run created
process.once('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

export function isolateHome() {
  const home = tmp('home');
  process.env.TODOMD_HOME = home;
  return home;
}

export function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

// A temp git repo with a minimal Node test project + a todomd board.
export function makeRepo({ triage = false } = {}) {
  const repo = tmp('repo');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@todomd.local']);
  git(repo, ['config', 'user.name', 'todomd-test']);
  fs.writeFileSync(path.join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/calc.js'), 'export function sum(a, b) { return a + b; }\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.todomd/worktrees/\n.todomd/runs/\n.todomd/.lock/\nnode_modules/\n');

  fs.mkdirSync(path.join(repo, '.todomd/tasks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'),
    `columns: [Review, Plan, Planned, Queue, Build, Verify, Needs Human, Done]\n` +
    `mode: launcher\nverify_command: npm test\nmax_attempts: 3\nconcurrency: 1\n` +
    `default_agent: claude\n` +
    `triage:\n  enabled: ${triage}\n  model: sonnet\n` +
    `stages:\n` +
    `  Plan:\n    command: todomd-plan\n    model: sonnet\n` +
    `  Build:\n    command: todomd-build\n    model: sonnet\n` +
    `  Verify:\n    command: todomd-verify\n    model: haiku\n`);
  // pipeline commands referenced by name (the fake agent ignores their content)
  fs.mkdirSync(path.join(repo, '.claude/commands'), { recursive: true });
  for (const c of ['plan', 'build', 'verify', 'triage', 'dispatch']) {
    fs.writeFileSync(path.join(repo, `.claude/commands/todomd-${c}.md`), `---\n---\nstub $ARGUMENTS\n`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'baseline']);
  return repo;
}

// Write a card file and return its id.
export function writeCard(repo, id, { status = 'Review', title = 'Test card', body = '', criteria = ['done'], deps = [], extra = '' } = {}) {
  const file = path.join(repo, '.todomd/tasks', `${id}-card.md`);
  fs.writeFileSync(file,
    `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ntype: module\npriority: low\n` +
    `labels: []\ndependencies: [${deps.join(', ')}]\ncreated_date: 2026-01-01\nsource: ui\nagent: claude\n` +
    `verification: { attempts: 0, max_attempts: 3, last_verdict: }\n${extra}---\n\n` +
    `## Description\n\n${body || title}\n\n## Acceptance Criteria\n\n` +
    criteria.map((c) => `- [ ] ${c}`).join('\n') + `\n\n## Implementation Plan\n\n## Run Log\n`);
  return id;
}

// Point the runner at the deterministic fake agent.
export function useFakeAgent(opts = {}) {
  process.env.TODOMD_CLAUDE_BIN = path.join(ROOT, 'test/fixtures/fake-agent.js');
  for (const [k, v] of Object.entries(opts)) process.env[`FAKE_${k.toUpperCase()}`] = String(v);
}

export function clearFakeAgent() {
  delete process.env.TODOMD_CLAUDE_BIN;
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_')) delete process.env[k];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Three budgets instead of a ladder of magic numbers. Pick by what you're
// waiting for, not by what happened to pass on the machine you wrote it on.
export const BUDGET = {
  quick: 12_000,  // a board mutation lands, a file appears, a flag flips
  stage: 20_000,  // one agent stage finishes (plan, build, verify)
  chain: 40_000,  // a whole build→verify→merge, or a cancel plus its re-drive
};

// These tests spawn git and agent CLIs, so their wall-clock cost tracks how
// oversubscribed the machine is — measured on this suite: a median 19.9x and a
// worst 45.8x stretch at load 120 on 10 cores. Fixed deadlines calibrated on an
// idle box therefore turn any busy machine into a wave of identical timeouts,
// which is worse than useless when `npm test` is also todomd's verify_command:
// it reads as "your change broke the pipeline". Scale the budget by load, the
// way Node's own suite does with common.platformTimeout().
// TODOMD_TEST_TIMEOUT_SCALE overrides (CI can pin it); loadavg is 0 on Windows,
// which floors the scale at 1 — the original behavior.
const CORES = os.cpus().length || 1;
export function timeoutScale() {
  const override = Number(process.env.TODOMD_TEST_TIMEOUT_SCALE);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.min(12, Math.max(1, os.loadavg()[0] / CORES));
}

// Poll a predicate until it returns truthy, or the (scaled) budget runs out.
export async function until(fn, { timeout = BUDGET.quick, step = 40, label = '' } = {}) {
  const scale = timeoutScale();
  const budget = Math.round(timeout * scale);
  const started = Date.now();
  let last, lastErr;
  while (Date.now() - started < budget) {
    // A predicate that throws means "not yet", not "fail the test": the card it
    // reads may be mid-write, or the server may not be listening yet. A
    // persistent error still surfaces — it's reported in the timeout below.
    try {
      const v = await fn();
      if (v) return v;
      last = v; lastErr = null;
    } catch (e) { lastErr = e; }
    await sleep(step);
  }
  // The old message was just 'until() timed out', which made every failure in a
  // run indistinguishable — with no hint of what was being waited for.
  const what = label || String(fn).replace(/\s+/g, ' ').replace(/^\(\)\s*=>\s*/, '').slice(0, 140);
  const budgetNote = scale > 1 ? `${budget}ms (${timeout}ms x${scale.toFixed(1)} for load)` : `${budget}ms`;
  const outcome = lastErr
    ? `last threw: ${lastErr.message}`
    : `last value: ${JSON.stringify(last) ?? String(last)}`;
  throw new Error(`until() gave up after ${Date.now() - started}ms of ${budgetNote} — waiting for: ${what} — ${outcome}`);
}
