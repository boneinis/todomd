import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeRepo,
  writeCard,
  isolateHome,
  useFakeAgent,
  clearFakeAgent,
  until,
  tmp,
  git,
  sleep,
  BUDGET,
} from './helpers.js';
import { readCard, patchFrontmatter, loadBoard, createCard } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';
import {
  isEpicCard,
  resolveEpicBuildMode,
  resolveCardModes,
  epicActiveChildren,
  epicMaterializedChildren,
  cardInconsistency,
} from '../src/build-mode.js';
import {
  claudeTeamworkInstructions,
  codexTeamworkInstructions,
  runStage,
} from '../src/runner.js';

/* ── Finding 1: Explicit chunk mode prevents parent epic from building alongside children ── */

test('Finding 1: Epic with chunks mode is blocked from Build as epic_tracker even with workflow: teamwork', async () => {
  isolateHome();
  scheduler.resetState();
  const marker = path.join(tmp('finding1-hang'), 'build');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: 'build', hang_marker: marker });
  pipeline.init({ broadcast: () => {} });
  const repo = makeRepo();
  const p = { name: path.basename(repo), path: repo };

  try {
    // Write parent epic with workflow: teamwork and explicit epic_build_mode: chunks
    writeCard(repo, 'epic-0001', {
      status: 'Queue',
      extra: 'epic: true\nworkflow: teamwork\nepic_build_mode: chunks\n',
      title: 'Decomposed Teamwork Epic',
    });

    // Write child card attached to this epic
    writeCard(repo, 'task-0002', {
      status: 'Planned',
      extra: 'parent: epic-0001\n',
      title: 'Child Task 1',
    });

    const cards = loadBoard(repo).cards;
    const parentCard = cards.find((c) => c.id === 'epic-0001');
    const childCard = cards.find((c) => c.id === 'task-0002');

    // Modes resolution
    const parentModes = resolveCardModes(parentCard);
    assert.equal(parentModes.isEpic, true);
    assert.equal(parentModes.epicBuildMode, 'chunks');
    assert.equal(parentModes.buildsDirectly, false);

    // Queue kicker must advance child to Queue/Build, but keep parent blocked as epic_tracker
    const kick = await pipeline.kickQueue(p);
    assert.equal(kick.ok, true);

    const parentResult = kick.cards.find((c) => c.id === 'epic-0001');
    assert.ok(parentResult, 'epic card must be evaluated in queue');
    assert.equal(parentResult.enqueued, false);
    assert.equal(parentResult.code, 'epic_tracker');
    assert.equal(scheduler.isQueued(p.name, 'epic-0001'), false, 'Parent epic must never be queued in scheduler');

    // Child must have been advanced to Queue and enqueued for Build
    const updatedChild = readCard(repo, 'task-0002');
    assert.equal(updatedChild.data.status, 'Queue');
    assert.ok(
      scheduler.isQueued(p.name, 'task-0002') || pipeline.hasLiveRun(p.name, 'task-0002'),
      'Child must be submitted to build scheduler'
    );
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('Finding 1: Unified teamwork epic is blocked from Build when active children exist', async () => {
  isolateHome();
  scheduler.resetState();
  pipeline.init({ broadcast: () => {} });
  const repo = makeRepo();
  const p = { name: path.basename(repo), path: repo };

  try {
    // Epic in teamwork mode in Planned stage
    writeCard(repo, 'epic-0010', {
      status: 'Planned',
      extra: 'epic: true\nepic_build_mode: teamwork\n',
      title: 'Unified Epic with Active Child',
    });

    writeCard(repo, 'task-0011', {
      status: 'Build',
      extra: 'parent: epic-0010\n',
      title: 'Active Child',
    });

    const epicCard = readCard(repo, 'epic-0010');

    // approvalEligibility must reject approving the epic while child is active
    const eligibility = await pipeline.approvalEligibility(p, epicCard);
    assert.equal(eligibility.ok, false);
    assert.equal(eligibility.code, 'epic_active_children');

    // Even if forcibly placed in Queue, kickQueue must also report epic_active_children blocker
    await patchFrontmatter(repo, 'epic-0010', { status: 'Queue' });
    const kick = await pipeline.kickQueue(p);
    const epicResult = kick.cards.find((c) => c.id === 'epic-0010');
    assert.equal(epicResult.code, 'epic_active_children');
    assert.equal(epicResult.enqueued, false);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('Finding 1: convertEpicMode safely converts modes and handles active children', async () => {
  isolateHome();
  scheduler.resetState();
  pipeline.init({ broadcast: () => {} });
  const repo = makeRepo();
  const p = { name: path.basename(repo), path: repo };

  writeCard(repo, 'epic-0020', {
    status: 'Planned',
    extra: 'epic: true\nepic_build_mode: chunks\n',
    title: 'Converting Epic',
  });

  writeCard(repo, 'task-0021', {
    status: 'Planned',
    extra: 'parent: epic-0020\n',
    title: 'Child To Be Archived',
  });

  // Attempt conversion to teamwork without archiveChildren flag must fail
  const blocked = await pipeline.convertEpicMode(p, 'epic-0020', 'teamwork', { archiveChildren: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'epic_has_active_children');

  // Conversion with archiveChildren: true must archive child and update epic mode
  const converted = await pipeline.convertEpicMode(p, 'epic-0020', 'teamwork', { archiveChildren: true });
  assert.equal(converted.ok, true);
  assert.equal(converted.targetMode, 'teamwork');
  assert.deepEqual(converted.archivedChildren, ['task-0021']);

  const updatedEpic = readCard(repo, 'epic-0020');
  assert.equal(updatedEpic.data.epic_build_mode, 'teamwork');
  assert.equal(updatedEpic.data.epic_split, false);

  const updatedChild = readCard(repo, 'task-0021');
  assert.ok(updatedChild.data.archived);

  pipeline.forgetProject(p.name);
  await pipeline.killAllChildren({ graceMs: 100 });
  clearFakeAgent();
  scheduler.resetState();
});

/* ── Finding 2: Target base configuration preserved across lifecycle ── */

test('Finding 2: Target base config preserved during execConfig and rejects invalid base', async () => {
  isolateHome();
  const repo = makeRepo();

  // Create a base branch with specific verify_command
  git(repo, ['checkout', '-b', 'release-base']);
  const baseConfig = 'verify_command: node test/base-check.test.js\nci:\n  execution: local\n';
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'), baseConfig);
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'committed base config']);
  const baseSha = git(repo, ['rev-parse', 'release-base']);

  // Now switch to main (peer branch) with a completely different / conflicting CI config
  git(repo, ['checkout', 'main']);
  const peerConfig = 'verify_command: node test/peer-different.test.js\nci:\n  execution: remote\n  quick: fail\n';
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'), peerConfig);
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'peer differing config on main']);

  // execConfig with base_branch must read release-base's config, NOT main's!
  const resolvedBaseConfig = await pipeline.execConfig(repo, 'release-base');
  assert.equal(resolvedBaseConfig.verify_command, 'node test/base-check.test.js');
  assert.equal(resolvedBaseConfig.ci.execution, 'local');

  // execConfig without base reads root HEAD (main)
  const resolvedHeadConfig = await pipeline.execConfig(repo);
  assert.equal(resolvedHeadConfig.verify_command, 'node test/peer-different.test.js');
  assert.equal(resolvedHeadConfig.ci.execution, 'remote');

  // execConfig with invalid/non-existent base ref must throw error, never fall back to HEAD!
  await assert.rejects(
    async () => pipeline.execConfig(repo, 'non-existent-base-branch'),
    /invalid target base/
  );
});

test('Finding 2: execConfig returns safe defaults when target base has no committed config', async () => {
  isolateHome();
  const repo = makeRepo();

  // Create branch without .todomd/config.yml
  git(repo, ['checkout', '-b', 'bare-base']);
  if (fs.existsSync(path.join(repo, '.todomd/config.yml'))) {
    git(repo, ['rm', '.todomd/config.yml']);
    git(repo, ['commit', '-qm', 'remove config on bare-base']);
  }

  // Switch to main with custom config
  git(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'), 'verify_command: npm test\n');
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'config on main']);

  // execConfig on bare-base must return default normalized config, NOT main's!
  const bareConfig = await pipeline.execConfig(repo, 'bare-base');
  assert.equal(bareConfig.verify_command || '', '');
  assert.notEqual(bareConfig.verify_command, 'npm test');
  assert.equal(bareConfig.ci.execution, 'local');
});

