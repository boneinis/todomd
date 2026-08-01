import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import { makeRepo, isolateHome, git } from './helpers.js';
import { screenEmail, appendIntakeAudit } from '../src/screen.js';
import { intakeMessage, parseInboundMessage, pollSource } from '../src/intake.js';
import { readCard } from '../src/board.js';

// A hand-built headers Map, for unit cases that only care about one signal.
// NOT a faithful stand-in for mailparser: it normalizes some headers away from
// the Map (every List-* header becomes one `list` entry), which is exactly the
// bug the simpleParser end-to-end tests at the bottom of this file exist to
// catch. Use those whenever the header shape itself is what's under test.
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
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function childIntake(repo, gate, intakeKey) {
  const script = `
    import fs from 'node:fs';
    import { intakeMessage } from './src/intake.js';
    while (!fs.existsSync(process.argv[2])) await new Promise((resolve) => setTimeout(resolve, 5));
    const parsed = {
      subject: 'Newsletter',
      from: { text: 'Marketing <news@example.com>', value: [{ address: 'news@example.com' }] },
      text: 'Weekly offers. Unsubscribe from these emails.',
      messageId: '<cross-process@example.com>',
      headers: new Map([['list-unsubscribe', '<mailto:leave@example.com>']]),
    };
    const out = await intakeMessage({ path: process.argv[1], name: 'repo' }, parsed,
      { label: 'main', intakeKey: process.argv[3] });
    process.stdout.write(JSON.stringify(out));
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script, repo, gate, intakeKey], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

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

test('screenEmail: a bare View in browser footer is a weak marketing signal', () => {
  const r = screenEmail(work({ text: 'Weekly product updates and announcements. View in browser' }));
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('unsubscribe-footer'));
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
  assert.ok(!htmlOnly.signals.includes('empty-body'), 'readable HTML is not described as an empty body');
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

test('appendIntakeAudit: appends decisions without dirtying a legacy board', async () => {
  isolateHome();
  const repo = makeRepo();
  const ignore = path.join(repo, '.gitignore');
  assert.ok(!fs.readFileSync(ignore, 'utf8').includes('.todomd/intake-audit.jsonl'),
    'fixture represents a board from before intake auditing');
  await appendIntakeAudit(repo, { verdict: 'spam', subject: 'first' });
  await appendIntakeAudit(repo, { verdict: 'work', subject: 'second' });

  const lines = auditLines(repo);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].subject, 'second');

  assert.ok(!fs.readFileSync(ignore, 'utf8').includes('.todomd/intake-audit.jsonl'),
    'runtime migration does not edit the tracked .gitignore');
  assert.equal(git(repo, ['status', '--porcelain']), '', 'the legacy checkout stays clean');
  assert.match(git(repo, ['check-ignore', '-v', '.todomd/intake-audit.jsonl']), /info\/exclude/,
    'the operational log is protected by a local Git exclusion');
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

/* ── end-to-end through the real parser ──
 * Everything above screens hand-built fixtures. These go through the parser
 * pollSource actually uses, because mailparser reshapes headers on the way in
 * and a fixture written to match our own assumptions cannot catch that. */

const rawEmail = (lines) => lines.join('\r\n');

// A newsletter whose ONLY strong signal is List-Unsubscribe: a human-looking
// sender, a real subject, a body long enough to act on and with no unsubscribe
// footer in it. If screening reads this header, one signal decides the message.
const RAW_NEWSLETTER = rawEmail([
  'From: Shop News <news@shop.example.com>',
  'To: intake@example.com',
  'Subject: Summer sale is on',
  'Message-ID: <newsletter-1@shop.example.com>',
  'List-Unsubscribe: <mailto:leave@shop.example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Big savings this week on everything in the store. Come take a look.',
  '',
]);

const RAW_BUG_REPORT = rawEmail([
  'From: Jane Doe <jane@example.com>',
  'To: intake@example.com',
  'Subject: Export button 500s on filtered reports',
  'Message-ID: <real-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Repro: open /reports, filter by month, click Export. Server returns a 500.',
  '',
]);

const RAW_HTML_ONLY = rawEmail([
  'From: Web Form <forms@example.com>',
  'To: intake@example.com',
  'Subject: New website update',
  'Message-ID: <html-only-1@example.com>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>This message has enough visible content to look actionable after HTML-to-text conversion.</p>',
  '',
]);

test('production parsing preserves an HTML-only body so screening can hold it', async () => {
  isolateHome();
  const repo = makeRepo();
  const parsed = await parseInboundMessage(RAW_HTML_ONLY);

  assert.equal(parsed.text, '', 'production intake must not synthesize a text/plain part');
  assert.ok(parsed.html);
  assert.ok(screenEmail(parsed).signals.includes('html-only'));

  const out = await intakeMessage({ path: repo, name: 'repo' }, parsed, { label: 'main' });
  assert.equal(out.verdict, 'unclear');
  assert.equal(out.created, true);
  const card = readCard(repo, out.id);
  assert.equal(card.data.status, 'Needs Human');
  assert.match(card.data.needs_human_reason, /HTML-only/i);
  assert.match(card.body, /enough visible content to look actionable/i,
    'the held card keeps readable HTML body text for the human reviewer');
});

test('mailparser folds List-* headers out of the headers Map — screening must still see them', async () => {
  const parsed = await simpleParser(RAW_NEWSLETTER);

  // This is the shape that broke the classifier: there is NO 'list-unsubscribe'
  // key on the Map. Pinned here so a parser upgrade that changes it is loud.
  assert.equal(parsed.headers.has('list-unsubscribe'), false,
    'mailparser normalizes List-* away from the Map — a Map-only check is not enough');
  assert.ok(parsed.headers.get('list')?.unsubscribe, 'it lands on the structured `list` entry instead');
  assert.ok(parsed.headerLines.some((h) => h.key === 'list-unsubscribe'),
    'headerLines keeps the raw header, which is what makes the presence check reliable');

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'spam');
  assert.deepEqual(r.signals, ['list-unsubscribe'], 'that one header is the whole case against it');
  assert.match(r.reason, /List-Unsubscribe/);
});

test('screenEmail: a List-Id newsletter parsed for real still reads as a bulk-mail header', async () => {
  const parsed = await simpleParser(rawEmail([
    'From: Weekly Digest <digest@lists.example.com>',
    'To: intake@example.com',
    'Subject: Your weekly digest',
    'List-Id: Weekly Digest <digest.lists.example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here are the five most-read posts from the community this week.',
    '',
  ]));
  assert.equal(parsed.headers.has('list-id'), false); // same normalization
  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'spam');
  assert.ok(r.signals.includes('esp-header'));
});

test('screenEmail: a parsed delivery-status bounce stays unclear despite Auto-Submitted', async () => {
  const parsed = await simpleParser(rawEmail([
    'From: Mail Delivery System <mailer-daemon@example.com>',
    'To: sender@example.com',
    'Subject: Delivery Status Notification (Failure)',
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Delivery to recipient@example.com failed permanently.',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('bounce'));
  assert.ok(r.signals.includes('auto-submitted-bulk'), 'the audit explanation keeps the generic automation signal');
  assert.match(r.reason, /bounce|mailer-daemon/i);
});

test('screenEmail: Outlook bounce wording overrides generic Auto-Submitted automation', async () => {
  const parsed = await parseInboundMessage(rawEmail([
    'From: Microsoft Outlook <postmaster@example.com>',
    'To: sender@example.com',
    'Subject: Delivery has failed to these recipients or groups:',
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your message could not be delivered to recipient@example.com.',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('bounce'));
});

test('screenEmail: a delivery-status MIME report is held even with neutral sender and subject', async () => {
  const parsed = await parseInboundMessage(rawEmail([
    'From: Delivery Service <delivery@example.com>',
    'To: sender@example.com',
    'Subject: Message report',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="report"',
    '',
    '--report',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The remote server did not accept the message.',
    '--report',
    'Content-Type: message/delivery-status',
    '',
    'Action: failed',
    'Status: 5.1.1',
    '--report--',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('bounce'));
});

test('screenEmail: parsed bare X-Campaign and plus-tagged no-reply variants are recognized', async () => {
  const campaign = await parseInboundMessage(rawEmail([
    'From: Shop <news@shop.example.com>',
    'To: intake@example.com',
    'Subject: Weekly store news',
    'X-Campaign: july-week-5',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here are this week\'s store updates and featured products.',
    '',
  ]));
  assert.equal(screenEmail(campaign).verdict, 'spam');
  assert.ok(screenEmail(campaign).signals.includes('esp-header'));

  const tagged = await parseInboundMessage(rawEmail([
    'From: Shop <no-reply+receipts@shop.example.com>',
    'To: intake@example.com',
    'Subject: Your store update',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is a message long enough to avoid the short-body signal.',
    '',
  ]));
  assert.equal(screenEmail(tagged).verdict, 'unclear');
  assert.ok(screenEmail(tagged).signals.includes('noreply-sender'));
});

test('screenEmail: parsed view-in-browser footer variants combine with a no-reply sender', async () => {
  for (const [i, footer] of [
    'View email in browser',
    'View message in browser',
    'View this email in a browser',
  ].entries()) {
    const parsed = await parseInboundMessage(rawEmail([
      'From: Shop <no-reply@shop.example.com>',
      'To: intake@example.com',
      'Subject: Your weekly store update',
      `Message-ID: <footer-${i}@shop.example.com>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Here are this week's featured products and announcements. ${footer}`,
      '',
    ]));
    const r = screenEmail(parsed);
    assert.equal(r.verdict, 'spam', footer);
    assert.deepEqual(r.signals, ['noreply-sender', 'unsubscribe-footer']);
  }
});

