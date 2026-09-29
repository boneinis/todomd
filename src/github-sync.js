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

async function treePaths(repoPath, ref) {
  const res = await run(repoPath, ['ls-tree', '-r', '-z', '--name-only', ref]);
  return res.ok ? res.stdout.split('\0').filter(Boolean) : [];
}

// null both for "doesn't exist" and for a lookup error — both mean "treat as absent".
async function blobSha(repoPath, ref, relPath) {
  const res = await run(repoPath, ['rev-parse', '--verify', '-q', `${ref}:${relPath}`]);
  return res.ok ? res.stdout : null;
}

// Local, per-clone bookkeeping of the last remote ref successfully merged —
// lives inside .git (never tracked, never part of the pushed .todomd subtree)
// so a fresh 3-way comparison is possible without needing shared commit
// ancestry between independently-cloned repos (which pushMetadata's
// `subtree split` deliberately does not preserve).
function stateFile(repoPath) {
  return path.join(repoPath, '.git', 'todomd-metadata-sync.json');
}
function readSyncState(repoPath) {
  try { return JSON.parse(fs.readFileSync(stateFile(repoPath), 'utf8')); } catch { return {}; }
}
function writeSyncState(repoPath, state) {
  try { fs.writeFileSync(stateFile(repoPath), JSON.stringify(state)); } catch {}
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

  const syncState = readSyncState(project.path);
  const stateKey = `${fetched.remote}#${fetched.branch}`;
  const lastRef = syncState[stateKey] || null;
  if (lastRef === fetched.ref) return { ok: true, applied: [], deferred: [], conflicts: [] };

  // Applying writes into the working tree; refuse if the board already has
  // uncommitted local edits so this can never clobber unsaved work.
  const dirty = await run(project.path, ['status', '--porcelain', '--', '.todomd']);
  if (dirty.stdout) return { ok: false, error: 'local board has uncommitted changes', applied: [], deferred: [], conflicts: [] };

  const remotePaths = await treePaths(project.path, fetched.ref);
  const basePaths = lastRef ? await treePaths(project.path, lastRef) : [];
  const applied = [], conflicts = [];

  for (const rel of new Set([...remotePaths, ...basePaths])) {
    const localRel = path.posix.join('.todomd', rel);
    const [remoteSha, baseSha, localSha] = await Promise.all([
      blobSha(project.path, fetched.ref, rel),
      lastRef ? blobSha(project.path, lastRef, rel) : Promise.resolve(null),
      blobSha(project.path, 'HEAD', localRel),
    ]);
    if (remoteSha === localSha) continue; // nothing to reconcile

    if (localSha === baseSha) {
      // local hasn't touched this file since the last sync — safe to take
      // whatever the remote side has now (an update, a new file, or a delete)
      const abs = path.join(project.path, localRel);
      if (remoteSha === null) fs.rmSync(abs, { force: true });
      else {
        const blob = await runRaw(project.path, ['show', `${fetched.ref}:${rel}`]);
        if (!blob.ok) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, blob.stdout);
      }
      applied.push(localRel);
    } else if (remoteSha === baseSha) {
      // remote hasn't changed since the last sync — the local edit stands
      continue;
    } else {
      // both sides changed (or were independently created with no shared
      // base) — never silently discard local intent; keep it and report it
      conflicts.push(localRel);
    }
  }

  if (applied.length) {
    const commit = await commitPaths(project.path, applied, 'chore(todomd): merge remote board metadata');
    if (!commit.committed) return { ok: false, error: commit.reason || 'could not commit merged board metadata', applied: [], deferred: conflicts, conflicts };
  }

  writeSyncState(project.path, { ...syncState, [stateKey]: fetched.ref });
  return { ok: true, applied, deferred: conflicts, conflicts };
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
