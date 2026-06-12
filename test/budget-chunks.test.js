import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, isolateHome, tmp, git } from './helpers.js';
import { readCard, parseChunks, moveCard } from '../src/board.js';
import { initProject } from '../src/templates.js';
import { materializeChunks, advanceEpicChildren } from '../src/chunks.js';
import * as pipeline from '../src/pipeline.js';

const noop = () => {};
const project = (repo) => ({ name: path.basename(repo), path: repo });
const status = (repo, id) => readCard(repo, id).data.status;

function budgetRepo() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}

function dispatchPrompt() {
  const repo = tmp('disp-c');
  git(repo, ['init', '-q']);
  initProject(repo);
  return fs.readFileSync(path.join(repo, '.claude/commands/todomd-dispatch.md'), 'utf8');
}

const CHUNKS_YAML = `\`\`\`yaml
- title: chunk one
  plan: |
    1. do something
  criteria:
    - something done
- title: chunk two
  plan: |
    1. do another thing
  criteria:
    - another thing done
\`\`\``;

function writeEpicCard(repo, id) {
  const file = path.join(repo, '.todomd/tasks', `${id}-card.md`);
  fs.writeFileSync(file,
    `---\nid: ${id}\ntitle: Epic card\nstatus: Review\ntype: module\npriority: low\n` +
    `labels: []\ndependencies: []\ncreated_date: 2026-01-01\nsource: ui\nagent: claude\n` +
    `verification: { attempts: 0, max_attempts: 3, last_verdict: }\n---\n\n` +
    `## Description\n\nEpic card\n\n## Acceptance Criteria\n\n- [ ] done\n\n` +
    `## Chunks\n\n${CHUNKS_YAML}\n\n## Implementation Plan\n\n## Run Log\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `add ${id}`]);
}

/* ── A. CMD_DISPATCH prose assertions ── */

test('budget: CMD_DISPATCH instructs fanout after split plan', () => {
  const prompt = dispatchPrompt();
  assert.ok(prompt.includes('fanout'), 'dispatch prompt must mention fanout');
});

test('budget: CMD_DISPATCH skips epic tracker cards', () => {
  const prompt = dispatchPrompt();
  assert.ok(prompt.includes('epic: true'), 'dispatch prompt must contain guard on epic: true');
});

test('budget: CMD_DISPATCH cascades via todomd advance', () => {
  const prompt = dispatchPrompt();
  assert.ok(prompt.includes('advance'), 'dispatch prompt must mention advance');
});

/* ── B. humanMove epic approval in budget mode ── */

test('budget: humanMove epic approval moves chunk-1 to Queue', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  const p = project(repo);

  writeEpicCard(repo, 'task-epic');
  const card = readCard(repo, 'task-epic');
  const chunks = parseChunks(card.body || '');
  const childIds = await materializeChunks(repo, 'task-epic', chunks);
  assert.equal(childIds.length, 2);

  // epic is now Planned with epic:true — human approves it
  const result = await pipeline.humanMove(p, 'task-epic', 'Queue');
  assert.equal(result.ok, true);

  assert.equal(status(repo, childIds[0]), 'Queue', 'chunk-1 should be Queue after epic approval');
  assert.equal(status(repo, childIds[1]), 'Planned', 'chunk-2 should remain Planned');
});

/* ── C. advanceEpicChildren cascade ── */

test('budget: advanceEpicChildren cascades to next chunk', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  const p = project(repo);

  writeEpicCard(repo, 'task-epic3');
  const card = readCard(repo, 'task-epic3');
  const chunks = parseChunks(card.body || '');
  const childIds = await materializeChunks(repo, 'task-epic3', chunks);
  assert.equal(childIds.length, 2);

  // approve epic → chunk-1 goes to Queue
  await pipeline.humanMove(p, 'task-epic3', 'Queue');
  assert.equal(status(repo, childIds[0]), 'Queue');
  assert.equal(status(repo, childIds[1]), 'Planned');

  // simulate chunk-1 finishing
  await moveCard(repo, childIds[0], 'Done', { reason: 'test' });

  const moved = await advanceEpicChildren(repo, 'task-epic3');
  assert.ok(moved.includes(childIds[1]), 'chunk-2 should be in the moved list');
  assert.equal(status(repo, childIds[1]), 'Queue', 'chunk-2 should be Queue after advance');
});

/* ── D. budget-mode epic auto-completion ── */

test('budget: advanceEpicChildren auto-completes epic when all chunks are Done', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  const p = project(repo);

  writeEpicCard(repo, 'task-epic5');
  const card = readCard(repo, 'task-epic5');
  const chunks = parseChunks(card.body || '');
  const childIds = await materializeChunks(repo, 'task-epic5', chunks);
  assert.equal(childIds.length, 2);

  // approve epic → chunk-1 goes to Queue
  await pipeline.humanMove(p, 'task-epic5', 'Queue');

  // simulate both chunks finishing
  await moveCard(repo, childIds[0], 'Done', { reason: 'test' });
  await moveCard(repo, childIds[1], 'Done', { reason: 'test' });

  await advanceEpicChildren(repo, 'task-epic5');
  assert.equal(status(repo, 'task-epic5'), 'Done', 'epic should be Done when all chunks are complete');
});
