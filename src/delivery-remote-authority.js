import path from 'node:path';
import { privateDirectory, refKey, writeOnce } from './delivery-local-state.js';
import { authorityId, digestId, remoteName, readRemoteRecord } from './delivery-remote-state.js';
import { createRemoteDeliveryBackend } from './delivery-remote-backend.js';

const identity = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const fields = ['backend', 'authority_id', 'project_id', 'job_digest', 'endpoint', 'credential_key'];
const fileFor = (directory, backend) => path.join(directory, 'remote-authorities', `${backend}.json`);

// Trusted configuration only. The shared project identity is explicitly mapped
// to this canonical repository; worker checkout paths need not match this host.
export function remoteProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...fields].sort().join() ||
    !authorityId(value.authority_id) || !digestId(value.project_id) || !digestId(value.job_digest) || !identity(value.credential_key) ||
    !remoteName(value.backend) || value.backend !== `remote-job-${refKey({ authority_id: value.authority_id, project_id: value.project_id, job_digest: value.job_digest })}`) {
    throw new Error('Invalid remote job registration.');
  }
  // Reuse the transport validator without writing pins or obtaining credentials.
  createRemoteDeliveryBackend('.', { name: value.backend, authorityId: value.authority_id, projectId: value.project_id,
    endpoint: value.endpoint, credential: () => null });
  return Object.freeze(Object.fromEntries(fields.map(k => [k, k === 'endpoint' ? new URL(value[k]).href : value[k]])));
}
const receipt = (repo, profile, binding) => ({ format: 1, repository: refKey(repo), profile, kind: 'remote_worker', ...binding });
export function registeredRemoteAuthority(directory, backend, repo) {
  if (!remoteName(backend) || !privateDirectory(path.join(directory, 'remote-authorities'))) return null;
  let record;
  try { record = readRemoteRecord(fileFor(directory, backend)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Remote job registration cannot be verified.'); }
  try {
    if (!identity(record?.profile)) throw new Error();
    const binding = remoteProfile(Object.fromEntries(fields.map(k => [k, record[k]])));
    const wanted = receipt(repo, record.profile, binding);
    if (binding.backend !== backend || JSON.stringify(record) !== JSON.stringify({ ...wanted, checksum: refKey(wanted) })) throw new Error();
    return Object.freeze({ profile: record.profile, ...binding });
  } catch { throw new Error('Remote job registration cannot be verified.'); }
}
export function registerRemoteAuthority(directory, repo, profile, value) {
  if (!identity(profile)) throw new Error('Invalid remote job profile.');
  const binding = remoteProfile(value), wanted = receipt(repo, profile, binding);
  privateDirectory(path.join(directory, 'remote-authorities'), true);
  writeOnce(fileFor(directory, binding.backend), { ...wanted, checksum: refKey(wanted) });
  const actual = registeredRemoteAuthority(directory, binding.backend, repo);
  if (JSON.stringify(actual) !== JSON.stringify({ profile, ...binding })) throw new Error('Remote job registration conflicts with its original authority.');
}

// Recovery consumes the original non-secret registration even without a launch
// profile. The credential capability is supplied by trusted host setup, never
// a card, request body, persisted token, or shared mutable request principal.
export function registeredRemoteBackend(directory, repo, name, { enabled = false, remoteCredential, remoteTimeoutMs } = {}) {
  const binding = registeredRemoteAuthority(directory, name, repo);
  if (!binding) throw new Error('Remote job registration is unavailable.');
  const verify = () => {
    if (JSON.stringify(registeredRemoteAuthority(directory, name, repo)) !== JSON.stringify(binding)) throw new Error('Remote job registration changed.');
  };
  const backend = createRemoteDeliveryBackend(path.join(directory, 'remote-pins'), { enabled, name,
    authorityId: binding.authority_id, projectId: binding.project_id, endpoint: binding.endpoint, timeoutMs: remoteTimeoutMs,
    credential: (action, execution) => {
      verify();
      const token = remoteCredential?.(Object.freeze({ repository: repo, ...binding, action, execution }));
      verify();
      return token;
    },
  });
  return Object.freeze(Object.fromEntries(['start', 'close', 'inspect'].map(action => [action, async ref => {
    verify(); const result = await backend[action](ref); verify(); return result;
  }])));
}
