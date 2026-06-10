import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, sleep } from './helpers.js';
import { acquireFileLock, releaseFileLock, withFileLock } from '../src/lockfile.js';

function repoWithTodomd() {
  const repo = tmp('lock');
  fs.mkdirSync(path.join(repo, '.todomd'), { recursive: true });
  return repo;
}

test('withFileLock serializes concurrent critical sections (no interleave)', async () => {
  const repo = repoWithTodomd();
  const events = [];
  // Two "writers" that each mark enter/exit with an await in between. Without a
  // mutual-exclusion lock their enter/exit would interleave.
  async function writer(tag) {
    await withFileLock(repo, async () => {
      events.push(`${tag}:enter`);
      await sleep(30);
      events.push(`${tag}:exit`);
    });
  }
  await Promise.all([writer('A'), writer('B')]);
  // Whoever went first must fully exit before the other enters.
  const first = events[0].split(':')[0];
  const second = first === 'A' ? 'B' : 'A';
  assert.deepEqual(events, [`${first}:enter`, `${first}:exit`, `${second}:enter`, `${second}:exit`]);
  assert.equal(fs.existsSync(path.join(repo, '.todomd', '.lock')), false, 'lock released');
});

test('a held lock blocks a second acquirer until released', async () => {
  const repo = repoWithTodomd();
  const dir = await acquireFileLock(repo);
  let got = false;
  const waiter = acquireFileLock(repo).then((d) => { got = true; return d; });
  await sleep(120);
  assert.equal(got, false, 'second acquire must wait while the lock is held');
  releaseFileLock(dir);
  const d2 = await waiter;
  assert.equal(got, true);
  releaseFileLock(d2);
});

test('a stale lock (owner timestamp older than 5 min) is stolen', async () => {
  const repo = repoWithTodomd();
  const lock = path.join(repo, '.todomd', '.lock');
  fs.mkdirSync(lock, { recursive: true });
  const oldEpoch = Math.floor(Date.now() / 1000) - 400; // > 300s STALE_SEC
  fs.writeFileSync(path.join(lock, 'owner'), `${oldEpoch} ghost@crashed\n`);
  // Should steal the stale lock promptly rather than block.
  const dir = await acquireFileLock(repo);
  const owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
  assert.ok(!owner.includes('ghost@crashed'), 'stale owner replaced');
  releaseFileLock(dir);
});

test('owner format matches the dispatch shell protocol: "<epoch-seconds> <who>"', async () => {
  const repo = repoWithTodomd();
  const dir = await acquireFileLock(repo);
  const owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim();
  const [ts, who] = owner.split(' ');
  assert.match(ts, /^\d+$/, 'first field is epoch seconds (cut -d" " -f1 readable)');
  assert.ok(Number(ts) > 1_000_000_000 && Number(ts) < 10_000_000_000, 'plausible epoch seconds, not ms');
  assert.ok(who && who.includes('@'), 'second field is <user>@<host>');
  releaseFileLock(dir);
});
