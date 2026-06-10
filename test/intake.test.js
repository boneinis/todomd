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
