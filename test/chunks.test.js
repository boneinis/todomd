import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, isolateHome, git } from './helpers.js';
import { readCard, parseChunks, moveCard, setArchived } from '../src/board.js';
import { materializeChunks, advanceEpicChildren, calculateEpicRollup } from '../src/chunks.js';

const status = (repo, id) => readCard(repo, id).data.status;

function writeEpicCard(repo, id, chunksYaml) {
  const file = path.join(repo, '.todomd/tasks', `${id}-card.md`);
  fs.writeFileSync(file,
    `---\nid: ${id}\ntitle: Epic card\nstatus: Review\ntype: module\npriority: low\n` +
    `labels: []\ndependencies: []\ncreated_date: 2026-01-01\nsource: ui\nagent: claude\n` +
    `verification: { attempts: 0, max_attempts: 3, last_verdict: }\n---\n\n` +
    `## Description\n\nEpic card\n\n## Acceptance Criteria\n\n- [ ] done\n\n` +
    `## Chunks\n\n${chunksYaml}\n\n## Implementation Plan\n\n## Run Log\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `add ${id}`]);
}

const TWO_CHUNKS_YAML = `\`\`\`yaml
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

const THREE_CHUNKS_YAML = `\`\`\`yaml
- title: chunk one
  plan: |
    1. first thing
  criteria:
    - first done
- title: chunk two
  plan: |
    1. second thing
  criteria:
    - second done
- title: chunk three
  plan: |
    1. third thing
  criteria:
    - third done
\`\`\``;

/* ── 1. archived child is excluded from completion check ── */

test('advanceEpicChildren: archived non-Done child is excluded — epic still completes', async () => {
  isolateHome();
  const repo = makeRepo();

  writeEpicCard(repo, 'task-arch', TWO_CHUNKS_YAML);
  const card = readCard(repo, 'task-arch');
  const chunks = parseChunks(card.body || '');
  const childIds = await materializeChunks(repo, 'task-arch', chunks);
  assert.equal(childIds.length, 2);

  // move chunk-1 to Done, archive chunk-2 (still Planned)
  await moveCard(repo, childIds[0], 'Done', { reason: 'test' });
  await setArchived(repo, childIds[1], true);

  // epic is at Planned — within the completable set
  assert.equal(status(repo, 'task-arch'), 'Planned');

  await advanceEpicChildren(repo, 'task-arch');

  // archived child excluded → only chunk-1 counted → all visible children Done → epic completes
  assert.equal(status(repo, 'task-arch'), 'Done', 'epic should be Done when only non-archived children are Done');
});

/* ── 2. epic already in Review — advanceEpicChildren must not move it to Done ── */

test('advanceEpicChildren: does not complete a withdrawn (Review) epic', async () => {
  isolateHome();
  const repo = makeRepo();

  writeEpicCard(repo, 'task-review', TWO_CHUNKS_YAML);
  const card = readCard(repo, 'task-review');
  const chunks = parseChunks(card.body || '');
  const childIds = await materializeChunks(repo, 'task-review', chunks);
  assert.equal(childIds.length, 2);

  // move both children to Done
  await moveCard(repo, childIds[0], 'Done', { reason: 'test' });
  await moveCard(repo, childIds[1], 'Done', { reason: 'test' });

  // human moves the epic back to Review (intentionally)
  await moveCard(repo, 'task-review', 'Review', { reason: 'needs rework' });
  assert.equal(status(repo, 'task-review'), 'Review');

  await advanceEpicChildren(repo, 'task-review');

  assert.equal(status(repo, 'task-review'), 'Review', 'epic in Review must not be auto-completed');
});

/* ── 3. materializeChunks aborts cleanly when chunk 2 of 3 fails ── */

test('materializeChunks: createCard failure on chunk 2 rolls back chunk 1 and returns []', async () => {
  isolateHome();
  const repo = makeRepo();

  writeEpicCard(repo, 'task-fail', THREE_CHUNKS_YAML);
  const epicBefore = readCard(repo, 'task-fail');
  assert.ok(!epicBefore.data.epic, 'epic flag should not be set before materialize');

  // count existing task files before the call
  const taskDir = path.join(repo, '.todomd/tasks');
  const filesBefore = fs.readdirSync(taskDir).length;

  // inject a bad chunk (empty title) as chunk 2 to trigger createCard failure
  const chunks = [
    { title: 'valid chunk one', plan: '1. do it\n', criteria: ['done one'] },
    { title: '', plan: '1. do it\n', criteria: ['done two'] }, // empty title → createCard fails
    { title: 'valid chunk three', plan: '1. do it\n', criteria: ['done three'] },
  ];

  const ids = await materializeChunks(repo, 'task-fail', chunks);

  assert.deepEqual(ids, [], 'materializeChunks must return [] on failure');

  // no child cards should remain on disk
  const filesAfter = fs.readdirSync(taskDir).length;
  assert.equal(filesAfter, filesBefore, 'no new task files should remain after rollback');

  // epic frontmatter must be unchanged (no epic:true, no children)
  const epicAfter = readCard(repo, 'task-fail');
  assert.ok(!epicAfter.data.epic, 'epic flag must not be set after aborted materialize');
  assert.ok(!epicAfter.data.children, 'children must not be set after aborted materialize');
});

/* ── 4. calculateEpicRollup returns string epic_id and calculates canonical state ── */

test('calculateEpicRollup: returns string epic_id when invoked with cardObj and allCards array', () => {
  const epicCard = { id: 'epic-100', title: 'Major Epic', epic: true };
  const child1 = { id: 'chunk-1', parent: 'epic-100', status: 'Done', delivery: { state: 'completed' } };
  const child2 = { id: 'chunk-2', parent: 'epic-100', status: 'Review', delivery: { state: 'released' } };
  const unrelated = { id: 'task-other', parent: 'epic-999', status: 'Planned' };
  const allCards = [epicCard, child1, child2, unrelated];

  const rollup = calculateEpicRollup(epicCard, allCards);

  assert.equal(typeof rollup.epic_id, 'string');
  assert.equal(rollup.epic_id, 'epic-100');
  assert.equal(rollup.total, 2);
  assert.equal(rollup.active_total, 2);
  assert.equal(rollup.completed, 1);
  assert.equal(rollup.released, 1);
  assert.equal(rollup.progress_ratio, 1);
  assert.equal(rollup.is_accepted, true);
  assert.deepEqual(rollup.children, ['chunk-1', 'chunk-2']);
});

test('calculateEpicRollup: excludes cancelled children from active_total and does not accept incomplete epic', () => {
  const epicCard = { id: 'epic-200', title: 'Sprint Epic' };
  const child1 = { id: 'c-1', parent: 'epic-200', status: 'Done', delivery: { state: 'completed' } };
  const child2 = { id: 'c-2', parent: 'epic-200', status: 'Cancelled', delivery: { state: 'cancelled' } };
  const child3 = { id: 'c-3', parent: 'epic-200', status: 'Build', delivery: { state: 'in_progress' } };
  const cards = [epicCard, child1, child2, child3];

  const rollup = calculateEpicRollup(epicCard, cards);

  assert.equal(rollup.epic_id, 'epic-200');
  assert.equal(rollup.total, 3);
  assert.equal(rollup.cancelled, 1);
  assert.equal(rollup.active_total, 2); // 3 total - 1 cancelled
  assert.equal(rollup.completed, 1);
  assert.equal(rollup.in_progress, 1);
  assert.equal(rollup.is_accepted, false);
  assert.equal(rollup.progress_ratio, 0.5); // 1 completed / 2 active
});

