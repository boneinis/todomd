import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome, tmp } from './helpers.js';
import { previewDeliveryMigration, formatDeliveryPreview } from '../src/delivery-preview.js';
import { readCard } from '../src/board.js';

function snapshot(dir) {
  const files = {};
  const visit = (base, prefix = '') => {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name), key = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) files[key] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) { files[key + '/'] = 'directory'; visit(file, key + '/'); }
      else files[key] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  visit(dir); return files;
}

test('preview keeps legacy Done deployment unknown and changes no files, attempts or journals', () => {
  const home = isolateHome(), repo = makeRepo();
  writeCard(repo, 'task-0001', { status: 'Done', extra: 'archived: "2026-09-01"\n' });
  writeCard(repo, 'task-0002', { status: 'Needs Human', deps: ['task-0001'], extra: 'needs_human_reason: publication_review_required\nworktree: todomd/task-0002\n' });
  const heldCard = path.join(repo, '.todomd/tasks/task-0002-card.md');
  fs.writeFileSync(heldCard, fs.readFileSync(heldCard, 'utf8').replace('attempts: 0', 'attempts: 3'));
  writeCard(repo, 'task-0003', { status: 'Needs Human', extra: 'needs_human_reason: unknown_problem\n' });
  fs.mkdirSync(path.join(repo, '.todomd/worktrees/task-0002/fleet-runs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.todomd/worktrees/task-0002/fleet-runs/receipt.json'), '{"phase":"accepted"}');
  const before = snapshot(repo), privateBefore = snapshot(home);
  const report = previewDeliveryMigration(repo);
  assert.equal(report.read_only, true);
  assert.equal(report.execution_enabled, false);
  assert.equal(report.counts.total, 3);
  assert.equal(report.counts.archived, 1);
  assert.equal(report.cards[0].proposed_state, null);
  assert.equal(report.cards[0].deployment, 'unknown');
  assert.equal(report.cards[1].proposed_state, 'in_review');
  assert.ok(!report.cards[1].findings.some(f => f.code === 'missing_dependency'));
  assert.equal(report.cards[2].proposed_state, null);
  assert.deepEqual(previewDeliveryMigration(repo), report, 'stable input produces a stable report');
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(snapshot(home), privateBefore);
  assert.equal(readCard(repo, 'task-0002').data.verification.attempts, 3);
  assert.match(formatDeliveryPreview(report), /Done → mapping requires review; deployment unknown/);
});

test('ambiguous identity, missing dependencies, cycles and malformed frontmatter remain visible', () => {
  isolateHome(); const repo = makeRepo();
  writeCard(repo, 'task-0001', { status: 'Planned', deps: ['task-0002'] });
  writeCard(repo, 'task-0002', { status: 'Planned', deps: ['task-0001'] });
  writeCard(repo, 'task-0003', { status: 'Planned', deps: ['absent'] });
  writeCard(repo, 'task-0004', { status: 'Planned' });
  const dir = path.join(repo, '.todomd/tasks');
  fs.copyFileSync(path.join(dir, 'task-0004-card.md'), path.join(dir, 'task-0004-duplicate.md'));
  fs.writeFileSync(path.join(dir, 'task-0005-broken.md'), '---\nid: task-0005\ntitle: broken: title\n---\n');
  const report = previewDeliveryMigration(repo);
  assert.equal(report.cards.length, 6);
  assert.equal(report.cards.filter(c => c.findings.some(f => f.code === 'dependency_cycle')).length, 2);
  assert.equal(report.cards.filter(c => c.findings.some(f => f.code === 'duplicate_id')).length, 2);
  assert.ok(report.cards.find(c => c.id === 'task-0003').findings.some(f => f.code === 'missing_dependency'));
  assert.ok(report.cards.find(c => c.file.includes('broken')).findings.some(f => f.code === 'frontmatter_parse_error'));
  assert.ok(report.cards.every(c => c.proposed_state === null));
});

test('preview identifies every member of overlapping cycles without marking downstream dependents', () => {
  isolateHome(); const repo = makeRepo();
  for (const [id, deps] of Object.entries({ a: ['b', 'd'], b: ['c'], c: ['a'], d: ['b'], e: ['a'], f: ['f'] })) {
    writeCard(repo, id, { status: 'Planned', deps });
  }
  const report = previewDeliveryMigration(repo);
  assert.deepEqual(report.cards.filter(c => c.findings.some(f => f.code === 'dependency_cycle')).map(c => c.id), ['a', 'b', 'c', 'd', 'f']);
});

test('authored Released fields are declarations, never verified deployment facts', () => {
  isolateHome(); const repo = makeRepo();
  writeCard(repo, 'task-0001', { status: 'Done', extra: 'schema_version: 2\ndelivery: { state: released, completion_policy: released, target_environment: production }\nownership: { delivery_lead: "agent-role:lead", implementation: "agent-role:builder", reviewer: "agent-role:reviewer", release: "human:owner" }\n' });
  const report = previewDeliveryMigration(repo), row = report.cards[0];
  assert.equal(row.schema_valid, true);
  assert.equal(row.declared_state, 'released');
  assert.equal(row.proposed_state, null);
  assert.equal(row.deployment, 'unknown');
  assert.equal(row.evidence_verified, false);
  assert.equal(row.requires_review, true);
  const old = report.revision;
  fs.appendFileSync(path.join(repo, '.todomd/tasks/task-0001-card.md'), '\nChanged scope.\n');
  assert.notEqual(previewDeliveryMigration(repo).revision, old);
});

test('preview refuses executable frontmatter and does not follow task symlinks', () => {
  isolateHome(); const repo = makeRepo(), outside = tmp('preview-outside');
  const marker = path.join(outside, 'executed');
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001-js.md'), `---js\n(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'bad'); return {id:'task-0001'};})()\n---\n`);
  const secret = path.join(outside, 'external.md');
  fs.writeFileSync(secret, 'private fixture contents');
  fs.symlinkSync(secret, path.join(repo, '.todomd/tasks/task-0002-link.md'));
  const report = previewDeliveryMigration(repo);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(report.cards[0].findings[0].code, 'frontmatter_parse_error');
  assert.equal(report.cards[1].findings[0].code, 'not_regular_file');
  assert.doesNotMatch(JSON.stringify(report), /private fixture contents/);
});

test('CLI preview is offline and read-only, rejects apply flags, and does not initialize missing boards', () => {
  const home = isolateHome(), repo = makeRepo();
  writeCard(repo, 'task-0001', { status: 'Done' });
  const bin = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
  const before = snapshot(repo), privateBefore = snapshot(home);
  const invoke = args => spawnSync(process.execPath, [bin, 'delivery-preview', ...args], { encoding: 'utf8', env: process.env });
  const result = invoke([repo, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cards[0].deployment, 'unknown');
  assert.equal(invoke([repo, '--apply']).status, 1);
  const empty = tmp('no-board');
  assert.equal(invoke([empty]).status, 1);
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(snapshot(home), privateBefore);
});
