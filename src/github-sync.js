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

// Did THIS clone ever commit a change to the path? `rev-list HEAD --not
// <remote>/HEAD -- <path>` counts only commits unreachable from the code
// remote's default branch — inherited (cloned) commits are reachable, so an
// untouched file reports not-diverged and may fast-forward to whatever the
// remote holds now, while a locally-edited one is a genuine divergence and
// must conflict. Blob equality can't prove this: remote history A→B→C still
// contains B, but a local commit that independently made A→B diverged, and
// the published branch's squashed snapshot history can't distinguish the two.
// An unresolvable remote ref reports diverged — a conflict is the safe side.
async function localPathDiverged(repoPath, remote, localRel) {
  const res = await run(repoPath, ['rev-list', '--max-count=1', 'HEAD', '--not', `${remote}/HEAD`, '--', localRel]);
  return !res.ok || res.stdout.trim() !== '';
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
//
// The publish commit is parented on the fetched remote tip, NOT synthesized
// by `subtree split`: a split's history shares no ancestry with the remote
// branch, so once another clone has published (or this clone has merged a
// remote update via mergeMetadata) a plain push of a fresh split is a
// non-fast-forward rejection forever — the clone can never publish again.
// commit-tree with the remote tip as parent keeps the metadata branch linear;
// a remote that moved since our fetch rejects the push, and the next
// mergeMetadata + republish converges on the new tip.
// The metadata branch must be dedicated — never the code branch. With
// commit-tree publishing, `branch: main` would parent a metadata-only tree
// onto the remote's main tip as a legitimate fast-forward, deleting every
// source file and firing normal CI. Refuse the remote's default branch, the
// currently checked-out branch, and the obvious names outright.
async function dedicatedBranchError(project, remote, branch) {
  const forbidden = new Set(['main', 'master', 'HEAD']);
  const headSym = await run(project.path, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]);
  if (headSym.ok && headSym.stdout) forbidden.add(headSym.stdout.replace(`refs/remotes/${remote}/`, ''));
  const current = await run(project.path, ['branch', '--show-current']);
  if (current.ok && current.stdout) forbidden.add(current.stdout);
  return forbidden.has(branch)
    ? `github_sync.branch '${branch}' is a code branch — board sync requires a dedicated metadata branch`
    : null;
}

// A name check alone cannot protect a non-default code branch (`develop`,
// `release`, ...) — commit-tree publishing would happily fast-forward a
// metadata-only tree over it. Verify the fetched tip's *shape* instead: a
// metadata commit's root tree IS the .todomd contents (config.yml, tasks/,
// ...), while any branch carrying real source necessarily nests .todomd/ one
// level down — and a foreign non-code branch lacks the required config.yml.
async function remoteTipBranchError(repoPath, branch, tip) {
  const nested = await run(repoPath, ['rev-parse', '--verify', '-q', `${tip}:.todomd`]);
  if (nested.ok) return `github_sync.branch '${branch}' points at a code branch — board sync requires a dedicated metadata branch`;
  // .todomd/config.yml is required to be tracked before any publish, so it
  // is present at the root of every legitimately published metadata tree.
  const marker = await run(repoPath, ['rev-parse', '--verify', '-q', `${tip}:config.yml`]);
  if (!marker.ok) return `github_sync.branch '${branch}' does not look like a board metadata branch (no root config.yml) — refusing to sync over it`;
  return null;
}

export async function pushMetadata(project) {
  const cfg = loadConfig(project.path).github_sync || {};
  if (cfg.enabled !== true) return { ok: true, skipped: 'disabled' };
  const remote = clean(cfg.remote, 'origin');
  const branch = clean(cfg.branch, 'todomd-state');
  const branchError = await dedicatedBranchError(project, remote, branch);
  if (branchError) return { ok: false, error: branchError };
  // An unresolved merge must not publish: the applied half of a partial merge
  // commits locally, and pushing the whole .todomd tree would overwrite the
  // remote versions of still-conflicted/deferred paths with local copies.
  // The marker records each unresolved path's local blob at merge time — a
  // later edit (human resolution, or an in-flight run committing its result)
  // changes the blob and releases the guard.
  const pushStateDir = await syncStateDir(project.path);
  const pushStateKey = `${remote}#${branch}`;
  const unresolved = pushStateDir ? readSyncState(pushStateDir)[`${pushStateKey}:unresolved`] : null;
  if (unresolved?.paths) {
    let cleared = true;
    for (const [localRel, sha] of Object.entries(unresolved.paths)) {
      if ((await blobSha(project.path, 'HEAD', localRel)) === sha) { cleared = false; break; }
    }
    if (!cleared) return { ok: true, skipped: 'unresolved-sync', unresolved: Object.keys(unresolved.paths) };
    writeSyncState(pushStateDir, (({ [`${pushStateKey}:unresolved`]: _drop, ...rest }) => rest)(readSyncState(pushStateDir)));
  }
  const tracked = await run(project.path, ['ls-files', '--error-unmatch', '.todomd/config.yml']);
  if (!tracked.ok) return { ok: false, error: 'shared board files are not tracked yet' };
  const tree = await run(project.path, ['rev-parse', '--verify', '-q', 'HEAD:.todomd']);
  if (!tree.ok) return { ok: false, error: tree.stderr || 'could not resolve the .todomd tree' };
  // Best-effort fetch: an absent remote branch just means this is the first publish.
  const fetched = await run(project.path, ['fetch', '--quiet', remote, branch]);
  const remoteTip = fetched.ok ? (await run(project.path, ['rev-parse', '--verify', '-q', 'FETCH_HEAD'])).stdout || null : null;
  if (remoteTip) {
    const tipError = await remoteTipBranchError(project.path, branch, remoteTip);
    if (tipError) return { ok: false, error: tipError };
    const remoteTree = await run(project.path, ['rev-parse', '--verify', '-q', `${remoteTip}^{tree}`]);
    if (remoteTree.ok && remoteTree.stdout === tree.stdout) return { ok: true, branch, skipped: 'up-to-date' };
  }
  const commitArgs = ['commit-tree', tree.stdout, '-m', 'chore(todomd): publish board metadata'];
  if (remoteTip) commitArgs.push('-p', remoteTip);
  const commit = await run(project.path, commitArgs);
  if (!commit.ok || !/^[0-9a-f]{40}$/i.test(commit.stdout)) return { ok: false, error: commit.stderr || 'could not build metadata commit' };
  const local = await run(project.path, ['branch', '-f', branch, commit.stdout]);
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
  const branchError = await dedicatedBranchError(project, remote, branch);
  if (branchError) return { ok: false, error: branchError, remote, branch };
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
  if (!rev.ok) return { ok: true, remote, branch, ref: null };
  const tipError = await remoteTipBranchError(project.path, branch, rev.stdout);
  if (tipError) return { ok: false, error: tipError, remote, branch };
  return { ok: true, remote, branch, ref: rev.stdout };
}

