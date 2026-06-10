import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, writeCard, isolateHome } from './helpers.js';
import { emailToCardFields } from '../src/intake.js';
import { createCard, readCard } from '../src/board.js';

test('emailToCardFields maps subject/from/body and tags source=email', () => {
  const f = emailToCardFields({ subject: '  Login   loops\non Safari ', from: { text: 'Jane <jane@x.com>' }, text: 'Steps:\n1. open /login' });
  assert.equal(f.title, 'Login loops on Safari'); // whitespace collapsed
  assert.equal(f.source, 'email');
  assert.deepEqual(f.labels, ['email']);
  assert.match(f.description, /From:\*\* Jane <jane@x\.com>/);
  assert.match(f.description, /1\. open \/login/);
});

test('emailToCardFields handles empty subject / HTML-only / missing body', () => {
  assert.equal(emailToCardFields({}).title, '(no subject)');
  assert.match(emailToCardFields({ html: '<b>x</b>' }).description, /HTML-only/);
  assert.match(emailToCardFields({ text: '' }).description, /empty body/);
});

test('an email becomes a real card in Review via createCard', async () => {
  isolateHome();
  const repo = makeRepo();
  const card = await createCard(repo, emailToCardFields({ subject: 'Add export button', from: { text: 'a@b.com' }, text: 'please' }));
  assert.equal(card.ok, true);
  const c = readCard(repo, card.id);
  assert.equal(c.data.status, 'Review');
  assert.equal(c.data.source, 'email');
  assert.match(c.data.title, /Add export button/);
});

test('a malicious subject cannot break the card frontmatter', async () => {
  isolateHome();
  const repo = makeRepo();
  const card = await createCard(repo, emailToCardFields({ subject: 'pwn: [x] {y} #z\nstatus: Done', from: { text: 'e@v.il' }, text: 'x' }));
  assert.equal(card.ok, true);
  const c = readCard(repo, card.id);
  assert.ok(!c.parseError, 'card frontmatter must still parse');
  assert.equal(c.data.status, 'Review'); // not hijacked to Done
});

test('loadIntakeConfig: shared accounts merge into per-board configs (multi-project)', async () => {
  const home = isolateHome();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.todomd/intake.json'), JSON.stringify({
    accounts: { work: { host: 'imap.x.com', port: 993, user: 'me@x.com', pass: 'secret', secure: true } },
    boards: {
      'repo-a': { account: 'work', folder: 'todomd-a', pollSeconds: 120 },
      'repo-b': { account: 'work', folder: 'todomd-b' },
      'repo-c': { host: 'imap.y.com', user: 'other@y.com', pass: 'p2', folder: 'INBOX' }, // standalone
    },
  }));
  const cfg = (await import('../src/intake.js')).loadIntakeConfig();
  // account creds merged, board folder/interval preserved
  assert.equal(cfg['repo-a'].host, 'imap.x.com');
  assert.equal(cfg['repo-a'].pass, 'secret');
  assert.equal(cfg['repo-a'].folder, 'todomd-a');
  assert.equal(cfg['repo-a'].pollSeconds, 120);
  assert.equal(cfg['repo-b'].folder, 'todomd-b');     // distinct folder = distinct routing
  assert.equal(cfg['repo-b'].host, 'imap.x.com');     // same shared account
  assert.equal(cfg['repo-c'].host, 'imap.y.com');     // standalone board, its own creds
});

test('loadIntakeConfig: legacy inline format still works', async () => {
  const home = isolateHome();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.todomd/intake.json'), JSON.stringify({
    'repo-a': { host: 'imap.x.com', user: 'me@x.com', pass: 's', folder: 'todomd' },
  }));
  const cfg = (await import('../src/intake.js')).loadIntakeConfig();
  assert.equal(cfg['repo-a'].host, 'imap.x.com');
  assert.equal(cfg['repo-a'].folder, 'todomd');
});