/* ── Finding 3: Unified teamwork mode instructions and runner integration ── */

test('Finding 3: Multi-agent teamwork instructions are read-only for Plan and Verify stages', () => {
  // Claude teamwork instructions
  const claudePlan = claudeTeamworkInstructions({ stage: 'Plan' });
  assert.match(claudePlan, /Plan Stage/);
  assert.match(claudePlan, /strictly read-only/);
  assert.doesNotMatch(claudePlan, /Implement the solution/);

  const claudeVerify = claudeTeamworkInstructions({ stage: 'Verify' });
  assert.match(claudeVerify, /Review Stage/);
  assert.match(claudeVerify, /strictly read-only/);
  assert.doesNotMatch(claudeVerify, /Run the project's verification and test suites/);

  const claudeBuild = claudeTeamworkInstructions({ stage: 'Build' });
  assert.match(claudeBuild, /Implementation Specialist/);

  // Codex teamwork instructions
  const codexPlan = codexTeamworkInstructions({ stage: 'Plan' });
  assert.match(codexPlan, /Plan Stage/);
  assert.match(codexPlan, /read-only/);
  assert.doesNotMatch(codexPlan, /Make precise edits/);

  const codexVerify = codexTeamworkInstructions({ stage: 'Verify' });
  assert.match(codexVerify, /Review Stage/);
  assert.match(codexVerify, /read-only/);

  const codexBuild = codexTeamworkInstructions({ stage: 'Build' });
  assert.match(codexBuild, /Implementation Specialist/);
});

test('Finding 3: runClaude populates diagnostic including teamwork and finalMessage', async () => {
  isolateHome();
  const dir = tmp('claude-diag');
  const argvLog = path.join(dir, 'argv.jsonl');
  useFakeAgent({ build: 'good', argv_log: argvLog });

  const run = runStage({
    vendor: 'claude',
    stage: 'Build',
    cwd: dir,
    prompt: 'Implement feature',
    teamwork: true,
  });

  const result = await run.done;
  assert.ok(result.diagnostic, 'runStage result must contain diagnostic');
  assert.equal(result.diagnostic.teamwork, true);
  assert.equal(result.teamwork, true);
  assert.equal(result.diagnostic.exitCode, 0);

  clearFakeAgent();
});

/* ── Finding 4: Correct routing persistence and drawer isolation ── */

test('Finding 4: createCard and cardInconsistency protect non-epic cards from epic_build_mode', async () => {
  const repo = makeRepo();

  // Creating an ordinary non-epic card with epic_build_mode in input fields
  const ordinaryResult = await createCard(repo, {
    title: 'Regular task',
    epic: false,
    epic_build_mode: 'chunks',
  });
  assert.equal(ordinaryResult.ok, true);

  const ordinaryCard = readCard(repo, ordinaryResult.id);
  assert.equal(ordinaryCard.data.epic_build_mode, undefined, 'Ordinary card must not have epic_build_mode');
  assert.equal(cardInconsistency(ordinaryCard), null);

  // Creating an epic card with epic_build_mode
  const epicResult = await createCard(repo, {
    title: 'Epic task',
    epic: true,
    epic_build_mode: 'chunks',
  });
  assert.equal(epicResult.ok, true);

  const epicCard = readCard(repo, epicResult.id);
  assert.equal(epicCard.data.epic_build_mode, 'chunks', 'Epic card must store epic_build_mode');
  assert.equal(cardInconsistency(epicCard), null);

  // Pre-existing corrupted ordinary card with epic_build_mode: chunks
  await patchFrontmatter(repo, ordinaryResult.id, { epic_build_mode: 'chunks' });
  const corruptedCard = readCard(repo, ordinaryResult.id);
  const inconsistency = cardInconsistency(corruptedCard);
  assert.ok(inconsistency);
  assert.equal(inconsistency.code, 'non_epic_has_build_mode');
});
