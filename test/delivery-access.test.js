import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeRepo, tmp } from './helpers.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { deliveryAccessCommand } from '../src/delivery-access-cli.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';

const cli = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
const job = `local-job-${'a'.repeat(64)}`;
function fixture() {
  isolateHome(); const repo = fs.realpathSync(makeRepo()); let at = 1000;
  const access = createDeliveryAccess(repo, { enabled: true, now: () => at });
  const issue = (fields = {}) => access.issue({ expected_revision: access.status().revision, actor_id: 'agent-role:builder', ttl_ms: 10000, ...fields });
  return { repo, access, issue, root: path.join(deliveryStoreDirectory(repo), 'access'), set at(value) { at = value; } };
}

test('default access is read-only and absent reads never provision credentials or policy', () => {
  isolateHome(); const repo = makeRepo(), access = createDeliveryAccess(repo);
  assert.equal(access.status().revision, 0);
  assert.equal(access.issue({}).code, 'disabled');
  assert.equal(access.revoke({}).code, 'disabled');
  assert.equal(access.setJobs({}).code, 'disabled');
  assert.equal(access.authenticate('tdmd_delivery_' + 'a'.repeat(64)), null);
  assert.equal(access.jobApproved(job), false);
  assert.equal(fs.existsSync(deliveryStoreDirectory(repo)), false);
});

test('credentials bind canonical project and owner, expire, and never persist in plaintext', () => {
  const f = fixture(), issued = f.issue(); assert.equal(issued.ok, true);
  assert.match(issued.token, /^tdmd_delivery_[a-f0-9]{64}$/);
  const alias = path.join(tmp('delivery-access-alias'), 'repo'); fs.symlinkSync(f.repo, alias);
  const other = createDeliveryAccess(makeRepo(), { enabled: true, now: () => 1000 });
  assert.equal(other.authenticate(issued.token), null);
  assert.equal(createDeliveryAccess(alias, { enabled: true, now: () => 1000 }).authenticate(issued.token).actor_id, 'agent-role:builder');
  assert.equal(f.access.authenticate('a'.repeat(32)), null, 'legacy tokens cannot become owner identities');
  assert.equal(f.access.authenticate(issued.token + 'x'), null);
  const saved = fs.readFileSync(path.join(f.root, '1.json'), 'utf8');
  assert.equal(saved.includes(issued.token), false);
  assert.equal(JSON.stringify(f.access.status()).includes('hash'), false);
  assert.equal(fs.statSync(path.join(f.root, '1.json')).mode & 0o777, 0o600);
  f.at = 10999; assert.ok(f.access.authenticate(issued.token));
  f.at = 11000; assert.equal(f.access.authenticate(issued.token), null);
  f.at = 999; assert.equal(f.access.authenticate(issued.token), null);
});

test('revocation and exact backend policy are fresh across existing access instances', () => {
  const f = fixture(), first = f.issue(), second = f.issue({ actor_id: 'human:owner', operator: true });
  const observer = createDeliveryAccess(f.repo, { enabled: true, now: () => 1000 });
  assert.equal(observer.authenticate(second.token).operator, true);
  assert.equal(f.access.setJobs({ expected_revision: 2, backends: [job] }).ok, true);
  assert.equal(observer.jobApproved(job), true);
  assert.equal(observer.jobApproved('local'), false);
  assert.equal(f.access.revoke({ expected_revision: 3, credential_id: first.credential_id }).ok, true);
  assert.equal(observer.authenticate(first.token), null);
  assert.ok(observer.authenticate(second.token));
  assert.equal(f.access.setJobs({ expected_revision: 4, backends: [] }).ok, true);
  assert.equal(observer.jobApproved(job), false);
});

test('invalid authority, stale revisions, and backwards clocks cannot write access history', () => {
  const f = fixture();
  for (const fields of [{ actor_id: 'invalid' }, { operator: true }, { ttl_ms: 1 }, { ttl_ms: 604800001 }, { grants: ['admin'] }, { actor_id: 'human:a', operator: 'yes' }]) {
    assert.equal(f.issue(fields).code, 'invalid_request');
  }
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(f.issue().ok, true);
  assert.equal(f.issue({ expected_revision: 0 }).code, 'revision_conflict');
  assert.equal(f.access.setJobs({ expected_revision: 1, backends: [job, job] }).code, 'invalid_request');
  assert.equal(f.access.revoke({ expected_revision: 1, credential_id: 'missing' }).code, 'unknown_credential');
  f.at = 900; assert.equal(f.issue().code, 'invalid_clock');
  assert.equal(f.access.status().revision, 1);
});

test('corrupt, missing, and symlinked access snapshots fail closed without replacement', () => {
  const f = fixture(), issued = f.issue();
  f.access.setJobs({ expected_revision: 1, backends: [job] });
  const file = path.join(f.root, '1.json'), good = fs.readFileSync(file);
  for (const damage of ['corrupt', 'missing', 'symlink']) {
    if (damage === 'corrupt') fs.writeFileSync(file, '{bad');
    else { fs.unlinkSync(file); if (damage === 'symlink') { const target = path.join(tmp('access-symlink'), 'record'); fs.writeFileSync(target, good); fs.symlinkSync(target, file); } }
    assert.equal(f.access.authenticate(issued.token), null);
    assert.equal(f.access.jobApproved(job), false);
    assert.equal(f.access.status().code, 'corrupt_access');
    assert.equal(f.access.revoke({ expected_revision: 2, credential_id: issued.credential_id }).code, 'corrupt_access');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.writeFileSync(file, good, { mode: 0o600 });
  }
  assert.ok(f.access.authenticate(issued.token));
});

test('CLI is explicit and rejects duplicate, malformed, and unsupported authority flags', () => {
  const f = fixture();
  for (const args of [[f.repo, 'issue'], [f.repo, 'issue', '--revision', '0', '--revision', '0'],
    [f.repo, 'issue', '--revision', '0', '--owner', 'agent-role:a', '--ttl-ms', '1000', '--operator'],
    [f.repo, 'status', '--owner', 'human:a'], [f.repo, 'jobs', '--revision', 'NaN'], [f.repo, 'activate']]) {
    assert.equal(deliveryAccessCommand(args).exit, 1);
  }
  assert.equal(deliveryAccessCommand([f.repo, 'status']).report.revision, 0);
  const issued = deliveryAccessCommand([f.repo, 'issue', '--revision', '0', '--owner', 'human:owner', '--ttl-ms', '60000', '--operator']);
  assert.equal(issued.exit, 0); assert.ok(issued.report.token);
  assert.equal(deliveryAccessCommand([f.repo, 'revoke', '--revision', '1', '--credential-id', issued.report.credential_id]).exit, 0);
});

test('independent CLI writers use one revision CAS and never overwrite a winner', async () => {
  const f = fixture();
  const run = () => new Promise(resolve => execFile(process.execPath, [cli, 'delivery-access', f.repo, 'jobs', '--revision', '0', '--backend', job],
    { env: { ...process.env } }, (error, stdout) => resolve({ code: error?.code || 0, report: JSON.parse(stdout) })));
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.deepEqual(results.map(r => r.report.ok).sort(), [false, true]);
  assert.equal(results.find(r => !r.report.ok).report.code, 'revision_conflict');
  assert.equal(f.access.status().revision, 1);
  assert.deepEqual(f.access.status().jobs, [job]);
});
