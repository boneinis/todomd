import path from 'node:path';
import { privateDirectory, refKey, writeOnce } from './delivery-local-state.js';
import { REMOTE_PATH, authorityId, digestId, remoteName, exactRef, readRemoteRecord } from './delivery-remote-state.js';

export function createRemoteDeliveryBackend(directory, { enabled = false, name, authorityId: authority,
  projectId, endpoint, credential, timeoutMs = 15000 } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid remote execution configuration.'); }
  if (!remoteName(name) || !authorityId(authority) || !digestId(projectId) || url.username || url.password || url.search || url.hash ||
    url.pathname !== REMOTE_PATH || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) ||
    typeof credential !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000) throw new Error('Invalid remote execution configuration.');
  const root = path.resolve(directory), file = path.join(root, `${name}.json`);
  const binding = { version: 1, backend: name, authority_id: authority, project_id: projectId, endpoint: url.href };
  const sealed = { ...binding, checksum: refKey(binding) };
  const verify = () => {
    try {
      if (!privateDirectory(root) || JSON.stringify(readRemoteRecord(file)) !== JSON.stringify(sealed)) throw new Error();
    } catch { throw new Error('Remote execution authority cannot be verified.'); }
  };
  if (enabled === true) { privateDirectory(root, true); writeOnce(file, sealed); verify(); }
  async function request(action, value) {
    if (enabled !== true) throw new Error('Remote delivery execution is not enabled.');
    const ref = exactRef(value, name); verify();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const token = credential();
      if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Credential unavailable.');
      response = await fetch(url.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-todomd-worker-token': token },
        body: JSON.stringify({ version: 1, authority_id: authority, project_id: projectId, action, execution: ref }) });
      if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') throw new Error('Invalid response.');
      let text = '';
      for await (const chunk of response.body) { text += Buffer.from(chunk).toString('utf8'); if (Buffer.byteLength(text) > 16384) throw new Error('Invalid response.'); }
      const body = JSON.parse(text);
      verify();
      if (!body || Object.keys(body).sort().join(',') !== 'action,authority_id,execution,project_id,result,version' || body.version !== 1 ||
        body.authority_id !== authority || body.project_id !== projectId || body.action !== action ||
        JSON.stringify(exactRef(body.execution, name)) !== JSON.stringify(ref) || !body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new Error('Invalid authority response.');
      const result = body.result, keys = Object.keys(result).sort().join(',');
      if (action === 'inspect') {
        if (keys !== 'closed,state' || !['running', 'unknown', 'stopped'].includes(result.state) || typeof result.closed !== 'boolean' ||
          result.closed !== (result.state === 'stopped')) throw new Error('Invalid closure evidence.');
        return { ...ref, ...result, reference: `remote-execution:${refKey(binding)}:${refKey(ref)}` };
      }
      if (action === 'close') {
        if (keys !== 'closed' || result.closed !== true) throw new Error('Unconfirmed closure.');
      } else if (keys !== 'accepted,closed,replayed' || Object.values(result).some(v => typeof v !== 'boolean') ||
        Object.values(result).filter(Boolean).length !== 1) throw new Error('Invalid start acknowledgement.');
      return result;
    } catch { throw new Error('Remote execution acknowledgement is unavailable; retain ownership and reconcile the exact identity.'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze(Object.fromEntries(['start', 'close', 'inspect'].map(action => [action, ref => request(action, ref)])));
}
