import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.window = {};
for (const name of ['hierarchy', 'listview']) vm.runInThisContext(fs.readFileSync(new URL(`../public/${name}.js`, import.meta.url), 'utf8'));
const { rows, groupOf } = window.TodomdListView;

test('list groups include CI, critical priority, unknown statuses and dependency deferrals', () => {
  const cards = [
    { id: 'low', status: 'Review', priority: 'low' },
    { id: 'critical', status: 'Review', priority: 'critical' },
    { id: 'ci', status: 'CI' }, { id: 'plan', status: 'Plan' },
    { id: 'done', status: 'Done', dependencies: ['missing'] },
    { id: 'wait', status: 'Queue', dependencies: 'missing' },
    { id: 'unknown', status: 'Unknown' },
  ];
  assert.deepEqual(rows(cards).map((r) => r.card.id), ['critical', 'low', 'unknown', 'plan', 'ci', 'wait', 'done']);
  assert.equal(groupOf({ status: 'Build', archived: true }, []), 'deferred');
});

test('epics reuse topological ordering and completion counts without swallowing filtered children', () => {
  const cards = [
    { id: 'epic', epic: true, status: 'Planned', children: { bad: 'shape' } },
    { id: 'a', parent: 'epic', status: 'Queue', dependencies: ['z'] },
    { id: 'z', parent: 'epic', status: 'Done' },
    { id: 'solo', status: 'Build' },
  ];
  const shaped = rows(cards);
  const epic = shaped.find((r) => r.card.id === 'epic');
  assert.deepEqual(epic.children.map((c) => c.id), ['z', 'a']);
  assert.deepEqual(epic.progress, { done: 1, total: 2 });
  assert.equal(shaped.length, 2);
  assert.deepEqual(rows(cards, [cards[1]]).map((r) => r.card.id), ['a']);
});

test('malformed fields and cyclic epic parents remain visible', () => {
  const cards = [{ id: 'a', epic: true, parent: 'b', dependencies: { bad: 'shape' } },
    { id: 'b', epic: true, parent: 'a', children: 'a' }];
  assert.equal(rows(cards).length, 2);
  assert.deepEqual(rows(null), []);
});
