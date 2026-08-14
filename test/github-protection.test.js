import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { evaluateTaskChanges } from '../.github/scripts/guard-todomd-tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, '.github/scripts/guard-todomd-tasks.mjs');

test('external pull requests cannot change tracked TODOMD task files', () => {
  const result = evaluateTaskChanges({
    changedPaths: ['src/server.js', '.todomd/tasks/task-0042-private-plan.md'],
    authorAssociation: 'CONTRIBUTOR',
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.taskPaths, ['.todomd/tasks/task-0042-private-plan.md']);
  assert.match(result.reason, /open an Issue instead/);
});

test('owners and collaborators may update task history while ordinary code PRs pass', () => {
  for (const authorAssociation of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(evaluateTaskChanges({
      changedPaths: ['.todomd/tasks/task-0001.md'], authorAssociation,
    }).allowed, true);
  }
  assert.equal(evaluateTaskChanges({
    changedPaths: ['src/server.js'], authorAssociation: 'NONE',
  }).allowed, true);
});

test('GitHub protection files own the board paths and provide an always-reporting check', () => {
  const owners = fs.readFileSync(path.join(ROOT, '.github/CODEOWNERS'), 'utf8');
  assert.match(owners, /^\/\.github\/\*\* @boneinis$/m);
  assert.match(owners, /^\/\.todomd\/tasks\/\*\* @boneinis$/m);
  assert.match(owners, /^\/\.todomd\/config\.yml @boneinis$/m);

  const workflow = yaml.load(fs.readFileSync(
    path.join(ROOT, '.github/workflows/protect-todomd-tasks.yml'), 'utf8',
  ));
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request, null, 'the required check runs for every pull request');
  assert.equal(workflow.jobs.guard.name, 'protect tracked board tasks');
  assert.equal(workflow.permissions.contents, 'read');
});

test('the executable guard compares the supplied Git SHAs and fails only the external task edit', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'todomd-pr-guard-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(repo, '.todomd/tasks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001.md'), 'initial\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(repo, '.todomd/tasks/task-0001.md'), 'external edit\n');
  git(['add', '.']);
  git(['commit', '-qm', 'change task']);
  const headSha = git(['rev-parse', 'HEAD']);
  const run = (association) => spawnSync(process.execPath, [GUARD], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_BASE_SHA: baseSha,
      GITHUB_HEAD_SHA: headSha,
      GITHUB_AUTHOR_ASSOCIATION: association,
    },
  });

  const external = run('CONTRIBUTOR');
  assert.equal(external.status, 1);
  assert.match(external.stderr, /Owner-managed TODOMD tasks/);
  assert.match(external.stderr, /task-0001\.md/);

  const owner = run('OWNER');
  assert.equal(owner.status, 0);
  assert.match(owner.stdout, /Trusted owner task-file change/);
});
