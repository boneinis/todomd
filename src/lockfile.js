import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// A cross-PROCESS lock for a repo's `.todomd` writes. board.js's withRepoLock
// only serializes writers inside one process; it can't see a separate
// budget-mode `/todomd-dispatch` session (which commits via its own shell git)
// or a second server. This lock is the shared serialization point: the JS
// pipeline acquires it here, and the dispatch command acquires the SAME
// `.todomd/.lock` from the shell. Atomic `mkdir` is the primitive; a held lock
// older than STALE_SEC is assumed crashed and stolen.
//
// owner file format (the dispatch prompt's shell writes the same shape so either
// side can read/steal the other's lock): "<epoch-seconds> <who> <nonce>\n".
// Only field 1 (the timestamp) is read cross-side for staleness; the nonce is a
// per-acquisition fence so a holder never deletes a lock that was stolen from it.
const STALE_SEC = 300;        // a lock is held only for quick git ops; older = crashed owner
const POLL_MS = 100;
const MAX_WAIT_MS = 360_000;  // safety valve; stale-steal guarantees progress well before this

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockDir(repoPath) {
  return path.join(repoPath, '.todomd', '.lock');
}

function whoami() {
  let user = 'todomd';
  try { user = os.userInfo().username; } catch {}
  // short hostname, matching the dispatcher's `hostname -s` and coordination's
  // workerName() — so the same machine isn't seen as two different workers
  return `${user}@${os.hostname().split('.')[0]}`;
}

// Atomic create-or-fail. Returns true if we now hold the lock (with our nonce).
function tryAcquire(dir, nonce) {
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner'), `${nowSec()} ${whoami()} ${nonce}\n`);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

// Steal ATOMICALLY: rename the dir aside, and only the one racer whose rename
// succeeds gets to remove it — so two processes can't both `rm` and then both
// `mkdir` into a double-acquire.
function steal(dir) {
  const dead = `${dir}.dead.${process.pid}.${nowSec()}`;
  try { fs.renameSync(dir, dead); } catch { return; } // lost the race — another stealer moved it
  try { fs.rmSync(dead, { recursive: true, force: true }); } catch {}
}

// Steal a stale lock (owner older than STALE_SEC). A missing owner means the
// holder crashed between mkdir and the owner write (a live holder finishes
// that window in milliseconds) — fall back to the lock dir's own mtime, which
// mkdir set at creation; older than STALE_SEC can't be mid-creation, so steal.
function stealIfStale(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'owner'), 'utf8'); }
  catch {
    try {
      if (nowSec() - Math.floor(fs.statSync(dir).mtimeMs / 1000) <= STALE_SEC) return;
    } catch { return; }
    steal(dir);
    return;
  }
  const ts = parseInt(raw.split(' ')[0], 10);
  if (!Number.isFinite(ts) || nowSec() - ts <= STALE_SEC) return;
  steal(dir);
}

export async function acquireFileLock(repoPath) {
  const dir = lockDir(repoPath);
  fs.mkdirSync(path.dirname(dir), { recursive: true }); // ensure .todomd exists
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!tryAcquire(dir, nonce)) {
    stealIfStale(dir);
    if (Date.now() > deadline) throw new Error(`todomd: could not acquire ${dir} (held too long)`);
    await sleep(POLL_MS);
  }
  return { dir, nonce };
}

// Remove the lock only if it's still ours (the owner nonce matches) — so if our
// lock was stolen while we held it (only possible on a >STALE_SEC hold), we
// don't delete the new holder's lock.
export function releaseFileLock(dir, nonce) {
  try {
    if (nonce) {
      const owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8');
      if ((owner.split(/\s+/)[2] || '') !== nonce) return; // not ours anymore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* already gone */ }
}

// Run fn while holding the on-disk lock; always release, even on throw.
export async function withFileLock(repoPath, fn) {
  const { dir, nonce } = await acquireFileLock(repoPath);
  try { return await fn(); }
  finally { releaseFileLock(dir, nonce); }
}
