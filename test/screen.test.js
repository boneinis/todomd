import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, isolateHome, git } from './helpers.js';
import { screenEmail, appendIntakeAudit } from '../src/screen.js';
import { intakeMessage } from '../src/intake.js';
import { readCard } from '../src/board.js';

// mailparser hands back a Map of lowercased header names — the same shape.
const headers = (obj) => new Map(Object.entries(obj));

// A message with nothing to hold against it: human sender, real subject, a body
// long enough to act on. Every spam/unclear case below is this plus ONE change,
// so a test that fails is telling you about the signal it added, not the fixture.
const work = (over = {}) => ({
  subject: 'Export button 500s on filtered reports',
  from: { text: 'Jane Doe <jane@example.com>', value: [{ address: 'jane@example.com' }] },
  text: 'Repro: open /reports, filter by month, click Export. Server returns a 500.',
  ...over,
});

const auditFile = (repo) => path.join(repo, '.todomd', 'intake-audit.jsonl');
const auditLines = (repo) =>
  fs.readFileSync(auditFile(repo), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cardFiles = (repo) => fs.readdirSync(path.join(repo, '.todomd', 'tasks'));

/* ── screenEmail: the classifier ── */

test('screenEmail: an ordinary human bug report is work', () => {
  const r = screenEmail(work());
  assert.equal(r.verdict, 'work');
  assert.deepEqual(r.signals, []);
});

test('screenEmail: any ONE strong signal screens the message out', () => {
  const strong = {
    'list-unsubscribe': { 'list-unsubscribe': '<mailto:leave@list.example.com>' },
    'precedence-bulk': { precedence: 'bulk' },
    'auto-submitted-bulk': { 'auto-submitted': 'auto-generated' },
    'esp-header': { 'x-mailgun-sid': 'abc123' },
  };
  for (const [signal, hdrs] of Object.entries(strong)) {
    const r = screenEmail(work({ headers: headers(hdrs) }));
    assert.equal(r.verdict, 'spam', `${signal} should be enough on its own`);
    assert.ok(r.signals.includes(signal), `${signal} should be named in the signals`);
    assert.ok(r.reason.length > 0, `${signal} should come with a human-readable reason`);
  }
});

test('screenEmail: Auto-Submitted keeps its RFC 3834 parameters out of the comparison', () => {
  // "auto-replied" is an out-of-office, held for a human — not bulk mail. A
  // whole-value compare would miss the parameterized spelling and drop it.
  const r = screenEmail(work({ headers: headers({ 'auto-submitted': 'auto-replied; owner=vacation@example.com' }) }));
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('auto-reply'));
  assert.ok(!r.signals.includes('auto-submitted-bulk'));
  // "no" is the explicit not-automated value and must not register at all
  assert.equal(screenEmail(work({ headers: headers({ 'auto-submitted': 'no' }) })).verdict, 'work');
});

test('screenEmail: two weak signals are spam, but a lone weak signal is only unclear', () => {
  const noreply = { from: { text: 'Shop <no-reply@shop.example.com>', value: [{ address: 'no-reply@shop.example.com' }] } };
  // weak #1 alone: held for a human, NOT dropped — this is the whole point of
  // splitting the signals, since real work does arrive from no-reply relays
  const lone = screenEmail(work(noreply));
  assert.equal(lone.verdict, 'unclear');
  assert.deepEqual(lone.signals, ['noreply-sender']);
  // weak #1 + weak #2 (an unsubscribe footer): now it's marketing mail
  const both = screenEmail(work({ ...noreply, text: 'Our summer sale is on.\n\nUnsubscribe from these emails' }));
  assert.equal(both.verdict, 'spam');
  assert.ok(both.signals.includes('unsubscribe-footer'));
});

test('screenEmail: thin or auto-generated messages are held as unclear, never dropped', () => {
  const cases = [
    ['empty-body', work({ text: '' })],
    ['short-body', work({ text: 'it broke' })],
    ['no-subject', work({ subject: '' })],
    ['auto-reply', work({ subject: 'Automatic reply: Export button 500s' })],
    ['bounce', work({ from: { text: 'Mail Delivery Subsystem <mailer-daemon@example.com>', value: [{ address: 'mailer-daemon@example.com' }] } })],
    ['bounce', work({ subject: 'Undeliverable: Export button 500s' })],
  ];
  for (const [signal, msg] of cases) {
    const r = screenEmail(msg);
    assert.equal(r.verdict, 'unclear', `${signal} should be held, not dropped`);
    assert.ok(r.signals.includes(signal), `${signal} should be named in the signals`);
  }
});

test('screenEmail: an HTML-only body is held, and its footer is still read', () => {
  const htmlOnly = screenEmail(work({ text: '', html: '<p>Please look at the export button.</p>' }));
  assert.equal(htmlOnly.verdict, 'unclear');
  assert.ok(htmlOnly.signals.includes('html-only'));
  // html-only (weak) + a footer found in the stripped HTML (weak) = marketing
  const withFooter = screenEmail(work({
    from: { text: 'Shop <no-reply@shop.example.com>', value: [{ address: 'no-reply@shop.example.com' }] },
    text: '', html: '<p>Sale!</p><a href="#">Unsubscribe</a>',
  }));
  assert.equal(withFooter.verdict, 'spam');
});

