import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One writer for the lifetime of a coordinator. Atomic snapshots contain
// independently scoped board records so policy/history changes commit together.
export function openAgentStore(directory) {
  const file = path.join(directory, 'state.json'), ownerDir = path.join(directory, 'owner');
  const nonce = randomUUID();
  let owned = false, closed = false, error = '';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    try { fs.mkdirSync(ownerDir); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = JSON.parse(fs.readFileSync(path.join(ownerDir, 'owner.json'), 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('invalid coordinator owner');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('another Board Agent service owns this directory');
      // Serialize dead-owner reclamation; a contender never removes a new owner.
      const reclaim = path.join(directory, 'reclaim');
      fs.mkdirSync(reclaim);
      try {
        const current = JSON.parse(fs.readFileSync(path.join(ownerDir, 'owner.json'), 'utf8'));
        if (current.nonce !== owner.nonce) throw new Error('coordinator ownership changed; retry');
        fs.rmSync(ownerDir, { recursive: true });
        fs.mkdirSync(ownerDir);
      } finally { fs.rmdirSync(reclaim); }
    }
    fs.writeFileSync(path.join(ownerDir, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
    owned = true;
  } catch (e) { error = String(e.message || e); }
  function assertOwner() {
    if (error || closed || !owned) throw new Error(error || 'Board Agent store is closed');
    const owner = JSON.parse(fs.readFileSync(path.join(ownerDir, 'owner.json'), 'utf8'));
    if (owner.nonce !== nonce) throw new Error('Board Agent ownership was lost');
  }
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Board Agent state cannot be read; restore state.json before running actions'); }
  }
  function save(state) {
    assertOwner();
    const temporary = `${file}.${nonce}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  function backup() {
    assertOwner();
    if (fs.existsSync(file)) {
      const backupFile = path.join(directory, 'state.v1.backup.json');
      if (fs.existsSync(backupFile)) {
        if (!fs.readFileSync(file).equals(fs.readFileSync(backupFile))) throw new Error('existing v1 backup differs; preserve both files before recovery');
      } else fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL);
    }
  }
  function close() {
    if (closed) return;
    if (owned) {
      try { assertOwner(); fs.rmSync(ownerDir, { recursive: true }); } catch { /* another owner */ }
    }
    closed = true;
  }
  return { read, save, backup, close, assertOwner, get error() { return error; } };
}
