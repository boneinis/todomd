import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A cross-PROCESS lock for a repo's `.todomd` writes. board.js's withRepoLock
// only serializes writers inside one process; it can't see a separate
// budget-mode `/todomd-dispatch` session (which commits via its own shell git)
// or a second server. This lock is the shared serialization point: the JS
// pipeline acquires it here, and the dispatch command acquires the SAME
// `.todomd/.lock` from the shell. Atomic `mkdir` is the primitive; a held lock
// older than STALE_SEC is assumed crashed and stolen.
//
// owner file format (must match the dispatch prompt's shell exactly so either
// side can read/steal the other's lock): "<epoch-seconds> <who>\n".
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
  return `${user}@${os.hostname()}`;
}

// Atomic create-or-fail. Returns true if we now hold the lock.
function tryAcquire(dir) {
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner'), `${nowSec()} ${whoami()}\n`);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

// Remove the lock only if its owner timestamp is older than STALE_SEC. A
// missing owner means the holder is mid-creation (not stale) — leave it.
function stealIfStale(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'owner'), 'utf8'); }
  catch { return; }
  const ts = parseInt(raw.split(' ')[0], 10);
  if (Number.isFinite(ts) && nowSec() - ts > STALE_SEC) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export async function acquireFileLock(repoPath) {
  const dir = lockDir(repoPath);
  fs.mkdirSync(path.dirname(dir), { recursive: true }); // ensure .todomd exists
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!tryAcquire(dir)) {
    stealIfStale(dir);
    if (Date.now() > deadline) throw new Error(`todomd: could not acquire ${dir} (held too long)`);
    await sleep(POLL_MS);
  }
  return dir;
}

export function releaseFileLock(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Run fn while holding the on-disk lock; always release, even on throw.
export async function withFileLock(repoPath, fn) {
  const dir = await acquireFileLock(repoPath);
  try { return await fn(); }
  finally { releaseFileLock(dir); }
}
