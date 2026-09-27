import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, useFakeAgent, clearFakeAgent, until, git, BUDGET } from './helpers.js';
import { seedDelivery } from './delivery-fixture.js';
import { readCard, loadBoard, patchFrontmatter } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';

function fixture(t) {
  isolateHome(); pipeline.init({ broadcast() {} });
  const repo = makeRepo(), project = { path: repo, name: path.basename(repo) };
  t.after(async () => { pipeline.forgetProject(project.name); await pipeline.killAllChildren({ graceMs: 100 }); scheduler.resetState(); clearFakeAgent(); });
  return { repo, project };
}

for (const [name, extra, expectedMode, count] of [
  ['canonical unified mode beats legacy split', 'epic: true\nepic_build_mode: teamwork\nepic_split: true\n', 'teamwork', 0],
  ['legacy unified mode is honored', 'epic: true\nepic_split: false\n', 'teamwork', 0],
  ['explicit chunks beat delegation', 'epic: true\nepic_build_mode: chunks\nworkflow: teamwork\n', 'chunks', 2],
  ['ordinary teamwork ignores stale epic mode', 'workflow: teamwork\nepic_build_mode: chunks\n', 'chunks', 0],
]) test(`Plan: ${name}`, async t => {
  const { repo, project } = fixture(t); useFakeAgent({ chunks: 2 });
  writeCard(repo, 'task-0001', { extra });
  assert.equal((await pipeline.humanMove(project, 'task-0001', 'Plan')).ok, true);
  await until(() => readCard(repo, 'task-0001').data.status === 'Planned', { timeout: BUDGET.stage });
  assert.equal(readCard(repo, 'task-0001').data.epic_build_mode, expectedMode);
  assert.equal(loadBoard(repo).cards.filter(c => c.parent === 'task-0001').length, count);
  if (!count) assert.match(readCard(repo, 'task-0001').body, /Milestone 2/);
});

test('conversion rejects live parents, owned children and preserved candidates without partial changes', async t => {
  const { repo, project } = fixture(t);
  writeCard(repo, 'task-0001', { status: 'Build', extra: 'epic: true\nepic_build_mode: teamwork\n' });
  assert.equal((await pipeline.convertEpicMode(project, 'task-0001', 'chunks')).error, 'epic_in_flight');
  await patchFrontmatter(repo, 'task-0001', { status: 'Planned', epic_build_mode: 'chunks' });
  writeCard(repo, 'task-0002', { status: 'Planned', extra: 'parent: task-0001\n' });
  writeCard(repo, 'task-0003', { status: 'Needs Human', extra: 'parent: task-0001\nworktree: todomd/task-0003\n' });
  assert.equal((await pipeline.convertEpicMode(project, 'task-0001', 'teamwork', { archiveChildren: true })).error, 'child_has_candidate');
  assert.ok(!readCard(repo, 'task-0002').data.archived);
  await patchFrontmatter(repo, 'task-0003', { worktree: '' });
  seedDelivery(repo, 'task-0003', { leased: true });
  assert.equal((await pipeline.convertEpicMode(project, 'task-0001', 'teamwork', { archiveChildren: true })).code, 'delivery_execution_owned');
  assert.ok(!readCard(repo, 'task-0002').data.archived);
  assert.equal(readCard(repo, 'task-0001').data.epic_build_mode, 'chunks');
  assert.equal((await pipeline.convertEpicMode(project, 'task-0001', 'teamwork', { archiveChildren: 'false' })).error, 'invalid_archive_children');
});

test('target-base CI and Verify survive a conflicting peer HEAD through verification retry', async t => {
  const { repo, project } = fixture(t); useFakeAgent();
  const cfg = path.join(repo, '.todomd/config.yml');
  git(repo, ['checkout', '-b', 'release-base']);
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('command: todomd-verify', 'command: todomd-verify\n    teamwork: true'));
  git(repo, ['add', '.todomd/config.yml']); git(repo, ['commit', '-qm', 'target verification policy']);
  git(repo, ['checkout', '-b', 'peer']);
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('verify_command: node --version', 'verify_command: exit 99').replace('model: haiku', 'agent: unsupported-vendor'));
  git(repo, ['add', '.todomd/config.yml']); git(repo, ['commit', '-qm', 'conflicting peer policy']);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'base_branch: release-base\n' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Implementation Plan\n', '## Implementation Plan\n\nImplement the calculation.\n'));
  assert.equal((await pipeline.humanMove(project, 'task-0001', 'Queue')).ok, true);
  await until(() => readCard(repo, 'task-0001').data.status === 'Needs Human', { timeout: BUDGET.chain });
  await until(() => !pipeline.hasLiveRun(project.name, 'task-0001'), { timeout: BUDGET.chain });
  const candidate = readCard(repo, 'task-0001');
  assert.equal(candidate.data.needs_human_reason, 'base_branch_moved');
  assert.equal(candidate.data.base_branch, 'release-base');
  assert.ok(candidate.data.worktree);
  assert.equal((await pipeline.retryVerification(project, 'task-0001')).ok, false, 'retry preserves the wrong-branch guard');
  const preserved = readCard(repo, 'task-0001').raw;
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '--allow-empty', '-qm', 'preserve candidate metadata']);
  git(repo, ['checkout', 'release-base']);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, preserved);
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '-qm', 'restore candidate metadata on target']);
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('verify_command: node --version', 'verify_command: exit 98'));
  assert.equal((await pipeline.retryVerification(project, 'task-0001')).ok, true);
  await until(() => !pipeline.hasLiveRun(project.name, 'task-0001'), { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.status, 'Done');
  assert.equal(git(repo, ['branch', '--show-current']), 'release-base');
});
