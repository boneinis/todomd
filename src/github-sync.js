import { execFile } from 'node:child_process';
import { loadConfig } from './board.js';

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
