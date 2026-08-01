import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// public/hierarchy.js is a classic script (assigns window.TodomdHierarchy),
// not an ES module — load it the same way a browser would rather than
// importing it. runInThisContext (not vm.createContext, which spins up a
// separate V8 realm with its own Array/Object) so the arrays/objects the
// helpers return are reference-equal to this file's own, and assert/strict's
// deepEqual can compare them.
function loadHierarchy() {
  const src = fs.readFileSync(path.join(__dirname, '../public/hierarchy.js'), 'utf8');
  globalThis.window = globalThis.window || {};
  vm.runInThisContext(src, { filename: 'hierarchy.js' });
  return globalThis.window.TodomdHierarchy;
}

const H = loadHierarchy();

const STAGE_CONFIG = { stages: { Build: { command: 'todomd-build' }, Verify: { command: 'todomd-verify' } } };

test('asList coerces scalar/mapping/missing card fields without throwing', () => {
  assert.deepEqual(H.asList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(H.asList('task-0004'), ['task-0004']); // scalar `dependencies:` / `children:`
  assert.deepEqual(H.asList(undefined), []);
  assert.deepEqual(H.asList(null), []);
  assert.doesNotThrow(() => H.asList({ a: 1 })); // scalar mapping — never throws
});

test('epicProgress counts total/done children by parent, regardless of the epic children: field', () => {
  const cards = [
    { id: 'epic-1', epic: true },
    { id: 'c1', parent: 'epic-1', status: 'Done' },
    { id: 'c2', parent: 'epic-1', status: 'Build' },
    { id: 'c3', parent: 'epic-1', status: 'Planned' },
    { id: 'other', parent: 'epic-2', status: 'Done' },
  ];
  assert.deepEqual(H.epicProgress(cards, 'epic-1'), { total: 3, done: 1 });
  assert.deepEqual(H.epicProgress(cards, 'no-such-epic'), { total: 0, done: 0 });
});

test('dependencyState: unblocked when every dependency is Done', () => {
  const cards = [
    { id: 'a', status: 'Done' },
    { id: 'b', status: 'Done' },
    { id: 'c', parent: 'epic-1', dependencies: ['a', 'b'], status: 'Queue' },
  ];
  assert.deepEqual(H.dependencyState(cards[2], cards), { blocked: false, waitingOn: [] });
});

test('dependencyState: blocked when a dependency is not Done', () => {
  const cards = [
    { id: 'a', status: 'Build' },
    { id: 'c', dependencies: ['a'], status: 'Queue' },
  ];
  const state = H.dependencyState(cards[1], cards);
  assert.equal(state.blocked, true);
  assert.deepEqual(state.waitingOn, [{ id: 'a', status: 'Build' }]);
});

test('dependencyState: a dependency id with no matching card is blocked, status null', () => {
  const cards = [{ id: 'c', dependencies: ['ghost'], status: 'Queue' }];
  const state = H.dependencyState(cards[0], cards);
  assert.equal(state.blocked, true);
  assert.deepEqual(state.waitingOn, [{ id: 'ghost', status: null }]);
});

test('dependencyState tolerates a scalar `dependencies:` string', () => {
  const cards = [
    { id: 'a', status: 'Queue' },
    { id: 'c', dependencies: 'a', status: 'Queue' }, // hand-edited: scalar, not a list
  ];
  assert.doesNotThrow(() => H.dependencyState(cards[1], cards));
  assert.deepEqual(H.dependencyState(cards[1], cards), { blocked: true, waitingOn: [{ id: 'a', status: 'Queue' }] });
});

test('dependencyState tolerates a missing card / missing dependencies field', () => {
  assert.doesNotThrow(() => H.dependencyState(undefined, undefined));
  assert.deepEqual(H.dependencyState({ id: 'x' }, []), { blocked: false, waitingOn: [] });
});

test('childrenOf orders by dependency chain then id', () => {
  // deliberately out of build order in the input array
  const cards = [
    { id: 'c3', parent: 'epic-1', dependencies: ['c2'] },
    { id: 'c1', parent: 'epic-1', dependencies: [] },
    { id: 'c2', parent: 'epic-1', dependencies: ['c1'] },
  ];
  assert.deepEqual(H.childrenOf(cards, 'epic-1').map((c) => c.id), ['c1', 'c2', 'c3']);
});

test('childrenOf tie-breaks siblings with no dependency relationship by id', () => {
  const cards = [
    { id: 'task-0010', parent: 'epic-1' },
    { id: 'task-0005', parent: 'epic-1' },
  ];
  assert.deepEqual(H.childrenOf(cards, 'epic-1').map((c) => c.id), ['task-0005', 'task-0010']);
});

test('childrenOf tolerates a scalar `children:`/`dependencies:` shape without throwing or dropping cards', () => {
  const cards = [
    { id: 'c1', parent: 'epic-1', dependencies: [] },
    { id: 'c2', parent: 'epic-1', dependencies: 'c1' }, // scalar, not a list
  ];
  assert.doesNotThrow(() => H.childrenOf(cards, 'epic-1'));
  assert.deepEqual(H.childrenOf(cards, 'epic-1').map((c) => c.id), ['c1', 'c2']);
});

test('isExecutionColumn derives from config.stages, not a hardcoded list', () => {
  assert.equal(H.isExecutionColumn('Build', STAGE_CONFIG), true);
  assert.equal(H.isExecutionColumn('Verify', STAGE_CONFIG), true);
  assert.equal(H.isExecutionColumn('Planned', STAGE_CONFIG), false);
  assert.equal(H.isExecutionColumn('Done', STAGE_CONFIG), false);
  assert.doesNotThrow(() => H.isExecutionColumn('Build', undefined));
  assert.equal(H.isExecutionColumn('Build', undefined), false);
});

test('nestedChildIds: nested-vs-full partition across a stage and a non-stage column', () => {
  const cards = [
    { id: 'epic-1', epic: true, status: 'Planned' },
    { id: 'planned-child', parent: 'epic-1', status: 'Planned' }, // non-stage column
    { id: 'build-child', parent: 'epic-1', status: 'Build' },     // stage column
  ];
  const nested = H.nestedChildIds(cards, STAGE_CONFIG);
  assert.equal(nested.has('planned-child'), true);
  assert.equal(nested.has('build-child'), false); // active execution column → full card
});

test('nestedChildIds: a child whose parent is missing from the board renders full, never nested', () => {
  const cards = [
    { id: 'orphan', parent: 'archived-or-filtered-epic', status: 'Planned' },
  ];
  const nested = H.nestedChildIds(cards, STAGE_CONFIG);
  assert.equal(nested.has('orphan'), false);
});

test('nestedChildIds: a child pointing at a non-epic parent renders full, never vanishes', () => {
  const cards = [
    { id: 'ordinary-parent', status: 'Queue' },
    { id: 'child', parent: 'ordinary-parent', status: 'Planned' },
  ];
  assert.equal(H.nestedChildIds(cards, STAGE_CONFIG).has('child'), false);
});

test('hostile board fixture (mirrors test/ui/ui-smoke.test.js hostileBoard): no throw, sane values', () => {
  const cards = [
    { id: 'task-0002', status: 'Queue', labels: { a: 1 } },
    { id: 'task-0003', epic: true, children: 'task-0004', status: 'Review' },
    { id: 'task-0004', parent: 'task-0003', dependencies: 'task-0002', status: 'Review' },
  ];
  assert.doesNotThrow(() => {
    H.epicProgress(cards, 'task-0003');
    H.dependencyState(cards[2], cards);
    H.childrenOf(cards, 'task-0003');
    H.nestedChildIds(cards, STAGE_CONFIG);
  });
  assert.deepEqual(H.epicProgress(cards, 'task-0003'), { total: 1, done: 0 });
  assert.equal(H.dependencyState(cards[2], cards).blocked, true); // task-0002 is Queue, not Done
});
