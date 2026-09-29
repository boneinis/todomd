import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './board.js';
import { commitPaths } from './git.js';

const clean = (value, fallback) => {
  const out = String(value || fallback).trim();
  return /^[A-Za-z0-9._/-]+$/.test(out) ? out : fallback;
};

function run(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }));
  });
}

// Raw (untrimmed, binary-safe) variant for reading actual file contents out
// of a tree — run() above trims, which would silently corrupt card files.
function runRaw(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout: error ? Buffer.alloc(0) : stdout }));
  });
}

async function treePaths(repoPath, ref, pathspec = []) {
  const res = await run(repoPath, ['ls-tree', '-r', '-z', '--name-only', ref, ...pathspec]);
  return res.ok ? res.stdout.split('\0').filter(Boolean) : [];
}

// null both for "doesn't exist" and for a lookup error — both mean "treat as absent".
async function blobSha(repoPath, ref, relPath) {
  const res = await run(repoPath, ['rev-parse', '--verify', '-q', `${ref}:${relPath}`]);
  return res.ok ? res.stdout : null;
}

// Git blob shas are content hashes, not history pointers — identical content
// hashes the same whether it was written by this repo or one that has never
// shared a commit with it. So even though pushMetadata's `subtree split`
// gives independently-cloned repos no common commit ancestry for the
// published branch, walking that branch's own history for one path can still
// find a real common ancestor: if `localSha` matches what the path held at
// some earlier point in the remote branch's history, nothing has touched
// the file locally since remote had that value — remote's current version is
// a safe fast-forward, not a conflict. (Local ABSENCE is deliberately not
// treated as such a match: a missing local file may be an intentional,
// committed local deletion, which mergeMetadata distinguishes by consulting
// local history instead.) This is what makes the very first
// sync of an already-existing, remotely-edited file work correctly: with no
// prior local sync-state, the naive last-synced-ref base is null even though
// a real common ancestor exists in the remote branch's own commits.
async function pathHistory(repoPath, ref, relPath) {
  const log = await run(repoPath, ['log', '--format=%H', ref, '--', relPath]);
  return log.ok ? log.stdout.split('\n').filter(Boolean) : [];
}

// Any commit touching the path (add, edit or delete) proves it existed at
// some point in that ref's history.
async function pathEverExisted(repoPath, ref, relPath) {
  return (await pathHistory(repoPath, ref, relPath)).length > 0;
}

async function historicalBaseMatches(repoPath, ref, relPath, localSha) {
  for (const commit of await pathHistory(repoPath, ref, relPath)) {
    if ((await blobSha(repoPath, commit, relPath)) === localSha) return true;
  }
  return false;
}

// Local, per-checkout bookkeeping of the last remote ref successfully merged —
// lives inside the git dir (never tracked, never part of the pushed .todomd
// subtree) so a fresh 3-way comparison is possible without needing shared
// commit ancestry between independently-cloned repos (which pushMetadata's
// `subtree split` deliberately does not preserve). The directory is resolved
// through git rather than assuming `<repo>/.git`: in a linked worktree `.git`
// is a FILE pointing at `.git/worktrees/<name>/`, so a hardcoded join fails.
// `--absolute-git-dir` (the per-worktree dir) is the right choice over the
// shared common dir because merges commit to this checkout's own HEAD, making
// "last remote ref merged" per-checkout state.
const SYNC_STATE_FILE = 'todomd-metadata-sync.json';
async function syncStateDir(repoPath) {
  const res = await run(repoPath, ['rev-parse', '--absolute-git-dir']);
  return res.ok && res.stdout ? res.stdout : null;
}
function readSyncState(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, SYNC_STATE_FILE), 'utf8')); } catch { return {}; }
}
// Returns null on success, an error message on failure. A state file that
// silently fails to persist downgrades every future sync to first-sync
// heuristics — exactly the failure callers need to hear about.
function writeSyncState(stateDir, state) {
  try { fs.writeFileSync(path.join(stateDir, SYNC_STATE_FILE), JSON.stringify(state)); return null; }
  catch (err) { return err?.message || String(err); }
}

// Publish only the tracked .todomd tree to a dedicated remote branch. This
// deliberately never pushes main, so a board update cannot publish unrelated
// local source commits or start the project's normal CI.
export async function pushMetadata(project) {
  const cfg = loadConfig(project.path).github_sync || {};
  if (cfg.enabled !== true) return { ok: true, skipped: 'disabled' };
  const remote = clean(cfg.remote, 'origin');
  const branch = clean(cfg.branch, 'todomd-state');
  const tracked = await run(project.path, ['ls-files', '--error-unmatch', '.todomd/config.yml']);
  if (!tracked.ok) return { ok: false, error: 'shared board files are not tracked yet' };
  const split = await run(project.path, ['subtree', 'split', '--prefix=.todomd']);
  if (!split.ok || !/^[0-9a-f]{40}$/i.test(split.stdout)) return { ok: false, error: split.stderr || 'could not build metadata branch' };
  const local = await run(project.path, ['branch', '-f', branch, split.stdout]);
  if (!local.ok) return { ok: false, error: local.stderr || 'could not update metadata branch' };
  const pushed = await run(project.path, ['push', remote, `${branch}:${branch}`]);
  return pushed.ok ? { ok: true, branch } : { ok: false, error: pushed.stderr || 'push failed' };
}

