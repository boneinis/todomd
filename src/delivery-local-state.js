import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
export function localRef(ref, backend) {
  if (!ref || !['task_id', 'lease_id', 'run_id', 'backend'].every(k => identity(ref[k])) ||
    ref.backend !== backend || !Number.isSafeInteger(ref.fence) || ref.fence < 1 ||
    !/^[a-f0-9]{64}$/.test(ref.source_revision)) throw new Error('Invalid local execution reference.');
  return Object.freeze(Object.fromEntries(['task_id', 'lease_id', 'run_id', 'fence', 'backend', 'source_revision'].map(k => [k, ref[k]])));
}
export const refKey = ref => createHash('sha256').update(JSON.stringify(ref)).digest('hex');
export const sealRegistration = record => ({ ...record, checksum: refKey(record) });
export function machineIdentity() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Local delivery execution requires macOS or Linux.');
  return { host: os.hostname(), boot: process.platform === 'linux'
    ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).trim() };
}
export function privateDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid local execution directory.');
    return true;
  } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
}
export function regularFile(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Invalid local execution file.');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// Immutable publication by exclusive hard link. No stale lock stealing and no
// overwrite window: concurrent starts/closures can only publish one claim.
export function writeOnce(file, value = {}) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try {
    try { fs.linkSync(temp, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      regularFile(file); syncDirectory(path.dirname(file)); return false;
    }
    syncDirectory(path.dirname(file)); return true;
  } finally { fs.unlinkSync(temp); }
}
export function readRegistration(directory, ref) {
  const file = path.join(directory, 'supervisor.json');
  let fd, record;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid supervisor registration.');
    record = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const { checksum, ...contents } = record || {};
  if (checksum !== refKey(contents) || record?.format !== 1 || JSON.stringify(localRef(record.ref, ref.backend)) !== JSON.stringify(ref) ||
    !Number.isSafeInteger(record.pid) || record.pid < 2 || !identity(record.nonce) ||
    typeof record.host !== 'string' || !record.host || typeof record.boot !== 'string' || !record.boot ||
    !/^\d+$/.test(record.socket_ino) || !/^\d+$/.test(record.socket_dev) ||
    record.socket !== `/tmp/todomd-delivery-${record.nonce}.sock`) throw new Error('Invalid supervisor registration.');
  return record;
}
export function cleanupSocket(record) {
  try {
    const stat = fs.lstatSync(record.socket, { bigint: true });
    if (stat.isSocket() && stat.ino.toString() === record.socket_ino && stat.dev.toString() === record.socket_dev) fs.unlinkSync(record.socket);
  } catch { /* already removed or replaced; never remove an unknown socket */ }
}
export async function groupAlive(pid, excludeLeader = false) {
  try { process.kill(-pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // A reparented zombie-only group can report EPERM on macOS. A successful
    // process-table read still distinguishes it from any surviving writer.
    if (error.code !== 'EPERM') throw error;
  }
  const { stdout, inspectionPid } = await new Promise((resolve, reject) => {
    const child = execFile('ps', ['-eo', 'pid=,pgid=,stat='], { maxBuffer: 4 * 1024 * 1024, timeout: 1000 },
      (error, stdout) => error ? reject(error) : resolve({ stdout, inspectionPid: child.pid }));
  });
  const rows = stdout.trim().split('\n');
  if (!stdout.trim() || rows.some(line => !/^\s*\d+\s+\d+\s+\S+\s*$/.test(line))) throw new Error('Process-group inspection is unavailable.');
  return rows.some(line => {
    const [member, group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && Number(member) !== inspectionPid &&
      (!excludeLeader || Number(member) !== pid) && !state?.startsWith('Z');
  });
}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