test('screenEmail: parsed reply/forward-only and placeholder subjects are not meaningful', async () => {
  for (const subject of ['Re:', 'Fwd:', '(no subject)', '[no subject]', 'Re: (no subject)']) {
    const parsed = await parseInboundMessage(rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This body is long enough to avoid the short-body signal entirely.',
      '',
    ]));
    const r = screenEmail(parsed);
    assert.equal(r.verdict, 'unclear', subject);
    assert.ok(r.signals.includes('no-subject'), subject);
  }
});

test('screenEmail: a parsed multipart message checks the HTML footer as well as plain text', async () => {
  const parsed = await parseInboundMessage(rawEmail([
    'From: Shop <no-reply@shop.example.com>',
    'To: intake@example.com',
    'Subject: Your weekly account summary',
    'Content-Type: multipart/alternative; boundary="parts"',
    '',
    '--parts',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here is the account summary you requested for this week.',
    '--parts',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Here is the account summary you requested for this week.</p><a href="/leave">Unsubscribe</a>',
    '--parts--',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'spam');
  assert.ok(r.signals.includes('noreply-sender'));
  assert.ok(r.signals.includes('unsubscribe-footer'));
});

test('screenEmail: a parsed out-of-office body is held even with an ordinary reply subject', async () => {
  const parsed = await parseInboundMessage(rawEmail([
    'From: Jane Doe <jane@example.com>',
    'To: intake@example.com',
    'Subject: Re: Export failure',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'I am out of the office until August 12 and will respond when I return.',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('auto-reply'));
});

test('screenEmail: parsed vacation replies are held instead of entering Review', async () => {
  const parsed = await parseInboundMessage(rawEmail([
    'From: Jane Doe <jane@example.com>',
    'To: intake@example.com',
    'Subject: Vacation response: Export failure',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'I am currently on vacation and will return next Monday.',
    '',
  ]));

  const r = screenEmail(parsed);
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.signals.includes('auto-reply'));
});

test('intakeMessage: a real newsletter, parsed by mailparser, never reaches the board', async () => {
  isolateHome();
  const repo = makeRepo();
  const before = cardFiles(repo).length;

  const out = await intakeMessage({ path: repo, name: 'repo' }, await simpleParser(RAW_NEWSLETTER), { label: 'main' });

  assert.equal(out.verdict, 'spam');
  assert.equal(out.created, false);
  assert.equal(cardFiles(repo).length, before, 'no card file was written');

  const line = auditLines(repo).at(-1);
  assert.equal(line.verdict, 'spam');
  assert.equal(line.card, '');
  assert.equal(line.messageId, '<newsletter-1@shop.example.com>');
  assert.match(line.reason, /List-Unsubscribe/, 'the audit line names the signal that decided it');
});

test('intakeMessage: a persistent mailbox key prevents repeat audits without Message-ID', async () => {
  isolateHome();
  const repo = makeRepo();
  const parsed = await simpleParser(RAW_NEWSLETTER.replace('Message-ID: <newsletter-1@shop.example.com>\r\n', ''));
  const options = { label: 'main', intakeKey: 'main:uid:42' };

  const first = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);
  const second = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);

  assert.equal(first.verdict, 'spam');
  assert.equal(second.duplicate, true);
  assert.equal(auditLines(repo).length, 1, 'the stable mailbox UID is audited exactly once');
  assert.equal(cardFiles(repo).length, 0);
});

test('intakeMessage: overlapping calls claim one key and perform side effects once', async () => {
  isolateHome();
  const repo = makeRepo();
  const parsed = await simpleParser(RAW_BUG_REPORT);
  const options = { label: 'main', intakeKey: 'main:uid:concurrent' };

  const results = await Promise.all([
    intakeMessage({ path: repo, name: 'repo' }, parsed, options),
    intakeMessage({ path: repo, name: 'repo' }, parsed, options),
  ]);

  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal(cardFiles(repo).length, 1);
  assert.equal(auditLines(repo).length, 1);
});

test('intakeMessage: overlapping processes claim one key and perform side effects once', async () => {
  isolateHome();
  const repo = makeRepo();
  const gate = path.join(repo, 'start-intake');
  const key = 'main:uid:cross-process';
  const children = [childIntake(repo, gate, key), childIntake(repo, gate, key)];
  const resultsPromise = Promise.all(children.map(childResult));
  fs.writeFileSync(gate, 'go');
  const results = await resultsPromise;

  assert.equal(results.filter((r) => r.verdict === 'spam').length, 1);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal(cardFiles(repo).length, 0);
  assert.equal(auditLines(repo).length, 1);
});

test('intakeMessage: durable handled keys retain a bounded recent window', async () => {
  isolateHome();
  const repo = makeRepo();
  const file = path.join(repo, '.todomd', 'intake-handled.json');
  fs.writeFileSync(file, JSON.stringify(Array.from({ length: 5000 }, (_, i) => `old:${i}`)));

  await intakeMessage({ path: repo, name: 'repo' }, work(), { label: 'main', intakeKey: 'new:key' });

  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(keys.length, 5000);
  assert.equal(keys.includes('old:0'), false);
  assert.equal(keys.at(-1), 'new:key');
});

test('intakeMessage: an audit failure after card creation does not create a duplicate', async () => {
  isolateHome();
  const repo = makeRepo();
  const auditPath = path.join(repo, '.todomd', 'intake-audit.jsonl');
  fs.mkdirSync(auditPath, { recursive: true }); // force appendIntakeAudit to raise EISDIR
  const parsed = await simpleParser(RAW_BUG_REPORT);
  const options = { label: 'main', intakeKey: 'main:uid:43' };

  const first = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);
  const second = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);

  assert.equal(first.created, true);
  assert.equal(first.handled, true);
  assert.match(first.audit_error, /directory|EISDIR/i);
  assert.equal(second.duplicate, true);
  assert.equal(cardFiles(repo).length, 1, 'retrying the same UID does not create another card');
});

