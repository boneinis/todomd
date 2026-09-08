import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isOwnerId } from './delivery.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { privateDirectory, refKey, writeOnce } from './delivery-local-state.js';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, fields) => object(v) && Object.keys(v).every(k => fields.includes(k));
const backend = v => typeof v === 'string' && /^local-job-[a-f0-9]{64}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = v => Number.isSafeInteger(v) && v >= 0;
const TOKEN = /^tdmd_delivery_[a-f0-9]{64}$/;
const MAX_TTL = 7 * 24 * 60 * 60 * 1000;
const fail = code => ({ ok: false, code });

// Local administrative capability, never exposed by an HTTP write route.
// Immutable numbered snapshots use exclusive publication as the revision CAS.
// This history is separate from admission so a stranded writer cannot prevent
// revocation. No bearer credential is persisted or included in status output.
export function createDeliveryAccess(repoPath, { enabled = false, now = Date.now } = {}) {
  const repo = fs.realpathSync(repoPath), root = path.join(deliveryStoreDirectory(repo), 'access');
  const empty = () => ({ format: 1, project: repo, revision: 0, previous: null, credentials: [], jobs: [] });
  function read() {
    if (!privateDirectory(root)) return empty();
    const names = fs.readdirSync(root).filter(n => /^\d+\.json$/.test(n)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    let previous = null, state = empty();
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== `${i + 1}.json`) throw new Error('Access history is incomplete.');
      const fd = fs.openSync(path.join(root, names[i]), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let record;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid access snapshot.');
        record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
      const { checksum, ...value } = record || {};
      if (!exact(value, ['format', 'project', 'revision', 'previous', 'credentials', 'jobs', 'event']) ||
        checksum !== refKey(value) || value.format !== 1 || value.project !== repo || value.revision !== i + 1 || value.previous !== previous ||
        !Array.isArray(value.credentials) || !Array.isArray(value.jobs) || !value.jobs.every(backend) || new Set(value.jobs).size !== value.jobs.length ||
        !exact(value.event, ['kind', 'at', 'credential_id']) || !['issue', 'revoke', 'jobs'].includes(value.event.kind) || !time(value.event.at)) throw new Error('Invalid access history.');
      const ids = new Set(), hashes = new Set();
      for (const c of value.credentials) {
        if (!exact(c, ['id', 'hash', 'actor_id', 'operator', 'issued_at', 'expires_at', 'revoked_at']) ||
          typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/.test(c.id) || !digest(c.hash) || !isOwnerId(c.actor_id) ||
          typeof c.operator !== 'boolean' || c.operator && !c.actor_id.startsWith('human:') || !time(c.issued_at) ||
          !time(c.expires_at) || c.expires_at <= c.issued_at || c.expires_at - c.issued_at > MAX_TTL ||
          !(c.revoked_at === null || time(c.revoked_at) && c.revoked_at >= c.issued_at) || ids.has(c.id) || hashes.has(c.hash)) throw new Error('Invalid credential record.');
        ids.add(c.id); hashes.add(c.hash);
      }
      previous = checksum; state = { ...value, checksum };
    }
    return state;
  }
  function update(kind, command) {
    if (enabled !== true) return fail('disabled');
    const allowed = { issue: ['expected_revision', 'actor_id', 'operator', 'ttl_ms'], revoke: ['expected_revision', 'credential_id'], jobs: ['expected_revision', 'backends'] };
    if (!exact(command, allowed[kind]) || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) return fail('invalid_request');
    let state;
    try { state = read(); } catch { return fail('corrupt_access'); }
    if (command.expected_revision !== state.revision) return fail('revision_conflict');
    const at = now();
    if (!time(at) || state.event && at < state.event.at) return fail('invalid_clock');
    const next = { format: 1, project: repo, revision: state.revision + 1, previous: state.checksum || null,
      credentials: state.credentials.map(c => ({ ...c })), jobs: [...state.jobs], event: { kind, at } };
    let token, credential;
    if (kind === 'issue') {
      if (!isOwnerId(command.actor_id) || !(command.operator === undefined || typeof command.operator === 'boolean') ||
        command.operator === true && !command.actor_id.startsWith('human:') || !Number.isSafeInteger(command.ttl_ms) ||
        command.ttl_ms < 1000 || command.ttl_ms > MAX_TTL || !time(at + command.ttl_ms)) return fail('invalid_request');
      token = `tdmd_delivery_${randomBytes(32).toString('hex')}`;
      credential = { id: randomUUID(), hash: refKey(token), actor_id: command.actor_id, operator: command.operator === true,
        issued_at: at, expires_at: at + command.ttl_ms, revoked_at: null };
      next.credentials.push(credential); next.event.credential_id = credential.id;
    } else if (kind === 'revoke') {
      credential = next.credentials.find(c => c.id === command.credential_id);
      if (!credential) return fail('unknown_credential');
      credential.revoked_at ??= at; next.event.credential_id = credential.id;
    } else {
      if (!Array.isArray(command.backends) || !command.backends.every(backend) || new Set(command.backends).size !== command.backends.length) return fail('invalid_request');
      next.jobs = [...command.backends].sort();
    }
    const record = { ...next, checksum: refKey(next) };
    if (Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) return fail('access_capacity');
    try {
      privateDirectory(root, true);
      if (!writeOnce(path.join(root, `${next.revision}.json`), record)) return fail('revision_conflict');
    } catch { return fail('commit_uncertain'); }
    return { ok: true, revision: next.revision, ...(credential ? { credential_id: credential.id } : {}),
      ...(token ? { token, expires_at: credential.expires_at } : {}) };
  }
  return Object.freeze({
    status() {
      try {
        const s = read();
        return { ok: true, revision: s.revision, project: repo, jobs: s.jobs,
          credentials: s.credentials.map(({ hash, ...c }) => c) };
      } catch { return fail('corrupt_access'); }
    },
    authenticate(token) {
      if (enabled !== true || typeof token !== 'string' || !TOKEN.test(token)) return null;
      try {
        const s = read(), at = now(), sent = Buffer.from(refKey(token), 'hex');
        if (!time(at) || s.event && at < s.event.at) return null;
        const c = s.credentials.find(c => timingSafeEqual(sent, Buffer.from(c.hash, 'hex')));
        return c && c.revoked_at === null && c.issued_at <= at && at < c.expires_at
          ? { actor_id: c.actor_id, project: repo, operator: c.operator } : null;
      } catch { return null; }
    },
    jobApproved(name) {
      if (enabled !== true || !backend(name)) return false;
      try { const s = read(), at = now(); return time(at) && (!s.event || at >= s.event.at) && s.jobs.includes(name); }
      catch { return false; }
    },
    issue: command => update('issue', command), revoke: command => update('revoke', command), setJobs: command => update('jobs', command),
  });
}
