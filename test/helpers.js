import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let counter = 0;

// A fresh temp dir, isolated TODOMD_HOME, auto-cleaned.
export function tmp(label = 't') {
  const dir = path.join(os.tmpdir(), `todomd-test-${label}-${process.pid}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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
  fs.writeFileSync(path.join(repo, '.gitignore'), '.todomd/worktrees/\n.todomd/runs/\nnode_modules/\n');

  fs.mkdirSync(path.join(repo, '.todomd/tasks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'),
    `columns: [Review, Plan, Planned, Assigned, Build, Verify, Needs Human, Done]\n` +
    `mode: launcher\nverify_command: npm test\nmax_attempts: 3\nconcurrency: 1\n` +
    `triage:\n  enabled: ${triage}\n  model: sonnet\n` +
    `stages:\n  Plan: { command: todomd-plan, model: sonnet }\n` +
    `  Build: { command: todomd-build, model: sonnet }\n` +
    `  Verify: { command: todomd-verify, model: haiku }\n`);
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

// Poll a predicate until true or timeout.
export async function until(fn, { timeout = 8000, step = 40 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('until() timed out');
}