test('intakeMessage: spam audit remains exactly once when handled-key persistence fails', async () => {
  isolateHome();
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.todomd', 'intake-handled.json'), { recursive: true });
  const parsed = await simpleParser(RAW_NEWSLETTER);
  const options = { label: 'main', intakeKey: 'main:uid:44' };

  await assert.rejects(intakeMessage({ path: repo, name: 'repo' }, parsed, options), /directory|EISDIR/i);
  const retry = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);

  assert.equal(retry.duplicate, true);
  assert.equal(retry.verdict, 'spam');
  assert.equal(cardFiles(repo).length, 0);
  assert.equal(auditLines(repo).length, 1, 'retrying the same screened spam decision cannot duplicate its audit');
  assert.equal(auditLines(repo)[0].intakeKey, options.intakeKey);
});

test('intakeMessage: work and unclear cards recover without duplication after handled-key failure', async () => {
  const cases = [
    ['work', RAW_BUG_REPORT, 'Review'],
    ['unclear', rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re:',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This body is long enough to be actionable but the subject has no meaning.',
      '',
    ]), 'Needs Human'],
  ];

  for (const [verdict, raw, expectedStatus] of cases) {
    isolateHome();
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.todomd', 'intake-handled.json'), { recursive: true });
    const parsed = await simpleParser(raw);
    const options = { label: 'main', intakeKey: `main:uid:${verdict}` };

    await assert.rejects(intakeMessage({ path: repo, name: 'repo' }, parsed, options), /directory|EISDIR/i);
    const retry = await intakeMessage({ path: repo, name: 'repo' }, parsed, options);

    assert.equal(retry.duplicate, true, verdict);
    assert.equal(retry.recovered, true, verdict);
    assert.equal(retry.verdict, verdict);
    assert.equal(cardFiles(repo).length, 1, `${verdict} retry does not create another card`);
    assert.equal(readCard(repo, retry.id).data.status, expectedStatus);
    assert.equal(auditLines(repo).length, 1, `${verdict} retry does not duplicate its audit`);
  }
});

