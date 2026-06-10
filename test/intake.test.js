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

test('routeProject routes by To address (alias forwarding preserves original recipient)', async () => {
  const { routeProject } = await import('../src/intake.js');
  const routes = [
    { project: 'repo-a', toMatches: 'repo-a@me.com' },
    { project: 'repo-b', toMatches: 'you+repo-b@gmail.com' },
  ];
  // forwarded mail still addressed To the project alias
  assert.equal(routeProject(routes, null, { to: { value: [{ address: 'repo-a@me.com' }] } }), 'repo-a');
  // plus-address in To
  assert.equal(routeProject(routes, null, { to: { value: [{ address: 'you+repo-b@gmail.com' }] } }), 'repo-b');
  // no match → null, or the default
  assert.equal(routeProject(routes, null, { to: { value: [{ address: 'random@x.com' }] } }), null);
  assert.equal(routeProject(routes, 'triage', { to: { value: [{ address: 'random@x.com' }] } }), 'triage');
});

test('routeProject matches forwarding headers (Delivered-To / X-Forwarded-To)', async () => {
  const { routeProject } = await import('../src/intake.js');
  const routes = [{ project: 'repo-a', toMatches: 'repo-a@company.com' }];
  // Gmail-style: lands in todomd@, but the forward header keeps the original recipient
  const headers = new Map([
    ['delivered-to', 'todomd@gmail.com'],
    ['x-forwarded-to', 'repo-a@company.com'],
  ]);
  const parsed = { to: { value: [{ address: 'todomd@gmail.com' }] }, headers };
  assert.equal(routeProject(routes, null, parsed), 'repo-a');
});

test('intakeSources: a shared inbox becomes one source with routes', async () => {
  const home = isolateHome();
  const fs = await import('node:fs'); const path = await import('node:path');
  fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.todomd/intake.json'), JSON.stringify({
    accounts: { hub: { host: 'imap.gmail.com', user: 'todomd@gmail.com', pass: 'app-pw' } },
    inboxes: { main: { account: 'hub', folder: 'INBOX', default: 'triage',
      routes: [{ project: 'repo-a', toMatches: 'repo-a@x.com' }, { project: 'repo-b', toMatches: 'repo-b@x.com' }] } },
  }));
  const { intakeSources } = await import('../src/intake.js');
  const sources = intakeSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, 'inbox');
  assert.equal(sources[0].conf.host, 'imap.gmail.com'); // account merged
  assert.equal(sources[0].resolve({ to: { value: [{ address: 'repo-b@x.com' }] } }), 'repo-b');
  assert.equal(sources[0].resolve({ to: { value: [{ address: 'nope@x.com' }] } }), 'triage'); // default
});

test('routeProject accepts an array of toMatches', async () => {
  const { routeProject } = await import('../src/intake.js');
  const routes = [{ project: 'repo-a', toMatches: ['a@x.com', 'a-alt@x.com'] }];
  assert.equal(routeProject(routes, null, { to: { value: [{ address: 'a-alt@x.com' }] } }), 'repo-a');
});

test('intake auto-assigns: inbox route assignee, board assignee, inbox default', async () => {
  const { intakeSources } = await import('../src/intake.js');
  const home = isolateHome();
  const fs = await import('node:fs'); const path = await import('node:path');
  fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.todomd/intake.json'), JSON.stringify({
    accounts: { hub: { host: 'h', user: 'u', pass: 'p' } },
    boards: { 'repo-a': { account: 'hub', folder: 'A', assignee: 'bob' } },
    inboxes: { main: { account: 'hub', folder: 'INBOX', assignee: 'lead',
      routes: [{ project: 'repo-x', toMatches: 'x@co.com', assignee: 'carol' },
               { project: 'repo-y', toMatches: 'y@co.com' }] } },
  }));
  const sources = intakeSources();
  const board = sources.find((s) => s.label === 'repo-a');
  const inbox = sources.find((s) => s.label === 'main');
  assert.equal(board.assigneeOf(), 'bob');                                                  // board default
  assert.equal(inbox.assigneeOf({ to: { value: [{ address: 'x@co.com' }] } }), 'carol');    // route assignee
  assert.equal(inbox.assigneeOf({ to: { value: [{ address: 'y@co.com' }] } }), 'lead');     // inbox default (route has none)
  assert.equal(inbox.assigneeOf({ to: { value: [{ address: 'z@co.com' }] } }), 'lead');     // unmatched → inbox default
});