// Fetch the remote metadata branch, read-only. Never touches the working
// tree — mergeMetadata decides what (if anything) to apply from the result.
export async function fetchMetadata(project) {
  const cfg = loadConfig(project.path).github_sync || {};
  if (cfg.enabled !== true) return { ok: true, skipped: 'disabled' };
  const remote = clean(cfg.remote, 'origin');
  const branch = clean(cfg.branch, 'todomd-state');
  const fetched = await run(project.path, ['fetch', '--quiet', remote, branch]);
  if (!fetched.ok) {
    // Nothing has been published yet (a brand-new project, or the first
    // pushMetadata hasn't run) — not an error, just nothing to merge.
    if (/couldn't find remote ref|does not exist/i.test(fetched.stderr)) {
      return { ok: true, skipped: 'no-remote-branch', remote, branch };
    }
    return { ok: false, error: fetched.stderr || 'fetch failed', remote, branch };
  }
  const rev = await run(project.path, ['rev-parse', `${remote}/${branch}`]);
  return rev.ok ? { ok: true, remote, branch, ref: rev.stdout } : { ok: true, remote, branch, ref: null };
}

// Merge the fetched remote metadata branch (built by pushMetadata's
// `subtree split`) back into the local .todomd tree. Independently-cloned
// repos never share commit ancestry for that synthetic branch (subtree
// split rewrites every commit), so this does its own path-level 3-way
// merge — comparing each file against the last remote ref this clone
// successfully applied — rather than a git-history merge. Restricted to the
// .todomd prefix, so this can never touch source files or trigger normal
// code CI (see .github/workflows/ci.yml paths-ignore).
export async function mergeMetadata(project) {
  const fetched = await fetchMetadata(project);
  if (!fetched.ok || !fetched.ref) return { ok: fetched.ok, applied: [], deferred: [], conflicts: [],
    ...(fetched.skipped ? { skipped: fetched.skipped } : {}), ...(fetched.ok ? {} : { error: fetched.error }) };

  const stateDir = await syncStateDir(project.path);
  const syncState = stateDir ? readSyncState(stateDir) : {};
  const stateKey = `${fetched.remote}#${fetched.branch}`;
  const lastRef = syncState[stateKey] || null;
  if (lastRef === fetched.ref) return { ok: true, applied: [], deferred: [], conflicts: [] };

  // Applying writes into the working tree; refuse if the board already has
  // uncommitted local edits so this can never clobber unsaved work.
  const dirty = await run(project.path, ['status', '--porcelain', '--', '.todomd']);
  if (dirty.stdout) return { ok: false, error: 'local board has uncommitted changes', applied: [], deferred: [], conflicts: [] };

  const remotePaths = await treePaths(project.path, fetched.ref);
  const basePaths = lastRef ? await treePaths(project.path, lastRef) : [];
  // Local paths matter too: a file deleted remotely but still present locally
  // appears in NEITHER remotePaths nor (on a first sync) basePaths — without
  // this it would never be examined and remote deletions would never apply.
  const localPaths = (await treePaths(project.path, 'HEAD', ['--', '.todomd']))
    .map((p) => p.slice('.todomd/'.length));
  const applied = [], conflicts = [];

  const applyRemote = async (rel, localRel, remoteSha) => {
    const abs = path.join(project.path, localRel);
    if (remoteSha === null) fs.rmSync(abs, { force: true });
    else {
      const blob = await runRaw(project.path, ['show', `${fetched.ref}:${rel}`]);
      // a failed blob read must not vanish from the result: report it, and —
      // because unresolved entries keep the sync state from advancing — the
      // next poll retries it
      if (!blob.ok) { conflicts.push(localRel); return; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blob.stdout);
    }
    applied.push(localRel);
  };

  for (const rel of new Set([...remotePaths, ...basePaths, ...localPaths])) {
    const localRel = path.posix.join('.todomd', rel);
    const [remoteSha, baseSha, localSha] = await Promise.all([
      blobSha(project.path, fetched.ref, rel),
      lastRef ? blobSha(project.path, lastRef, rel) : Promise.resolve(null),
      blobSha(project.path, 'HEAD', localRel),
    ]);
    if (remoteSha === localSha) continue; // nothing to reconcile

    if (lastRef) {
      // a real per-checkout base exists — classic path-level 3-way merge
      if (localSha === baseSha) {
        // local hasn't touched this file since the last sync — safe to take
        // whatever the remote side has now (an update, a new file, or a delete)
        await applyRemote(rel, localRel, remoteSha);
      } else if (remoteSha === baseSha) {
        // remote hasn't changed since the last sync — the local edit stands
        continue;
      } else if (localSha !== null && await historicalBaseMatches(project.path, fetched.ref, rel, localSha)) {
        // local's current content is a real earlier point in the remote
        // branch's own history — remote's value is a safe fast-forward
        await applyRemote(rel, localRel, remoteSha);
      } else {
        // both sides changed — never silently discard local intent
        conflicts.push(localRel);
      }
    } else if (localSha === null) {
      // first sync; remote has the file, local doesn't. Only safe to take if
      // local history NEVER contained the path (a genuinely new remote file).
      // If local once had it and deleted it, that deletion was deliberate —
      // resurrecting the file would silently discard local intent.
      if (await pathEverExisted(project.path, 'HEAD', localRel)) conflicts.push(localRel);
      else await applyRemote(rel, localRel, remoteSha);
    } else if (remoteSha === null) {
      // first sync; local has the file, remote doesn't.
      if (await historicalBaseMatches(project.path, fetched.ref, rel, localSha)) {
        // remote once held exactly local's current content and later deleted
        // it — local hasn't diverged since, so the deletion fast-forwards
        await applyRemote(rel, localRel, null);
      } else if (await pathEverExisted(project.path, fetched.ref, rel)) {
        // both sides moved around a deletion — keep local, report it
        conflicts.push(localRel);
      }
      // else: a local-only file the remote never knew about — keep, silently
    } else if (await historicalBaseMatches(project.path, fetched.ref, rel, localSha)) {
      // no last-synced-ref base (this clone's very first sync), but local's
      // current content is itself a real earlier point in the remote
      // branch's own history — local hasn't diverged, so remote's current
      // value is still a safe fast-forward rather than a conflict
      await applyRemote(rel, localRel, remoteSha);
    } else {
      // independently created or independently edited with no shared base —
      // never silently discard local intent; keep it and report it
      conflicts.push(localRel);
    }
  }

  if (applied.length) {
    const commit = await commitPaths(project.path, applied, 'chore(todomd): merge remote board metadata');
    if (!commit.committed) {
      // commitPaths can legitimately refuse AFTER applyRemote already wrote
      // files (review_required policy, mid merge/rebase, add/commit failure).
      // Leaving those writes in place would trip the dirty-tree guard on every
      // later poll and wedge sync permanently — roll the worktree and index
      // back to HEAD. The pre-apply guard guarantees .todomd was clean, so this
      // restore + clean reproduces that state exactly (ignored paths such as
      // .todomd/runs are left alone).
      await run(project.path, ['restore', '--staged', '--worktree', '--source=HEAD', '--', '.todomd']);
      await run(project.path, ['clean', '-fd', '--', '.todomd']);
      return { ok: false, error: commit.reason || 'could not commit merged board metadata', applied: [], deferred: conflicts, conflicts };
    }
  }

  // Advance the stored ref ONLY when reconciliation completed. With
  // unresolved conflicts left in place, the next poll must re-derive and
  // re-report them — recording fetched.ref here would make that poll a clean
  // no-op, and the client would clear its conflict banner with nothing
  // actually resolved. Re-running against the same ref is idempotent:
  // already-applied files short-circuit on remoteSha === localSha.
  let warning = null;
  if (!conflicts.length) {
    warning = stateDir
      ? writeSyncState(stateDir, { ...syncState, [stateKey]: fetched.ref })
      : 'could not resolve the repository git directory';
    if (warning) warning = `merged, but sync state was not saved (${warning}); the next sync re-checks from scratch`;
  }
  return { ok: true, applied, deferred: conflicts, conflicts, ...(warning ? { warning } : {}) };
}

export function createMetadataScheduler({ onResult = () => {} } = {}) {
  const pending = new Map();
  const state = new Map();
  const schedule = (project, { done = false } = {}) => {
    const cfg = loadConfig(project.path).github_sync || {};
    if (cfg.enabled !== true) return;
    const normal = Math.max(1, Number(cfg.debounce_seconds) || 30) * 1000;
    const urgent = Math.max(1, Number(cfg.done_delay_seconds) || 10) * 1000;
    const max = Math.max(normal, Number(cfg.max_delay_seconds) || 120) * 1000;
    const key = project.path;
    const now = Date.now();
    const s = state.get(key) || { first: now, due: now + (done ? urgent : normal) };
    s.due = Math.min(s.first + max, now + (done ? urgent : normal));
    state.set(key, s);
    clearTimeout(pending.get(key));
    const timer = setTimeout(async () => {
      pending.delete(key); state.delete(key);
      const result = await pushMetadata(project);
      onResult(project, result);
    }, Math.max(0, s.due - now));
    timer.unref?.();
    pending.set(key, timer);
  };
  const close = () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); state.clear(); };
  return { schedule, close };
}
