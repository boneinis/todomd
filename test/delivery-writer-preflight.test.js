import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deliveryWriterPreflight } from '../src/delivery-writer-preflight.js';
import { withAdmissionSync } from '../src/delivery-admission.js';
import { projectAdmissionDirectory } from '../src/delivery-paths.js';
import { isolateHome, makeRepo, writeCard, git } from './helpers.js';

const cli = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
function fixture() {
  const home = isolateHome(), repo = fs.realpathSync(makeRepo({ automaticMaintenance: false }));
  writeCard(repo, 'task-0001', { status: 'Planned' });
  const privateDir = path.join(home, '.todomd'); fs.mkdirSync(privateDir);
  return { home, repo, privateDir, config: path.join(repo, '.todomd/config.yml'), scan: () => deliveryWriterPreflight(repo) };
}
const codes = report => report.blockers.map(b => b.code);
function snapshot(dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const p = path.join(dir, name), stat = fs.lstatSync(p);
    return stat.isDirectory() ? [[p, 'directory'], ...snapshot(p)] : [[p, stat.isSymbolicLink() ? fs.readlinkSync(p) : createHash('sha256').update(fs.readFileSync(p)).digest('hex')]];
  });
}
test('a clear preflight is read-only and never claims writer fencing', () => {
  const f = fixture(), before = [snapshot(f.repo), snapshot(f.home)];
  const report = f.scan(); assert.equal(report.blocked, false);
  assert.equal(report.writers_fenced, false); assert.equal(report.execution_enabled, false); assert.equal(report.atomic_snapshot, false);
  assert.equal(report.revision, f.scan().revision);
  assert.deepEqual([snapshot(f.repo), snapshot(f.home)], before);
  const json = JSON.parse(execFileSync(process.execPath, [cli, 'delivery-writers', f.repo, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(json, report); assert.deepEqual([snapshot(f.repo), snapshot(f.home)], before);
});
test('both committed and working configuration retain budget and remote boundaries', () => {
  const f = fixture(), original = fs.readFileSync(f.config, 'utf8');
  fs.writeFileSync(f.config, original.replace('mode: launcher', 'mode: budget') + '\nci:\n  execution: remote\n');
  assert.ok(codes(f.scan()).includes('interactive_sessions_unfenced'));
  assert.ok(codes(f.scan()).includes('remote_authority_required'));
  git(f.repo, ['add', '.todomd/config.yml']); git(f.repo, ['commit', '-qm', 'fixture remote policy']);
  fs.writeFileSync(f.config, original);
  assert.ok(codes(f.scan()).includes('interactive_sessions_unfenced'));
  assert.ok(codes(f.scan()).includes('remote_authority_required'));
  const r = spawnSync(process.execPath, [cli, 'delivery-writers', f.repo, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).writers_fenced, false);
});
test('expired leases, archived tasks and successful remote evidence cannot prove closure', () => {
  const f = fixture();
  writeCard(f.repo, 'task-0002', { status: 'Done', extra: 'archived: true\nlease: "1 old-worker"\nci_execution: remote\nci_evidence:\n  result: passed\n' });
  const report = f.scan();
  assert.ok(codes(report).includes('legacy_lease_present'));
  assert.ok(codes(report).includes('remote_authority_required'));
  writeCard(f.repo, 'task-0003', { status: 'Build' });
  assert.ok(codes(f.scan()).includes('legacy_task_active'));
});
test('coordination content and old repository locks require reconciliation', () => {
  const f = fixture(), manifest = path.join(f.repo, '.todomd/ACTIVE.md');
  fs.writeFileSync(manifest, '# Active work\n<!-- metadata -->\n_No active work._\n');
  assert.equal(f.scan().blocked, false);
  fs.appendFileSync(manifest, '\nunknown claim format\n');
  assert.ok(codes(f.scan()).includes('coordination_pending'));
  fs.mkdirSync(path.join(f.repo, '.todomd/.lock'));
  fs.utimesSync(path.join(f.repo, '.todomd/.lock'), new Date(0), new Date(0));
  assert.ok(codes(f.scan()).includes('repository_lock_pending'));
});
test('run mirror scope uses canonical registered paths, without leaking private fields', () => {
  const f = fixture(), other = fs.realpathSync(makeRepo());
  fs.writeFileSync(path.join(f.privateDir, 'projects.json'), JSON.stringify({ projects: [{ name: 'renamed', path: f.repo }, { name: 'other', path: other }] }));
  const mirror = runs => fs.writeFileSync(path.join(f.privateDir, 'runs.json'), JSON.stringify(runs));
  mirror([{ project: 'other' }]); assert.equal(f.scan().blocked, false);
  mirror([{ project: 'renamed', pid: 99999999, sessionId: 'secret-session', executable: '/private/secret' }]);
  const report = f.scan(); assert.ok(codes(report).includes('legacy_run_recorded'));
  assert.doesNotMatch(JSON.stringify(report), /secret-session|\/private\/secret|99999999|renamed/);
  mirror([{ project: 'missing' }]); assert.ok(codes(f.scan()).includes('legacy_run_unresolved'));
  fs.writeFileSync(path.join(f.privateDir, 'projects.json'), JSON.stringify({ projects: [{ name: 'missing', path: f.repo }, { name: 'missing', path: other }] }));
  assert.ok(codes(f.scan()).includes('legacy_run_unresolved'));
});
test('corrupt, symlinked and non-regular records fail closed without following task scripts', () => {
  const f = fixture(), runs = path.join(f.privateDir, 'runs.json');
  for (const raw of ['{broken', '{}', '[{}]']) {
    fs.writeFileSync(runs, raw); assert.ok(codes(f.scan()).includes('state_unavailable'));
  }
  fs.unlinkSync(runs); fs.symlinkSync('missing-record', runs);
  assert.ok(codes(f.scan()).includes('state_unavailable'));
  fs.unlinkSync(runs);
  const marker = path.join(f.repo, 'must-not-exist');
  fs.writeFileSync(path.join(f.repo, '.todomd/tasks/task-0002.md'), `---js\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'bad')\n---\n`);
  assert.ok(codes(f.scan()).includes('state_unavailable')); assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(f.config, 'ci: [invalid]'); assert.ok(codes(f.scan()).includes('configuration_unavailable'));
});
test('admission inspection creates no gate and recognizes only its own live scope', () => {
  const f = fixture(), gate = projectAdmissionDirectory(f.repo);
  f.scan(); assert.equal(fs.existsSync(gate), false);
  withAdmissionSync(gate, 'metadata', 'task-0001', () => {
    assert.equal(f.scan().blocked, false);
    const child = spawnSync(process.execPath, [cli, 'delivery-writers', f.repo, '--json'], { encoding: 'utf8' });
    assert.equal(child.status, 2); assert.ok(codes(JSON.parse(child.stdout)).includes('admission_pending'));
  });
  assert.equal(f.scan().blocked, false);
});
test('invalid CLI options never start a server or mutate state', () => {
  const f = fixture(), before = [snapshot(f.repo), snapshot(f.home)];
  for (const args of [['--apply'], ['--json', '--json'], ['--recover']]) {
    assert.equal(spawnSync(process.execPath, [cli, 'delivery-writers', f.repo, ...args]).status, 1);
  }
  assert.deepEqual([snapshot(f.repo), snapshot(f.home)], before);
});
