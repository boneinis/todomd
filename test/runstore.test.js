import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome } from './helpers.js';
import { runs, runKey, persistRuns, readPriorRuns, addCost, monthCost } from '../src/runstore.js';

test('runKey composes project:card', () => {
  assert.equal(runKey('proj', 'task-0001'), 'proj:task-0001');
});

test('persistRuns → readPriorRuns round-trips the run mirror (atomic write)', () => {
  const home = isolateHome();
  runs.clear();
  runs.set(runKey('p', 'task-1'), { project: 'p', card: 'task-1', stage: 'Build', pid: 4242, startedAt: '2026-06-10T00:00:00Z', attempt: 1 });
  runs.set(runKey('p', 'task-2'), { project: 'p', card: 'task-2', stage: 'Verify', pid: 4343, startedAt: '2026-06-10T00:01:00Z', attempt: 2 });
  persistRuns();

  const file = path.join(home, '.todomd', 'runs.json');
  assert.ok(fs.existsSync(file), 'runs.json written');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no .tmp left behind (tmp+rename)');
  JSON.parse(fs.readFileSync(file, 'utf8')); // valid JSON, never torn

  const prior = readPriorRuns();
  assert.equal(prior.length, 2);
  const t1 = prior.find((r) => r.card === 'task-1');
  assert.equal(t1.pid, 4242);
  assert.equal(t1.stage, 'Build');
  assert.equal(t1.startedAt, '2026-06-10T00:00:00Z'); // start time the orphan-kill guard compares
  runs.clear();
});

test('readPriorRuns is [] when no mirror exists (fresh boot)', () => {
  isolateHome(); // fresh TODOMD_HOME, no runs.json
  assert.deepEqual(readPriorRuns(), []);
});

test('addCost accumulates into the current month and ignores non-positive values', () => {
  isolateHome();
  assert.equal(monthCost(), 0, 'a fresh home reports 0 spend');
  addCost(0.5);
  addCost(0.25);
  addCost(0);          // ignored
  addCost(-1);         // ignored
  addCost(undefined);  // ignored
  addCost(NaN);        // ignored
  assert.equal(monthCost(), 0.75);
});

test('monthCost is isolated per TODOMD_HOME', () => {
  isolateHome();
  addCost(2);
  assert.equal(monthCost(), 2);
  isolateHome(); // switch to a different home → independent ledger
  assert.equal(monthCost(), 0);
});
