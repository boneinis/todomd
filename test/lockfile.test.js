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
  const a = await acquireFileLock(repo);
  let got = false;
  const waiter = acquireFileLock(repo).then((r) => { got = true; return r; });
  await sleep(120);
  assert.equal(got, false, 'second acquire must wait while the lock is held');
  releaseFileLock(a.dir, a.nonce);
  const b = await waiter;
  assert.equal(got, true);
  releaseFileLock(b.dir, b.nonce);
});

test('a stale lock (owner timestamp older than 5 min) is stolen', async () => {
  const repo = repoWithTodomd();
  const lock = path.join(repo, '.todomd', '.lock');
  fs.mkdirSync(lock, { recursive: true });
  const oldEpoch = Math.floor(Date.now() / 1000) - 400; // > 300s STALE_SEC
  fs.writeFileSync(path.join(lock, 'owner'), `${oldEpoch} ghost@crashed ghost-nonce\n`);
  // Should steal the stale lock promptly rather than block.
  const a = await acquireFileLock(repo);
  const owner = fs.readFileSync(path.join(lock, 'owner'), 'utf8');
  assert.ok(!owner.includes('ghost@crashed'), 'stale owner replaced');
  releaseFileLock(a.dir, a.nonce);
});

test('an ownerless lock (crashed between mkdir and owner write) is stolen via dir mtime', async () => {
  const repo = repoWithTodomd();
  const lock = path.join(repo, '.todomd', '.lock');
  fs.mkdirSync(lock, { recursive: true }); // no owner file — the crash window
  const old = new Date(Date.now() - 400_000); // > 300s STALE_SEC
  fs.utimesSync(lock, old, old);
  // Must not deadlock: the mtime fallback proves it can't be mid-creation.
  const a = await acquireFileLock(repo);
  assert.ok(fs.existsSync(path.join(lock, 'owner')), 'lock re-acquired with a fresh owner');
  releaseFileLock(a.dir, a.nonce);
  assert.equal(fs.existsSync(lock), false, 'released cleanly');
});

test('a FRESH ownerless lock (holder mid-creation) is not stolen', async () => {
  const repo = repoWithTodomd();
  const lock = path.join(repo, '.todomd', '.lock');
  fs.mkdirSync(lock, { recursive: true }); // just created — mtime is now
  let got = false;
  const waiter = acquireFileLock(repo).then((r) => { got = true; return r; });
  await sleep(300); // a few poll cycles
  assert.equal(got, false, 'fresh ownerless dir still reads as mid-creation');
  releaseFileLock(lock, null); // simulate the holder finishing/cleaning up
  const a = await waiter;
  releaseFileLock(a.dir, a.nonce);
});

test('release is nonce-fenced: a foreign nonce will NOT delete the held lock', async () => {
  const repo = repoWithTodomd();
  const a = await acquireFileLock(repo);
  // simulate "my lock was stolen and re-taken by someone else": a release with
  // the wrong nonce must be a no-op (must not delete the current holder's lock)
  releaseFileLock(a.dir, 'some-other-nonce');
  assert.equal(fs.existsSync(a.dir), true, 'lock not deleted by a non-owner release');
  // the true owner can still release it
  releaseFileLock(a.dir, a.nonce);
  assert.equal(fs.existsSync(a.dir), false, 'owner release removes it');
});

test('owner format matches the dispatch shell protocol: "<epoch-seconds> <who> <nonce>"', async () => {
  const repo = repoWithTodomd();
  const a = await acquireFileLock(repo);
  const owner = fs.readFileSync(path.join(a.dir, 'owner'), 'utf8').trim();
  const [ts, who, nonce] = owner.split(' ');
  assert.match(ts, /^\d+$/, 'first field is epoch seconds (cut -d" " -f1 readable)');
  assert.ok(Number(ts) > 1_000_000_000 && Number(ts) < 10_000_000_000, 'plausible epoch seconds, not ms');
  assert.ok(who && who.includes('@'), 'second field is <user>@<host>');
  assert.ok(who && !who.includes('.'), 'host is short (no FQDN dots), matching `hostname -s`');
  assert.equal(nonce, a.nonce, 'third field is the acquisition nonce');
  releaseFileLock(a.dir, a.nonce);
});