// Merge the fetched remote metadata branch (built by pushMetadata's
// `subtree split`) back into the local .todomd tree. Independently-cloned
// repos never share commit ancestry for that synthetic branch (subtree
// split rewrites every commit), so this does its own path-level 3-way
// merge — comparing each file against the last remote ref this clone
// successfully applied — rather than a git-history merge. Restricted to the
// .todomd prefix, so this can never touch source files or trigger normal
// code CI (see .github/workflows/ci.yml paths-ignore).
// opts.deferCardIds — Set of card ids whose task files must not be written.
// A card with a live Plan/Build/CI/Verify run is being mutated by its agent;
// replacing its file mid-run would corrupt state under the runner's feet.
// Deferred paths are reported in `deferred` and, like conflicts, hold back
// the stored ref advance so the next poll re-derives them.
export async function mergeMetadata(project, { deferCardIds } = {}) {
  const deferred = [];
  const isDeferred = (localRel) => {
    if (!deferCardIds?.size) return false;
    const base = path.posix.basename(localRel, '.md');
    for (const id of deferCardIds) if (base === id || base.startsWith(id + '-')) return true;
    return false;
  };
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
    if (isDeferred(localRel)) { deferred.push(localRel); continue; } // in-flight run — never write mid-run

    if (lastRef) {
      // a real per-checkout base exists — classic path-level 3-way merge
      if (localSha === baseSha) {
        // local hasn't touched this file since the last sync — safe to take
        // whatever the remote side has now (an update, a new file, or a delete)
        await applyRemote(rel, localRel, remoteSha);
      } else if (remoteSha === baseSha) {
        // remote hasn't changed since the last sync — the local edit stands
        continue;
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
      if (!(await localPathDiverged(project.path, fetched.remote, localRel))) {
        // local never touched it — remote's absence is authoritative and the
        // deletion fast-forwards
        await applyRemote(rel, localRel, null);
      } else if (await pathEverExisted(project.path, fetched.ref, rel)) {
        // both sides moved around a deletion — keep local, report it
        conflicts.push(localRel);
      }
      // else: a local-only file the remote never knew about — keep, silently
    } else if (!(await localPathDiverged(project.path, fetched.remote, localRel))) {
      // no last-synced-ref base (this clone's very first sync), but local
      // never committed a change to the path — untouched inheritance, so
      // remote's value is a safe fast-forward
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
      return { ok: false, error: commit.reason || 'could not commit merged board metadata', applied: [], deferred, conflicts };
    }
  }

  // Advance the stored ref ONLY when reconciliation completed. With
  // unresolved conflicts left in place, the next poll must re-derive and
  // re-report them — recording fetched.ref here would make that poll a clean
  // no-op, and the client would clear its conflict banner with nothing
  // actually resolved. Re-running against the same ref is idempotent:
  // already-applied files short-circuit on remoteSha === localSha.
  let warning = null;
  if (!conflicts.length && !deferred.length) {
    warning = stateDir
      ? writeSyncState(stateDir, { ...syncState, [stateKey]: fetched.ref, [`${stateKey}:unresolved`]: undefined })
      : 'could not resolve the repository git directory';
    if (warning) warning = `merged, but sync state was not saved (${warning}); the next sync re-checks from scratch`;
  } else if (stateDir) {
    // Unresolved paths suppress publish until their local content changes —
    // see pushMetadata's unresolved-sync guard.
    const paths = {};
    for (const localRel of [...conflicts, ...deferred]) {
      paths[localRel] = await blobSha(project.path, 'HEAD', localRel);
    }
    writeSyncState(stateDir, { ...syncState, [`${stateKey}:unresolved`]: { ref: fetched.ref, paths } });
  }
  return { ok: true, applied, deferred, conflicts, ...(warning ? { warning } : {}) };
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
