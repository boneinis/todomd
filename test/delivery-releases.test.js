import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, makeRepo } from './helpers.js';
import {
  recordRelease,
  readRelease,
  listReleases,
  recordRollback,
  resolveTaskEvidence,
  validateReleaseRecord,
} from '../src/delivery-releases.js';

const VALID_COMMIT = '1234567890abcdef1234567890abcdef12345678';

test('delivery-releases: validation, recording, reading, and listing', () => {
  isolateHome();
  const repo = makeRepo();

  const validRecord = {
    schema_version: 2,
    release_id: 'rel-2026-09-001',
    environment: 'production',
    tasks: ['task-001', 'task-002'],
    deployed_commit: VALID_COMMIT,
    target_branch: 'main',
    approval: {
      approver: 'human:project-owner',
      approved_at: '2026-09-08T12:00:00Z',
    },
    deployment: {
      deployed: true,
      result: 'success',
      reference: 'deploy-run-99881',
      at: '2026-09-08T12:05:00Z',
    },
    verification: {
      verified: true,
      reference: 'health-check-ok',
      at: '2026-09-08T12:10:00Z',
    },
  };

  assert.equal(validateReleaseRecord(validRecord).ok, true);

  const recorded = recordRelease(repo, validRecord);
  assert.equal(recorded.release_id, 'rel-2026-09-001');

  const read = readRelease(repo, 'rel-2026-09-001');
  assert.deepEqual(read, validRecord);

  const list = listReleases(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].release_id, 'rel-2026-09-001');

  // Validation: Missing approval approver
  const invalid = { ...validRecord, approval: { approver: 'invalid-actor' } };
  assert.equal(validateReleaseRecord(invalid).ok, false);
});

test('delivery-releases: rollback recording preserves deployment history', () => {
  isolateHome();
  const repo = makeRepo();

  const record = {
    schema_version: 2,
    release_id: 'rel-bad-deploy',
    environment: 'production',
    tasks: ['task-001'],
    deployed_commit: VALID_COMMIT,
    target_branch: 'main',
    approval: {
      approver: 'human:project-owner',
      approved_at: '2026-09-08T12:00:00Z',
    },
    deployment: {
      deployed: true,
      result: 'success',
      reference: 'deploy-88',
      at: '2026-09-08T12:05:00Z',
    },
    verification: {
      verified: true,
      reference: 'init-ok',
      at: '2026-09-08T12:10:00Z',
    },
  };

  recordRelease(repo, record);

  const rolledBack = recordRollback(repo, 'rel-bad-deploy', {
    reason: 'Critical bug detected in production telemetry',
    actor: 'human:project-owner',
  });

  assert.equal(rolledBack.rollback.rolled_back, true);
  assert.equal(rolledBack.rollback.reason, 'Critical bug detected in production telemetry');
  assert.equal(rolledBack.deployment.deployed, true); // original deployment preserved
});

test('delivery-releases: resolveTaskEvidence maps release facts to task', () => {
  isolateHome();
  const repo = makeRepo();

  const record = {
    schema_version: 2,
    release_id: 'rel-prod-001',
    environment: 'production',
    tasks: ['task-001'],
    deployed_commit: VALID_COMMIT,
    target_branch: 'main',
    approval: {
      approver: 'human:project-owner',
      approved_at: '2026-09-08T12:00:00Z',
    },
    deployment: {
      deployed: true,
      result: 'success',
      reference: 'deploy-prod',
      at: '2026-09-08T12:05:00Z',
    },
    verification: {
      verified: true,
      reference: 'verification-passed',
      at: '2026-09-08T12:10:00Z',
    },
  };

  recordRelease(repo, record);

  const task = {
    id: 'task-001',
    delivery: { target_environment: 'production' },
  };

  const facts = resolveTaskEvidence(repo, task, {
    candidate_head: VALID_COMMIT,
    integration: { merged_head: VALID_COMMIT },
  });

  assert.ok(facts.release);
  assert.equal(facts.release.deployed, true);
  assert.equal(facts.release.verified, true);
  assert.equal(facts.release.merged_head, VALID_COMMIT);
});
