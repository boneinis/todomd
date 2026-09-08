import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireFileLock, releaseFileLock } from './lockfile.js';
import { withAdmission, retainAdmission } from './delivery-admission.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { createLocalDeliveryBackend } from './delivery-local-backend.js';
import { localRef, refKey, privateDirectory, writeOnce, pause } from './delivery-local-state.js';
import { loadBoard } from './board.js';

const fail = code => ({ ok: false, code });
function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid repository command record.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function verifyRepositoryCommand(directory, owner) {
  const { execution, lock_nonce } = owner.repository_command;
  const ref = localRef(execution, 'repository-write'), folder = path.join(directory, 'repository-writes', refKey(ref));
  const expected = { format: 1, ref, lock_nonce };
  if (!privateDirectory(path.join(directory, 'repository-writes')) || !privateDirectory(folder) ||
    JSON.stringify(readPrivate(path.join(folder, 'command.json'))) !== JSON.stringify({ ...expected, checksum: refKey(expected) })) throw new Error('Repository command authority cannot be verified.');
  return ref;
}

// Trusted local CLI only. This wraps one bounded shell transaction, not an
// interactive dispatcher session. Commands must stay within their process group.
export async function budgetWrite(repoPath, { command, args = [], timeoutMs = 30000 } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) return fail('unsupported_platform');
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args) || args.some(a => typeof a !== 'string') ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000) return fail('invalid_request');
  const repo = fs.realpathSync(repoPath), executable = fs.realpathSync(command), directory = deliveryStoreDirectory(repo), gate = path.join(directory, 'admission');
  if (!fs.statSync(executable).isFile() || !fs.statSync(path.join(repo, '.todomd/tasks')).isDirectory()) return fail('invalid_project');
  fs.accessSync(executable, fs.constants.X_OK);
  const jobArgs = [...args];
  const lock = await acquireFileLock(repo), run = randomUUID();
  const ref = localRef({ task_id: 'repository-write', lease_id: randomUUID(), run_id: run, fence: 1,
    backend: 'repository-write', source_revision: refKey({ repo, run }) }, 'repository-write');
  const root = path.join(directory, 'repository-writes'), folder = path.join(root, refKey(ref));
  try {
    privateDirectory(root, true); privateDirectory(folder, true);
    const receipt = { format: 1, ref, lock_nonce: lock.nonce };
    writeOnce(path.join(folder, 'command.json'), { ...receipt, checksum: refKey(receipt) });
    return await withAdmission(gate, 'repository', null, async () => {
      // Arbitrary shell transactions cannot safely edit a mixed managed board.
      // Check under admission, before any child can start or metadata can race.
      if (fs.readdirSync(directory).some(n => n.endsWith('.json') || n.endsWith('.lock')) ||
        loadBoard(repo, { includeArchived: true }).cards.some(c => c.unparseable || c.schema_version !== undefined && c.schema_version !== 1)) return fail('delivery_managed');
      const backend = createLocalDeliveryBackend(root, { enabled: true, name: ref.backend,
        authorizeStart: () => true, resolveJob: () => ({ command: executable, args: jobArgs, cwd: repo, containment: 'local_process_group' }) });
      let interrupted = false, timedOut = false, failed = false;
      const interrupt = () => { interrupted = true; };
      process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
      try {
        const deadline = Date.now() + timeoutMs;
        try {
          await backend.start(ref);
          while (!interrupted) {
            if ((await backend.inspect(ref)).state === 'stopped') break;
            if (Date.now() >= deadline) { timedOut = true; break; }
            await pause(25);
          }
        } catch { failed = true; }
        try {
          await backend.close(ref);
          const observed = await backend.inspect(ref);
          if (observed.state !== 'stopped' || observed.closed !== true) throw new Error('Unconfirmed closure.');
        } catch {
          retainAdmission(gate);
          return { ...fail('stop_unconfirmed'), run_id: run, recovery_required: true };
        }
        const output_file = path.join(folder, 'output.log');
        if (interrupted || timedOut || failed) return { ...fail(interrupted ? 'interrupted' : timedOut ? 'timeout' : 'command_uncertain'), output_file };
        let result;
        try { result = readPrivate(path.join(folder, 'result.json')); } catch { return { ...fail('command_uncertain'), output_file }; }
        return { ok: result.code === 0 && result.signal === null, code: result.code === 0 && result.signal === null ? 'completed' : 'command_failed',
          exit_code: Number.isInteger(result.code) ? result.code : null, output_file };
      } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    }, { repositoryCommand: { execution: ref, lock_nonce: lock.nonce } });
  } finally { releaseFileLock(lock.dir, lock.nonce); }
}