test('pollSource: a poison message does not starve later UIDs and remains recoverable', async () => {
  isolateHome();
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.todomd', 'intake-handled.json'), { recursive: true });
  const messages = [
    { uid: 1, source: Buffer.from(RAW_NEWSLETTER) },
    { uid: 2, source: Buffer.from(RAW_BUG_REPORT) },
  ];
  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: 3 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { yield* messages; },
    async logout() {},
  };
  const source = {
    label: 'main', conf: { host: 'imap.example.com', user: 'inbox', pass: 'secret', markSeen: false },
    resolve: () => 'repo', assigneeOf: () => null,
  };
  const getProject = () => ({ path: repo, name: 'repo' });
  const triaged = [];

  await pollSource(source, getProject, { createClient: () => fakeClient, onCardCallback: (_project, id) => triaged.push(id) });
  assert.equal(cardFiles(repo).length, 1, 'the later work message is processed despite the first UID failure');
  assert.equal(auditLines(repo).length, 2);
  assert.deepEqual(triaged, [], 'triage waits until the created card is recovered durably');

  await pollSource(source, getProject, { createClient: () => fakeClient, onCardCallback: (_project, id) => triaged.push(id) });
  assert.equal(cardFiles(repo).length, 1, 'the recovery scan uses audit decisions instead of duplicating cards');
  assert.equal(auditLines(repo).length, 2);
  assert.equal(triaged.length, 1, 'the recovered work card still enters normal triage');
});

