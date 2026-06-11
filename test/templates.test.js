import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, git, makeRepo } from './helpers.js';
import { detectWorktreeLinks, initProject } from '../src/templates.js';

test('detectWorktreeLinks: always node_modules; adds present+gitignored deps, skips tracked ones', () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');         // gitignored → worktree needs it
  fs.writeFileSync(path.join(repo, '.npmrc'), 'registry=x\n');     // NOT ignored → already in the worktree
  const links = detectWorktreeLinks(repo);
  assert.ok(links.includes('node_modules'), 'node_modules is always linked');
  assert.ok(links.includes('.env'), 'a present, gitignored dep is auto-linked');
  assert.ok(!links.includes('.npmrc'), 'a tracked (non-ignored) file is not linked');
});

test('initProject ships the PLAN command with the sequential-chunks contract', () => {
  const repo = tmp('plan-cmd');
  git(repo, ['init', '-q']);
  initProject(repo);
  const plan = fs.readFileSync(path.join(repo, '.claude/commands/todomd-plan.md'), 'utf8');
  assert.match(plan, /## Chunks/);
  assert.match(plan, /sequential chunks/i);
  assert.match(plan, /yaml/); // the fenced block format the orchestrator parses
});

test('initProject injects the detected gitignored deps into a fresh config.yml', () => {
  const repo = tmp('init');
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
  const created = initProject(repo);
  const cfg = fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8');
  assert.match(cfg, /worktree_link: \[node_modules, \.env\]/);
  assert.ok(created.some((c) => c.includes('worktree_link')), 'init surfaces the auto-link to the user');
});
