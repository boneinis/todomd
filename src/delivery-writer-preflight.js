import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { admissionHeld, admissionStatus } from './delivery-admission.js';
import { projectAdmissionDirectory } from './delivery-paths.js';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const hash = v => createHash('sha256').update(v).digest('hex');
const active = new Set(['Triage', 'Plan', 'Queue', 'Build', 'CI', 'Verify']);
const messages = {
  state_unavailable: 'A required writer record is unreadable or malformed; reconcile it before admission.',
  configuration_unavailable: 'Working and committed execution configuration must both be readable and valid.',
  interactive_sessions_unfenced: 'Budget mode permits interactive sessions outside the supervised transaction; stop and reconcile those sessions.',
  remote_authority_required: 'Remote work requires authoritative submission and closure reconciliation; a local exit or CI result is insufficient.',
  legacy_task_active: 'A legacy task is queued or active; reconcile its existing work before delivery admission.',
  legacy_lease_present: 'A legacy dispatcher lease remains recorded; expiry does not prove the writer stopped.',
  coordination_pending: 'The coordination manifest contains work or unrecognized content requiring reconciliation.',
  repository_lock_pending: 'A repository lock remains present; inspect its owner instead of assuming age proves closure.',
  admission_pending: 'Project admission is held or requires recovery.',
  legacy_run_recorded: 'The runtime mirror records a legacy execution for this project; reconcile it even if its PID is absent.',
  legacy_run_unresolved: 'A recorded execution cannot be mapped uniquely to a canonical project; its scope requires reconciliation.',
};

// This is a negative admission check, never affirmative execution authority.
// Reads no credentials/output, signals no process, and creates no files/locks.
export function deliveryWriterPreflight(repoPath) {
  const blockers = [], sources = [];
  const add = (code, taskId) => {
    const value = { code, message: messages[code], ...(identity(taskId) ? { task_id: taskId } : {}) };
    if (!blockers.some(b => b.code === code && b.task_id === value.task_id)) blockers.push(value);
  };
  function read(file, label, optional = false) {
    let fd;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('Invalid record');
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid record');
      const raw = fs.readFileSync(fd, 'utf8'); sources.push([label, hash(raw)]); return raw;
    } catch (e) {
      if (optional && e.code === 'ENOENT') { sources.push([label, 'absent']); return null; }
      sources.push([label, 'unavailable']); throw e;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function config(raw) {
    const value = yaml.load(raw);
    if (!object(value) || value.mode !== undefined && !['budget', 'launcher'].includes(value.mode) ||
      value.ci !== undefined && (!object(value.ci) || value.ci.execution !== undefined && !['local', 'remote'].includes(value.ci.execution))) throw new Error('Invalid configuration');
    if (value.mode === 'budget') add('interactive_sessions_unfenced');
    if (value.ci?.execution === 'remote') add('remote_authority_required');
  }
  try {
    const repo = fs.realpathSync(repoPath), board = path.join(repo, '.todomd');
    // Reject directory symlinks as well as final-file symlinks.
    for (const dir of [board, path.join(board, 'tasks')]) if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid board directory');
    try { config(read(path.join(board, 'config.yml'), 'working-config')); }
    catch { add('configuration_unavailable'); }
    try {
      const committed = execFileSync('git', ['show', 'HEAD:.todomd/config.yml'], { cwd: repo, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      sources.push(['committed-config', hash(committed)]); config(committed);
    } catch { sources.push(['committed-config', 'unavailable']); add('configuration_unavailable'); }
    for (const file of fs.readdirSync(path.join(board, 'tasks')).filter(f => f.endsWith('.md')).sort()) {
      try {
        const raw = read(path.join(board, 'tasks', file), `task:${file}`);
        const frontmatter = raw.match(/^\uFEFF?---(?:yaml)?\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const task = frontmatter && yaml.load(frontmatter[1]);
        if (!object(task) || !identity(task.id) || typeof task.status !== 'string') throw new Error('Invalid task');
        if (active.has(task.status)) add('legacy_task_active', task.id);
        // Never use lease expiry, archive status, Done, or caller-authored
        // ci_evidence as proof that an old writer/remote submission is closed.
        if (task.lease !== undefined && task.lease !== null && task.lease !== '') add('legacy_lease_present', task.id);
        if (task.ci_execution === 'remote') add('remote_authority_required', task.id);
      } catch { add('state_unavailable'); }
    }
    try {
      const manifest = read(path.join(board, 'ACTIVE.md'), 'coordination', true);
      if (manifest !== null) {
        const content = manifest.replace(/<!--[\s\S]*?-->/g, '').replace(/^# Active work\s*$/gm, '').replace(/^_No active work\._\s*$/gm, '').trim();
        if (content) add('coordination_pending');
      }
    } catch { add('state_unavailable'); }
    const gate = projectAdmissionDirectory(repo), ownScope = admissionHeld(gate);
    // Modern board writers acquire the file lock before waiting for admission.
    // Within our gate they cannot write; treating that waiter as a new veto
    // would spuriously reject a launch. Raw scripts still need trusted fencing.
    try { fs.lstatSync(path.join(board, '.lock')); sources.push(['repository-lock', 'present']); if (!ownScope) add('repository_lock_pending'); }
    catch (e) { if (e.code !== 'ENOENT') add('state_unavailable'); else sources.push(['repository-lock', 'absent']); }
    const admission = admissionStatus(gate);
    sources.push(['admission', hash(JSON.stringify(admission))]);
    // The authority invokes this again inside its own revocable gate scope.
    if (admission.owner && !ownScope) add('admission_pending');
    const home = path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd');
    try {
      try { if (!fs.lstatSync(home).isDirectory()) throw new Error('Invalid runtime directory'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const raw = read(path.join(home, 'runs.json'), 'run-mirror', true), runs = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(runs) || runs.some(r => !object(r) || typeof r.project !== 'string' || !r.project)) throw new Error('Invalid run mirror');
      if (runs.length) {
        const registry = JSON.parse(read(path.join(home, 'projects.json'), 'project-registry'));
        if (!object(registry) || !Array.isArray(registry.projects) || registry.projects.some(p => !object(p) || typeof p.name !== 'string' || typeof p.path !== 'string' || !path.isAbsolute(p.path))) throw new Error('Invalid registry');
        for (const run of runs) {
          const matches = registry.projects.filter(p => p.name === run.project);
          if (matches.length !== 1) { add('legacy_run_unresolved'); continue; }
          try { if (fs.realpathSync(matches[0].path) === repo) add('legacy_run_recorded'); }
          catch { add('legacy_run_unresolved'); }
        }
      }
    } catch { add('state_unavailable'); }
  } catch { add('state_unavailable'); }
  return { version: 1, read_only: true, execution_enabled: false, atomic_snapshot: false,
    blockers, blocked: blockers.length > 0, revision: hash(JSON.stringify(sources)),
    writers_fenced: false, note: 'This scan can veto admission but cannot prove quiescence. Missing mirrors and a clear scan do not rule out old sessions or accepted remote jobs. Trusted writer fencing is still required at launch.' };
}

export function formatWriterPreflight(report) {
  return ['Delivery writer preflight — read only', 'Execution: disabled. This scan does not prove quiescence.',
    ...report.blockers.map(b => `${b.code}${b.task_id ? ` (${b.task_id})` : ''}: ${b.message}`),
    ...(report.blocked ? [] : ['No known blockers found; trusted writer fencing remains required.'])].join('\n');
}
