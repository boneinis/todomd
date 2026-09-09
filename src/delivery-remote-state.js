import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory, refKey, writeOnce, localRef } from './delivery-local-state.js';

export const REMOTE_PATH = '/v1/delivery/execution';
export const remoteName = v => typeof v === 'string' && /^remote-job-[a-f0-9]{64}$/.test(v);
export const digestId = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const authorityId = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function exactRef(value, name) {
  const ref = localRef(value, name);
  if (Object.keys(value).length !== Object.keys(ref).length) throw new Error('Invalid remote reference.');
  return ref;
}
export function readRemoteRecord(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Invalid remote authority record.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid remote authority record.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function remoteJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['command', 'args', 'cwd', 'containment'].includes(k)) ||
    value.containment !== 'local_process_group' || typeof value.command !== 'string' || !path.isAbsolute(value.command) ||
    typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string')) throw new Error('Invalid remote job definition.');
  const command = fs.realpathSync(value.command), cwd = fs.realpathSync(value.cwd);
  if (!fs.statSync(command).isFile() || !fs.statSync(cwd).isDirectory()) throw new Error('Invalid remote job paths.');
  fs.accessSync(command, fs.constants.X_OK);
  return Object.freeze({ command, args: Object.freeze([...value.args]), cwd, containment: 'local_process_group' });
}
export function workerAuthority(directory) {
  if (!privateDirectory(directory)) throw new Error('Remote worker is not provisioned.');
  const r = readRemoteRecord(path.join(directory, 'authority.json'));
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Remote worker authority cannot be verified.');
  const expected = { version: 1, authority_id: r.authority_id, project_id: r.project_id, job_digest: r.job_digest,
    backend: `remote-job-${refKey({ authority_id: r.authority_id, project_id: r.project_id, job_digest: r.job_digest })}` };
  if (!authorityId(r.authority_id) || !digestId(r.project_id) || !digestId(r.job_digest) || JSON.stringify(r) !== JSON.stringify({ ...expected, checksum: refKey(expected) })) throw new Error('Remote worker authority cannot be verified.');
  return Object.freeze(expected);
}

// Explicit trusted-host provisioning, never an HTTP operation. Losing this
// store requires reconciliation; starting the handler never recreates it.
export function provisionRemoteDeliveryWorker(directory, { projectId, job } = {}) {
  if (!digestId(projectId)) throw new Error('A canonical shared project identity is required.');
  const configured = remoteJob(job), root = path.resolve(directory);
  privateDirectory(root, true);
  if (fs.readdirSync(root).length) throw new Error('Provision only an empty worker directory.');
  const binding = { authority_id: randomUUID(), project_id: projectId, job_digest: refKey(configured) };
  const record = { version: 1, ...binding, backend: `remote-job-${refKey(binding)}` };
  if (!writeOnce(path.join(root, 'authority.json'), { ...record, checksum: refKey(record) })) throw new Error('Worker provisioning raced another administrator.');
  return workerAuthority(root);
}
