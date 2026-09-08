import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { tmp, git, makeRepo } from './helpers.js';
import { detectWorktreeLinks, initProject, cmdDispatch, CMD_BUILD } from '../src/templates.js';
import { resourcesConfig, DEFAULT_RESOURCES_CONFIG } from '../src/resources.js';
import { normalizeConfig } from '../src/board.js';

test('CMD_BUILD rule 5 prohibits git add -A and committing under .todomd/', () => {
  assert.match(CMD_BUILD, /git add -A/, 'rule mentions git add -A');
  assert.ok(CMD_BUILD.includes('Never use `git add -A`') || CMD_BUILD.includes('never use `git add -A`'), 'rule prohibits git add -A');
  assert.match(CMD_BUILD, /\.todomd\//, 'rule mentions .todomd/');
  assert.ok(CMD_BUILD.includes('never add or commit anything under `.todomd/`'), 'rule prohibits committing .todomd/');
});

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
  assert.match(plan, /build_profile:/);
  assert.match(plan, /standard.*long.*split_required/s);
});

test('shipped config documents bounded standard and long Build profiles', () => {
  const repo = tmp('build-profiles');
  git(repo, ['init', '-q']);
  initProject(repo);
  const parsed = yaml.load(fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8'));
  assert.equal(parsed.build_continuation.max_slices, 3);
  assert.equal(parsed.build_continuation.budget_minutes, 60);
  assert.deepEqual(parsed.build_continuation.profiles.long, { max_slices: 6, budget_minutes: 120 });
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

test('shipped config scopes Plan Edit to the cards dir and drops Bash(node:*) from Build', () => {
  const repo = tmp('scoped-tools');
  git(repo, ['init', '-q']);
  initProject(repo);
  const cfg = fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8');
  // the plan agent runs in the MAIN checkout with acceptEdits — an unscoped
  // Edit could rewrite config.yml's verify_command (a CI shell command)
  assert.match(cfg, /allowed_tools: \[Read, Glob, Grep, "Edit\(\.todomd\/tasks\/\*\*\)"\]/,
    'Plan Edit is scoped to the cards dir');
  // Bash(node:*) auto-approves `node -e fs.writeFileSync(...)` anywhere — gone
  // (strip comments: the shipped file's own comment names the dropped rule)
  const active = cfg.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(active, /Bash\(node:\*\)/, 'Build ships no Bash(node:*)');
  assert.match(active, /Bash\(npm test:\*\)/, 'Build keeps the scoped test command');
  assert.match(active, /Bash\(git commit:\*\)/, 'Build keeps the scoped git rules');
});

test('initProject gitignores stolen-lock leftovers (.todomd/.lock.dead.*)', () => {
  const repo = tmp('lockdead');
  git(repo, ['init', '-q']);
  initProject(repo);
  const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(gi, /^\.todomd\/\.lock\.dead\.\*$/m);
});

test('shipped config.yml documents the resource monitor and matches resources.js defaults', () => {
  const repo = tmp('resources-config');
  git(repo, ['init', '-q']);
  initProject(repo);
  const cfg = fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8');
  assert.match(cfg, /^resources:$/m);
  const parsed = yaml.load(cfg);
  assert.ok(parsed.resources, 'config.yml parses a resources block');
  assert.deepEqual(resourcesConfig(parsed), DEFAULT_RESOURCES_CONFIG,
    'the shipped resources: values equal the documented defaults resourcesConfig() falls back to');
});

test('shipped config.yml documents the scheduler block; its 0-defaults are unlimited', () => {
  const repo = tmp('scheduler-config');
  git(repo, ['init', '-q']);
  initProject(repo);
  const cfg = fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8');
  assert.match(cfg, /^scheduler:$/m);
  const parsed = yaml.load(cfg);
  assert.ok(parsed.scheduler, 'config.yml parses a scheduler block');
  const normalized = normalizeConfig(parsed);
  // The shipped board only ever configures `concurrency` (no scheduler
  // overrides) — global and every column resolve to unlimited. None of them
  // default to this board's own `concurrency`: that value is combined via
  // Math.min across every OTHER registered project too, so defaulting a
  // column to it would make an unrelated project's default concurrency:1
  // silently throttle this board's Build column machine-wide. The "boards
  // that only set concurrency keep their effective Build parallelism"
  // guarantee is carried entirely by the separate, per-project concurrency
  // cap (never combined across projects) — see scheduler.js.
  assert.equal(normalized.scheduler.global, Infinity);
  assert.equal(normalized.scheduler.columns.Plan, 1);
  assert.equal(normalized.scheduler.columns.Triage, 1);
  assert.equal(normalized.scheduler.columns.Build, Infinity);
  assert.equal(normalized.scheduler.columns.CI, Infinity);
  assert.equal(normalized.scheduler.columns.Verify, Infinity);
});

test('normalizeConfig scheduler: an explicit global/column override is honored verbatim', () => {
  const normalized = normalizeConfig({ concurrency: 4, scheduler: { global: 2, columns: { Plan: 2, Triage: 3, Build: 3, CI: 1, Verify: 1 } } });
  assert.equal(normalized.scheduler.global, 2);
  assert.deepEqual(normalized.scheduler.columns, { Plan: 2, Triage: 3, Build: 3, CI: 1, Verify: 1 });
});

test('dispatch uses supervised transactions and refuses raw lock stealing', () => {
  const dispatch = cmdDispatch('npx', 'todomd');
  assert.match(dispatch, /budget-write \. -- \/bin\/sh/);
  assert.match(dispatch, /Never use raw mkdir\/rm locking, steal a lock by age/);
  assert.doesNotMatch(dispatch, /until mkdir|stat -[cf] %|rm -rf \.todomd\/\.lock/);
});
