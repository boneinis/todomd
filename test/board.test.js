import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { makeRepo, writeCard, git } from './helpers.js';
import { loadBoard, readCard, moveCard, patchFrontmatter, appendRunLog, createCard, attachCard, setArchived, deleteCard } from '../src/board.js';

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
  // readCard on the SAME malformed string AFTER loadBoard already parsed it must
  // still surface a parseError — gray-matter caches an empty result even after
  // the first parse threw, which would otherwise make readCard silently return
  // {data:{}, body:<raw incl. frontmatter>} and lose id/status (cache poisoning).
  const rc = readCard(repo, 'task-0001');
  assert.ok(rc, 'readCard returns an object, never crashes');
  assert.ok(rc.parseError, 'malformed frontmatter surfaces parseError even after loadBoard cached the failed parse');
  assert.equal(Object.keys(rc.data).length, 0, 'no bogus data leaks through');
});

test('appendRunLog anchors on the heading line, not a body mention of "## Run Log"', async () => {
  const repo = makeRepo();
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  // a todomd-about-todomd card whose Description quotes the literal heading text
  fs.writeFileSync(file,
    `---\nid: task-0001\nstatus: Review\n---\n\n` +
    `## Description\n\nWe insert into the ## Run Log section.\n\n` +
    `## Run Log\n\n- existing\n`);
  await appendRunLog(repo, 'task-0001', '- line one');
  const raw = fs.readFileSync(file, 'utf8');
  // the new line lands in the real Run Log section, after the existing entry —
  // not spliced into the Description that merely mentions the text
  assert.match(raw, /## Run Log\n\n- existing\n- line one/);
  assert.match(raw, /We insert into the ## Run Log section\.\n\n## Run Log/, 'Description left intact');
});

test('appendRunLog ignores a "## Run Log" line INSIDE a fenced code block', async () => {
  const repo = makeRepo();
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  // a self-documenting card: the heading text appears at line-start inside a ``` fence
  fs.writeFileSync(file,
    '---\nid: task-0001\nstatus: Review\n---\n\n## Description\n\nFormat example:\n\n' +
    '```\n## Run Log\n- sample\n```\n\n## Run Log\n\n- existing real entry\n');
  await appendRunLog(repo, 'task-0001', '- NEW');
  const raw = fs.readFileSync(file, 'utf8');
  // appended under the REAL heading (after the existing entry), not into the fence
  assert.match(raw, /## Run Log\n\n- existing real entry\n- NEW/);
  assert.match(raw, /```\n## Run Log\n- sample\n```/, 'the code fence is left untouched');
});

test('attachCard stores under attachments/<id>, references in card, sanitizes name, avoids clobber', async () => {
  const { attachCard } = await import('../src/board.js');
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  const img = Buffer.from('PNGDATA');
  const r1 = await attachCard(repo, 'task-0001', '../../evil name!.png', img);
  assert.equal(r1.ok, true);
  assert.equal(r1.isImg, true);
  // sanitized to a basename inside the attachments dir
  assert.match(r1.path, /^\.todomd\/attachments\/task-0001\/evil_name_\.png$/);
  assert.ok(fs.existsSync(path.join(repo, r1.path)));
  // referenced as a markdown image in the card body
  const card = readCard(repo, 'task-0001');
  assert.match(card.body, /## Attachments/);
  assert.match(card.body, /!\[evil_name_\.png\]\(\.todomd\/attachments\/task-0001\/evil_name_\.png\)/);
  // a doc (non-image) is referenced as a link, and a same-name upload doesn't clobber
  const r2 = await attachCard(repo, 'task-0001', 'evil name!.png', Buffer.from('OTHER'));
  assert.match(r2.path, /evil_name_-1\.png$/);
  assert.equal(fs.readFileSync(path.join(repo, r1.path), 'utf8'), 'PNGDATA');
});

test('attachCard rejects empty and oversized files', async () => {
  const { attachCard } = await import('../src/board.js');
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  assert.equal((await attachCard(repo, 'task-0001', 'x.png', Buffer.alloc(0))).ok, false);
  assert.equal((await attachCard(repo, 'task-0001', 'big.bin', Buffer.alloc(26 * 1024 * 1024))).ok, false);
});

test('createCard records an assignee (sanitized) and it round-trips', async () => {
  const repo = makeRepo();
  const r = await createCard(repo, { title: 'Assigned task', assignee: 'alice@team ' });
  assert.equal(r.ok, true);
  assert.equal(readCard(repo, r.id).data.assignee, 'alice@team');
  // a card with no assignee parses to a falsy field (empty/null)
  const r2 = await createCard(repo, { title: 'Unassigned' });
  assert.ok(!readCard(repo, r2.id).data.assignee);
});

test('readCommandFile / writeCommandFile round-trip and reject path traversal', async () => {
  const { readCommandFile, writeCommandFile } = await import('../src/board.js');
  const repo = makeRepo();
  // existing command from makeRepo's stubs
  assert.match(readCommandFile(repo, 'todomd-build'), /stub/);
  // write a new one + commit
  const r = await writeCommandFile(repo, 'todomd-build', 'You are the BUILD agent. $ARGUMENTS\nDo the thing.');
  assert.equal(r.ok, true);
  assert.match(readCommandFile(repo, 'todomd-build'), /Do the thing/);
  assert.match(git(repo, ['log', '-1', '--format=%s']), /edit todomd-build prompt/);
  // traversal / bad names are refused (name constrained to [\w-])
  assert.equal(readCommandFile(repo, '../../etc/passwd'), null);
  assert.equal((await writeCommandFile(repo, '../evil', 'x')).ok, false);
});

test('setArchived hides a card from the board; unarchive restores it (flag committed)', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  writeCard(repo, 'task-0002');

  const r = await setArchived(repo, 'task-0001', true);
  assert.equal(r.ok, true);
  assert.equal(r.archived, true);

  // hidden from the default board, kept for the dependency check / archived view
  let ids = loadBoard(repo).cards.map((c) => c.id);
  assert.ok(!ids.includes('task-0001'), 'archived card hidden by default');
  assert.ok(ids.includes('task-0002'));
  ids = loadBoard(repo, { includeArchived: true }).cards.map((c) => c.id);
  assert.ok(ids.includes('task-0001'), 'visible with includeArchived');
  assert.match(readCard(repo, 'task-0001').data.archived || '', /^\d{4}-\d{2}-\d{2}$/, 'flag is a date');

  await setArchived(repo, 'task-0001', false); // restore
  ids = loadBoard(repo).cards.map((c) => c.id);
  assert.ok(ids.includes('task-0001'), 'restored to the board');
  assert.equal(readCard(repo, 'task-0001').data.archived ?? '', '', 'flag removed on restore');
});

test('deleteCard removes the task file + its attachments and commits the removal', async () => {
  const repo = makeRepo();
  writeCard(repo, 'task-0001');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'card']);
  await attachCard(repo, 'task-0001', 'note.txt', Buffer.from('hi')); // attachCard commits the attachment
  assert.ok(fs.existsSync(path.join(repo, '.todomd/attachments/task-0001')));

  const r = await deleteCard(repo, 'task-0001');
  assert.equal(r.ok, true);
  assert.equal(r.commit.committed, true);
  assert.equal(readCard(repo, 'task-0001'), null, 'card file gone');
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/attachments/task-0001')), 'attachments gone');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'clean tree — deletion committed');

  assert.equal((await deleteCard(repo, 'task-0001')).ok, false, 'deleting a missing card errors');
});