test('pollSource: handled unseen mail does not consume maxPerPoll behind a poison UID', async () => {
  isolateHome();
  const repo = makeRepo();
  const messages = [{ uid: 1, source: Buffer.from('poison') }];
  for (let uid = 2; uid <= 55; uid++) {
    messages.push({ uid, source: Buffer.from(rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      `Subject: Work item ${uid}`,
      `Message-ID: <work-${uid}@example.com>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Please investigate reproducible work item ${uid}; it has enough detail to be actionable.`,
      '',
    ])) });
  }
  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: 56 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { yield* messages; },
    async logout() {},
  };
  const source = {
    label: 'max-per-poll-poison',
    conf: {
      host: 'imap.example.com', user: 'inbox', pass: 'secret', markSeen: false, maxPerPoll: 50,
    },
    resolve: () => 'repo', assigneeOf: () => null,
  };
  const triaged = [];
  const options = {
    createClient: () => fakeClient,
    onCardCallback: (_project, id) => triaged.push(id),
    parseMessage: (raw) => {
      if (raw.toString() === 'poison') throw new Error('permanent parse failure');
      return parseInboundMessage(raw);
    },
  };

  await pollSource(source, () => ({ path: repo, name: 'repo' }), options);
  assert.equal(cardFiles(repo).length, 49, 'the first bounded pass handles UIDs 2 through 50');

  await pollSource(source, () => ({ path: repo, name: 'repo' }), options);
  assert.equal(cardFiles(repo).length, 54, 'the next pass skips handled UIDs and reaches 51 through 55');
  assert.equal(triaged.length, 54);
});