test('screenEmail: a message with no headers at all still classifies', () => {
  // pollSource passes whatever mailparser produced; a fixture without a headers
  // Map must not throw its way out of the poll loop
  assert.equal(screenEmail(work({ headers: undefined })).verdict, 'work');
  assert.equal(screenEmail({}).verdict, 'unclear');
  assert.equal(screenEmail(undefined).verdict, 'unclear');
});

/* ── intakeMessage: screening → board state ── */

test('intakeMessage: screened-out mail never becomes a card, but is always audited', async () => {
  isolateHome();
  const repo = makeRepo();
  const before = cardFiles(repo).length;
  const out = await intakeMessage({ path: repo, name: 'repo' },
    work({ headers: headers({ 'list-unsubscribe': '<mailto:x@y.com>' }), messageId: '<spam-1@shop.com>' }),
    { label: 'main' });

  assert.equal(out.verdict, 'spam');
  assert.equal(out.created, false);
  assert.equal(out.handled, true, 'a screened-out message is terminal — the poller must not reconsider it');
  assert.equal(cardFiles(repo).length, before, 'spam must not reach the board at all');

  const [line] = auditLines(repo);
  assert.equal(line.verdict, 'spam');
  assert.equal(line.source, 'main');
  assert.equal(line.messageId, '<spam-1@shop.com>'); // the key you need to find it in the mailbox
  assert.equal(line.card, '');
  assert.match(line.reason, /List-Unsubscribe/);
});

test('intakeMessage: an unclear message is held in Needs Human with the reason on the card', async () => {
  isolateHome();
  const repo = makeRepo();
  const out = await intakeMessage({ path: repo, name: 'repo' }, work({ text: 'it broke' }), { label: 'main' });

  assert.equal(out.verdict, 'unclear');
  assert.equal(out.created, true);
  const card = readCard(repo, out.id);
  assert.equal(card.data.status, 'Needs Human', 'held for a human instead of entering the flow');
  assert.match(String(card.data.needs_human_reason), /very short/);
  assert.match(card.data.title, /Export button 500s/); // the content is preserved, only the column differs
  // the status alone keeps triage off it (maybeTriage/triageSweep gate on
  // Review), so the card must NOT be pre-marked triaged — otherwise dragging it
  // to Review, the human's "this is real" signal, would skip auto-triage forever
  assert.equal(card.data.triaged || '', '');

  assert.equal(auditLines(repo).at(-1).card, out.id, 'the audit line links the message to its card');
});

test('intakeMessage: real work lands in Review, untriaged, ready for the normal flow', async () => {
  isolateHome();
  const repo = makeRepo();
  const out = await intakeMessage({ path: repo, name: 'repo' }, work({ messageId: '<real-1@example.com>' }),
    { label: 'main', assignee: 'jane' });

  assert.equal(out.verdict, 'work');
  const card = readCard(repo, out.id);
  assert.equal(card.data.status, 'Review');
  assert.equal(card.data.assignee, 'jane');
  assert.equal(card.data.triaged || '', '', 'a real work card is left for auto-triage to claim');
  assert.equal(card.data.needs_human_reason || '', '');

  const line = auditLines(repo).at(-1);
  assert.equal(line.verdict, 'work');
  assert.equal(line.card, out.id);
});

test('intakeMessage: attachments still ride along on a card that was created', async () => {
  isolateHome();
  const repo = makeRepo();
  const out = await intakeMessage({ path: repo, name: 'repo' },
    work({ attachments: [{ filename: 'trace.txt', content: Buffer.from('stack trace') }] }), { label: 'main' });
  assert.equal(out.created, true);
  assert.ok(fs.existsSync(path.join(repo, '.todomd', 'attachments', out.id, 'trace.txt')));
});

/* ── the audit log itself ── */

test('appendIntakeAudit: appends one line per decision and gitignores itself', async () => {
  isolateHome();
  const repo = makeRepo();
  await appendIntakeAudit(repo, { verdict: 'spam', subject: 'first' });
  await appendIntakeAudit(repo, { verdict: 'work', subject: 'second' });

  const lines = auditLines(repo);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].subject, 'second');

  assert.ok(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
    .split('\n').some((l) => l.trim() === '.todomd/intake-audit.jsonl'), 'the line is added even to a board that predates it');
  // an operational log about untrusted mail must never be committable
  assert.ok(!git(repo, ['status', '--porcelain']).includes('intake-audit.jsonl'));
});

test('appendIntakeAudit: trims to the newest 500 lines so it cannot grow unbounded', async () => {
  isolateHome();
  const repo = makeRepo();
  // seed at the cap directly — the point under test is the trim, not 500 locks
  fs.writeFileSync(auditFile(repo),
    Array.from({ length: 500 }, (_, i) => JSON.stringify({ n: i })).join('\n') + '\n');
  await appendIntakeAudit(repo, { n: 500 });
  await appendIntakeAudit(repo, { n: 501 });

  const lines = auditLines(repo);
  assert.equal(lines.length, 500);
  assert.equal(lines[0].n, 2, 'the oldest lines are the ones dropped');
  assert.equal(lines.at(-1).n, 501);
});
