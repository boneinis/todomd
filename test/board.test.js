import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { makeRepo, writeCard } from './helpers.js';
import { loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog, createCard } from '../src/board.js';

test('loadBoard parses cards and criteria progress', () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001', { criteria: ['a', 'b'] });
  const { config, cards } = loadBoard(repo);
  assert.ok(config.columns.includes('Verify'));
  const c = cards.find((x) => x.id === 'task-0001');
  assert.equal(c.status, 'Review');
  assert.deepEqual(c.criteria, { done: 0, total: 2 });
});

test('findCardFile is exact: task-0001 does not match task-00010', () => {
  const repo = makeRepo();
  writeCard(repo, 'task-00010', { title: 'ten' });
  assert.equal(readCard(repo, 'task-0001'), null);
  assert.equal(readCard(repo, 'task-00010').data.title, 'ten');
});

test('moveCard rewrites only the frontmatter status, not a body status: line', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001', { body: 'status: decoy in body' });
  const r = await moveCard(repo, 'task-0001', 'Done');
  assert.equal(r.ok, true);
  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.status, 'Done');
  assert.match(card.body, /status: decoy in body/); // body untouched
});

test('moveCard rejects unknown status', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  const r = await moveCard(repo, 'task-0001', 'Nonsense');
  assert.equal(r.ok, false);
});

test('patchFrontmatter survives hostile values: no wedge, no injection, round-trips', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  const hostile = [
    '\x1b[31mansi\x1b[0m', 'a\nstatus: Done\ninjected: pwned', 'a\r\nb',
    '"', '\\', 'foo: bar # baz', 'a$& b', 'a\tb', 'café 日本語',
  ];
  for (const val of hostile) {
    await patchFrontmatter(repo, 'task-0001', { needs_human_reason: val });
    const card = readCard(repo, 'task-0001');
    assert.ok(!card.parseError, `wedged on ${JSON.stringify(val)}`);
    assert.equal(card.data.status, 'Review', `status overwritten by ${JSON.stringify(val)}`);
    assert.ok(!('injected' in card.data), `key injected by ${JSON.stringify(val)}`);
    assert.equal(String(card.data.needs_human_reason), val, `lossy on ${JSON.stringify(val)}`);
  }
});

test('patchFrontmatter writes nested object flow style', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  await patchFrontmatter(repo, 'task-0001', { verification: { attempts: 2, max_attempts: 3, last_verdict: 'fail' } });
  const v = readCard(repo, 'task-0001').data.verification;
  assert.deepEqual(v, { attempts: 2, max_attempts: 3, last_verdict: 'fail' });
});

test('appendRunLog inserts under the heading and keeps the blank line before a following section', async () => {
  const repo = makeRepo();
  // card whose Run Log is NOT the last section
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, `---\nid: task-0001\nstatus: Review\n---\n\n## Run Log\n\n## Findings\n\nx\n`);
  await appendRunLog(repo, 'task-0001', '- line one');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /- line one\n\n## Findings/); // blank line preserved
  // and it still parses
  assert.ok(!matter(raw).data.error);
});

test('createCard sequences ids, slugs the title, and rejects empty titles', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  writeCard(repo, 'task-0002');
  const r = await createCard(repo, { title: 'Fix: the Thing!', priority: 'high' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'task-0003');
  assert.match(r.file, /^task-0003-fix-the-thing\.md$/);
  const bad = await createCard(repo, { title: '   ' });
  assert.equal(bad.ok, false);
});

test('unparseable card is surfaced, not fatal', () => {
  const repo = makeRepo();
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, `---\ntitle: "unterminated\nstatus: Review\n---\nbody\n`);
  const { cards } = loadBoard(repo);
  assert.match(cards[0].title, /unparseable/);
  // readCard must not crash and must not surface the malformed frontmatter as
  // real data (it degrades to parseError or empty data — gray-matter caches,
  // so which one depends on call order; both are non-fatal)
  const rc = readCard(repo, 'task-0001');
  assert.ok(rc, 'readCard returns an object, never crashes');
  assert.ok(rc.parseError || Object.keys(rc.data).length === 0, 'malformed frontmatter not surfaced as data');
});