test('pollSource: default markSeen mode still processes an older message marked unread', async () => {
  isolateHome();
  const repo = makeRepo();
  const message = (uid) => ({ uid, source: Buffer.from(rawEmail([
    'From: Jane Doe <jane@example.com>',
    'To: intake@example.com',
    `Subject: Work item ${uid}`,
    `Message-ID: <unread-${uid}@example.com>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Please investigate work item ${uid}; this body has enough actionable detail.`,
    '',
  ])) });
  let batch = [message(1), message(3)];
  const selectors = [];
  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: 4 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch(selector) { selectors.push(selector); yield* batch; },
    async messageFlagsAdd() {},
    async logout() {},
  };
  const triaged = [];
  const source = {
    label: 'mark-unread-regression',
    conf: { host: 'imap.example.com', user: 'inbox', pass: 'secret' },
    resolve: () => 'repo', assigneeOf: () => null,
  };
  const options = {
    createClient: () => fakeClient,
    onCardCallback: (_project, id) => triaged.push(id),
  };

  await pollSource(source, () => ({ path: repo, name: 'repo' }), options);
  batch = [message(2)]; // UID 2 was previously Seen and has now been marked unread
  await pollSource(source, () => ({ path: repo, name: 'repo' }), options);

  assert.equal(cardFiles(repo).length, 3);
  assert.equal(triaged.length, 3);
  assert.deepEqual(selectors.map((selector) => selector.uid), ['1:*', '1:*'],
    'markSeen mailboxes query all unseen UIDs instead of hiding older unread mail behind a cursor');
});

