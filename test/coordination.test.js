import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git } from './helpers.js';
import { planFiles, parseActive, findConflicts, workerName, claim, release, readAllClaims } from '../src/coordination.js';

test('planFiles extracts backtick-quoted paths from the Implementation Plan', () => {
  const body = `## Description\nx\n## Implementation Plan\n1. Edit \`src/calc.js\` to add it.\n2. Add a test in \`test/calc.test.js\`.\n3. Mention \`README\` (no ext, skipped) and a number \`42\`.\n## Run Log\n`;
  assert.deepEqual(planFiles(body).sort(), ['src/calc.js', 'test/calc.test.js']);
});

test('parseActive round-trips a claim with files', () => {
  const md = '# Active work\n\n- **task-0042** — Fix login — `branch: todomd/task-0042` — worker `alice@mac` — started 2026-06-10 14:30Z\n  - files: src/auth.js, src/login.js\n';
  const [c] = parseActive(md);
  assert.equal(c.card, 'task-0042');
  assert.equal(c.worker, 'alice@mac');
  assert.deepEqual(c.files, ['src/auth.js', 'src/login.js']);
});

test('findConflicts flags only OTHER workers with overlapping files', () => {
  const claims = [
    { card: 'task-1', worker: 'bob@pc', files: ['src/a.js', 'src/b.js'] },
    { card: 'task-2', worker: 'me@host', files: ['src/c.js'] },
  ];
  // my new card touches a.js → conflicts with bob's task-1; not with my own task-2
  const c = findConflicts(claims, { card: 'task-9', worker: 'me@host', files: ['src/a.js'] });
  assert.equal(c.length, 1);
  assert.equal(c[0].card, 'task-1');
  // no overlap → none
  assert.equal(findConflicts(claims, { card: 'task-9', worker: 'me@host', files: ['src/z.js'] }).length, 0);
});

test('claim writes + commits ACTIVE.md and detects an existing other-worker conflict; release removes it', async () => {
  const repo = makeRepo();
  // seed an existing claim from another worker
  await claim(repo, { card: 'task-0001', title: 'Other work', branch: 'todomd/task-0001', worker: 'bob@pc', files: ['src/calc.js'] }, {});
  assert.ok(fs.existsSync(path.join(repo, '.todomd/ACTIVE.md')));
  assert.match(git(repo, ['log', '-1', '--format=%s']), /claim active work/);

  // my card touching the same file → conflict reported
  const conflicts = await claim(repo, { card: 'task-0002', title: 'Mine', branch: 'todomd/task-0002', worker: 'me@host', files: ['src/calc.js'] }, {});
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].worker, 'bob@pc');

  // both claims now present
  let all = await readAllClaims(repo, {});
  assert.equal(all.length, 2);

  // release mine → only bob's remains
  await release(repo, 'task-0002', {});
  all = await readAllClaims(repo, {});
  assert.deepEqual(all.map((c) => c.card), ['task-0001']);
});

test('workerName uses config override else <user>@<host>', () => {
  assert.equal(workerName({ coordination: { worker: 'ci-runner' } }), 'ci-runner');
  assert.match(workerName({}), /@/);
});

test('concurrent claims do not lose each other (repo-lock serialized)', async () => {
  const repo = makeRepo();
  // fire two different cards' claims at the same time
  await Promise.all([
    claim(repo, { card: 'task-0001', title: 'A', branch: 'todomd/task-0001', worker: 'alice@a', files: ['src/a.js'] }, {}),
    claim(repo, { card: 'task-0002', title: 'B', branch: 'todomd/task-0002', worker: 'bob@b', files: ['src/b.js'] }, {}),
  ]);
  const all = await readAllClaims(repo, {});
  assert.deepEqual(all.map((c) => c.card).sort(), ['task-0001', 'task-0002'], 'both claims must survive a concurrent write');
  // concurrent release of one while claiming a third
  await Promise.all([
    release(repo, 'task-0001', {}),
    claim(repo, { card: 'task-0003', title: 'C', branch: 'todomd/task-0003', worker: 'carol@c', files: ['src/c.js'] }, {}),
  ]);
  const after = await readAllClaims(repo, {});
  assert.deepEqual(after.map((c) => c.card).sort(), ['task-0002', 'task-0003']);
});
