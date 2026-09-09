import path from 'node:path';
import { createLocalDeliveryBackend } from './delivery-local-backend.js';
import { refKey } from './delivery-local-state.js';
import { REMOTE_PATH, exactRef, workerAuthority, remoteJob } from './delivery-remote-state.js';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const fields = ['task_id', 'lease_id', 'run_id', 'fence', 'backend', 'source_revision'];
const reply = (res, status, value) => {
  if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
};

// An opt-in handler for a dedicated worker service. The board server never
// mounts it. Authentication and start policy are request-bound host capabilities.
export function createRemoteDeliveryWorker(directory, { enabled = false, expectedAuthority, job,
  authenticate, authorizeStart, localOptions = {} } = {}) {
  const root = path.resolve(directory);
  if (!localOptions || typeof localOptions !== 'object' || Array.isArray(localOptions) || Object.keys(localOptions).some(k => !['graceMs', 'closeTimeoutMs'].includes(k))) throw new Error('Invalid remote stop options.');
  const configured = job === undefined ? null : remoteJob(job);
  const initial = enabled === true ? workerAuthority(root) : null;
  if (initial && (initial.authority_id !== expectedAuthority || configured && refKey(configured) !== initial.job_digest)) throw new Error('Remote worker configuration changed authority.');
  const verify = () => {
    const current = workerAuthority(root);
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new Error('Remote worker authority changed.');
    return current;
  };
  return async (req, res) => {
    if (enabled !== true) return reply(res, 503, { error: 'disabled' });
    if (req.method !== 'POST' || req.url !== REMOTE_PATH) return reply(res, 404, { error: 'not_found' });
    if ((!req.socket.encrypted && !loopback(req.socket.remoteAddress)) || req.headers.origin !== undefined ||
      req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'x-todomd-worker-token').length !== 1) return reply(res, 401, { error: 'not_authorized' });
    const credential = req.headers['x-todomd-worker-token'];
    const authenticated = () => {
      try { return typeof credential === 'string' && credential.length > 0 && credential.length <= 4096 && authenticate?.(credential) === true; }
      catch { return false; }
    };
    if (!authenticated()) return reply(res, 401, { error: 'not_authorized' });
    if (req.headers['content-type'] !== 'application/json') return reply(res, 415, { error: 'invalid_request' });
    let timer;
    try {
      // Bound slow and oversized requests without interpreting caller fields as
      // commands, paths, grants, or configuration.
      timer = setTimeout(() => req.destroy(), 5000); timer.unref?.();
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error('Invalid body'); }
      clearTimeout(timer);
      const request = JSON.parse(body), authority = verify();
      if (!request || Object.keys(request).sort().join(',') !== 'action,authority_id,execution,project_id,version' || request.version !== 1 ||
        request.authority_id !== authority.authority_id || request.project_id !== authority.project_id || !['start', 'close', 'inspect'].includes(request.action)) return reply(res, 409, { error: 'authority_mismatch' });
      const ref = exactRef(request.execution, authority.backend);
      if (!authenticated()) return reply(res, 401, { error: 'not_authorized' });
      if (request.action === 'start' && !configured) return reply(res, 409, { error: 'profile_unavailable' });
      const backend = createLocalDeliveryBackend(path.join(root, 'executions'), { ...localOptions, enabled: true, name: authority.backend,
        authorizeStart: async value => {
          verify(); if (!configured || !authenticated()) return false;
          const allowed = await authorizeStart?.(value, credential);
          verify(); return allowed === true && authenticated();
        },
        resolveJob: value => configured && { ...configured, args: configured.args.map(arg => {
          const key = fields.find(k => arg === `{${k}}`); return key ? String(value[key]) : arg;
        }) },
      });
      const result = await backend[request.action](ref);
      // Close may have succeeded before a credential was revoked. Denying its
      // response does not undo closure; a fresh credential can reconcile it.
      verify(); if (!authenticated()) return reply(res, 401, { error: 'not_authorized' });
      const safe = request.action === 'inspect' ? { state: result.state, closed: result.closed }
        : request.action === 'close' ? { closed: result.closed === true }
          : { accepted: result.accepted === true, closed: result.closed === true, replayed: result.replayed === true };
      reply(res, 200, { version: 1, authority_id: authority.authority_id, project_id: authority.project_id,
        action: request.action, execution: ref, result: safe });
    } catch { reply(res, 409, { error: 'execution_unavailable' }); }
    finally { clearTimeout(timer); }
  };
}