test('pollSource: human bug reports about automated-mail features stay work and trigger triage', async () => {
  isolateHome();
  const repo = makeRepo();
  const cases = [
    ['Unsubscribe endpoint returns 500', 'The unsubscribe endpoint returns a 500 after submitting the account form.'],
    ['Manage preferences page returns 500', 'When I click manage your email preferences, the server returns a 500.'],
    ['View-in-browser link is broken', 'The view this email in browser link returns a 404 for customer receipts.'],
    ['Out-of-office settings fail to save', 'The out-of-office settings form loses the selected return date after saving.'],
    ['Leave settings fail to save', 'I am on leave settings page and the return date form returns a 500.'],
    ['Annual leave screen cannot save changes', 'I am on the annual leave screen and the Save button is disabled.'],
    ['OOO notification bug', 'OOO notifications are not delivered when the schedule begins.'],
    ['Vacation response strips Unicode', 'The vacation response editor removes accented characters from the saved template.'],
    ['Delivery failed alert has wrong link', 'The delivery failed alert links to the wrong message in the activity view.'],
    ['Ошибка экспорта', 'Кнопка экспорта возвращает ошибку при сохранении отчёта.'],
  ];
  const messages = [];
  for (const [i, [subject, detail]] of cases.entries()) {
    const raw = rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      `Subject: ${subject}`,
      `Message-ID: <footer-feature-bug-${i}@example.com>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      detail,
      'Please investigate the server error and add a regression test for this workflow.',
      '',
    ]);
    assert.equal(screenEmail(await simpleParser(raw)).verdict, 'work', subject);
    messages.push({ uid: i + 1, source: Buffer.from(raw) });
  }

  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: messages.length + 1 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { yield* messages; },
    async logout() {},
  };
  const source = {
    label: 'footer-feature-regression',
    conf: { host: 'imap.example.com', user: 'inbox', pass: 'secret', markSeen: false },
    resolve: () => 'repo', assigneeOf: () => null,
  };
  const triaged = [];
  await pollSource(source, () => ({ path: repo, name: 'repo' }), {
    createClient: () => fakeClient,
    onCardCallback: (_project, id) => triaged.push(id),
  });

  assert.equal(cardFiles(repo).length, cases.length);
  assert.equal(triaged.length, cases.length, 'normal work still reaches the triage callback');
  for (const id of triaged) assert.equal(readCard(repo, id).data.status, 'Review');
});

test('pollSource: a trailing unsubscribe URL and postal block are screened as a footer', async () => {
  isolateHome();
  const repo = makeRepo();
  const raw = rawEmail([
    'From: Shop <no-reply@shop.example.com>',
    'To: intake@example.com',
    'Subject: Your weekly store offers',
    'Message-ID: <legal-footer@shop.example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This week only: save on products from every department in our store.',
    '',
    'Unsubscribe: https://shop.example.com/unsubscribe/account-123',
    'Shop Example LLC',
    '123 Market Street, New York, NY 10001',
    '',
  ]);
  const parsed = await simpleParser(raw);
  const verdict = screenEmail(parsed);
  assert.equal(verdict.verdict, 'spam');
  assert.deepEqual(verdict.signals, ['noreply-sender', 'unsubscribe-footer']);

  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: 2 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch() { yield { uid: 1, source: Buffer.from(raw) }; },
    async logout() {},
  };
  const triaged = [];
  await pollSource({
    label: 'legal-footer-regression',
    conf: { host: 'imap.example.com', user: 'inbox', pass: 'secret', markSeen: false },
    resolve: () => 'repo', assigneeOf: () => null,
  }, () => ({ path: repo, name: 'repo' }), {
    createClient: () => fakeClient,
    onCardCallback: (_project, id) => triaged.push(id),
  });

  assert.equal(cardFiles(repo).length, 0);
  assert.equal(auditLines(repo).length, 1);
  assert.deepEqual(triaged, []);
});

test('pollSource: conventional auto-response and unsubscribe-link variants do not enter triage', async () => {
  isolateHome();
  const repo = makeRepo();
  const messages = [
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Auto Response: Ticket received',
      'Message-ID: <auto-response@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is an automated response confirming that your message was received.',
      '',
    ]),
    rawEmail([
      'From: Shop <no-reply@shop.example.com>',
      'To: intake@example.com',
      'Subject: This week at the shop',
      'Message-ID: <unsubscribe-link@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See the newest products and offers selected for your account.',
      '',
      'Click the unsubscribe link below.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Automated response: Ticket received',
      'Message-ID: <automated-response@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'We have received your request and a support agent will reply soon.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Automatic response: Ticket received',
      'Message-ID: <automatic-response@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'We have received your request and a support agent will reply soon.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Automated reply: Ticket received',
      'Message-ID: <automated-reply@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is an automated reply. We have received your request and a support agent will respond soon.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Auto Reply - Ticket received',
      'Message-ID: <auto-reply-dash@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'We have received your request and a support agent will respond soon.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: [Auto-Reply] Ticket received',
      'Message-ID: <auto-reply-bracket@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'We have received your request and a support agent will respond soon.',
      '',
    ]),
    rawEmail([
      'From: Support <support@example.com>',
      'To: intake@example.com',
      'Subject: Autoresponder: Ticket received',
      'Message-ID: <autoresponder@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is an autoresponder message confirming receipt.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <away-until@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am away until August 12 and will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <automatic-response-in-sentence@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your email. This is an automatic response. I will reply after August 5.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <ooo-until@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'OOO until Monday. I will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <annual-leave@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am currently on annual leave and will reply next week.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <on-leave-until@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am on leave until August 5 and will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <future-out-of-office@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your email. I will be out of the office until August 12 and will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Out of Office AutoReply: Export failure',
      'Message-ID: <ooo-autoreply@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your message. I will return on August 12 and reply then.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <smart-apostrophe-ooo@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your message. I’m currently out of the office until August 12.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <on-holiday@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your message. I am on holiday until August 12 and will reply when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <maternity-leave@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am on maternity leave until August 12 and will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <parental-leave@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am on parental leave through September and will respond when I return.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <currently-out-of-office@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Currently out of the office until August 12 and returning the following Monday.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <terminal-annual-leave@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thank you for your message. I am currently on annual leave.',
      '',
    ]),
    rawEmail([
      'From: Jane Doe <jane@example.com>',
      'To: intake@example.com',
      'Subject: Re: Export failure',
      'Message-ID: <punctuated-parental-leave@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I am on parental leave, returning September 3.',
      '',
    ]),
    rawEmail([
      'From: Shop <no-reply@shop.example.com>',
      'To: intake@example.com',
      'Subject: Monthly shop news',
      'Message-ID: <to-unsubscribe@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'New products and offers are available this month.',
      '',
      'To unsubscribe, click here: https://shop.example.com/leave',
      '',
    ]),
    rawEmail([
      'From: Shop <no-reply@shop.example.com>',
      'To: intake@example.com',
      'Subject: More shop news',
      'Message-ID: <unsubscribe-here@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Another collection of products selected for your account.',
      '',
      'Unsubscribe here: https://shop.example.com/leave',
      '',
    ]),
  ];
  const expected = [
    'unclear', 'spam', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear',
    'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear',
    'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'unclear', 'spam', 'spam',
  ];
  for (const [i, verdict] of expected.entries()) {
    assert.equal(screenEmail(await simpleParser(messages[i])).verdict, verdict);
  }

  const fakeClient = {
    mailbox: { uidValidity: '1', uidNext: messages.length + 1 },
    on() { return this; },
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch() {
      for (const [i, raw] of messages.entries()) yield { uid: i + 1, source: Buffer.from(raw) };
    },
    async logout() {},
  };
  const triaged = [];
  await pollSource({
    label: 'explicit-automation-regression',
    conf: { host: 'imap.example.com', user: 'inbox', pass: 'secret', markSeen: false },
    resolve: () => 'repo', assigneeOf: () => null,
  }, () => ({ path: repo, name: 'repo' }), {
    createClient: () => fakeClient,
    onCardCallback: (_project, id) => triaged.push(id),
  });

  assert.equal(cardFiles(repo).length, 21, 'only the held auto-responses create cards');
  for (const file of cardFiles(repo)) {
    assert.equal(readCard(repo, file.match(/task-\d+/)[0]).data.status, 'Needs Human');
  }
  assert.equal(auditLines(repo).length, messages.length);
  assert.deepEqual(triaged, []);
});

test('intakeMessage: a real bug report, parsed by mailparser, becomes a Review card', async () => {
  isolateHome();
  const repo = makeRepo();

  const out = await intakeMessage({ path: repo, name: 'repo' }, await simpleParser(RAW_BUG_REPORT), { label: 'main' });

  assert.equal(out.verdict, 'work');
  assert.equal(out.created, true);
  const card = readCard(repo, out.id);
  assert.equal(card.data.status, 'Review');
  assert.match(card.data.title, /Export button 500s/);
  assert.equal(card.data.needs_human_reason || '', '');
  assert.equal(auditLines(repo).at(-1).card, out.id);
});
