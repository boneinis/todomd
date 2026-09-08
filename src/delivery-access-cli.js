import { createDeliveryAccess } from './delivery-access.js';

const usage = 'usage: todomd delivery-access <repo> status | issue --revision N --owner ID --ttl-ms N [--operator] | revoke --revision N --credential-id ID | jobs --revision N [--backend ID ...]';
export function deliveryAccessCommand(args) {
  const [repo, action, ...rest] = args;
  const allowed = { status: [], issue: ['--revision', '--owner', '--ttl-ms', '--operator'], revoke: ['--revision', '--credential-id'], jobs: ['--revision', '--backend'] };
  if (!repo || !Object.hasOwn(allowed, action)) return { exit: 1, report: { ok: false, code: 'invalid_request', usage } };
  const values = {}, backends = [];
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!allowed[action].includes(key) || key !== '--backend' && Object.hasOwn(values, key)) return { exit: 1, report: { ok: false, code: 'invalid_request', usage } };
    if (key === '--operator') { values[key] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) return { exit: 1, report: { ok: false, code: 'invalid_request', usage } };
    if (key === '--backend') backends.push(value); else values[key] = value;
  }
  try {
    const access = createDeliveryAccess(repo, { enabled: action !== 'status' });
    const revision = /^\d+$/.test(values['--revision'] || '') ? Number(values['--revision']) : NaN;
    const command = { expected_revision: revision };
    const report = action === 'status' ? access.status() : action === 'issue' ? access.issue({ ...command,
      actor_id: values['--owner'], ttl_ms: /^\d+$/.test(values['--ttl-ms'] || '') ? Number(values['--ttl-ms']) : NaN, operator: values['--operator'] === true })
      : action === 'revoke' ? access.revoke({ ...command, credential_id: values['--credential-id'] })
        : access.setJobs({ ...command, backends });
    return { exit: report.ok ? 0 : 1, report };
  } catch { return { exit: 1, report: { ok: false, code: 'access_unavailable' } }; }
}
