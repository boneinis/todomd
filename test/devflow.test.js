import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// public/devflow.js is a classic script (assigns window.TodomdDevflow), not an
// ES module — load it the same way a browser would rather than importing it.
// runInThisContext (not vm.createContext, which spins up a separate V8 realm
// with its own Array/Object) so the arrays/objects the helpers return are
// reference-equal to this file's own, and assert/strict's deepEqual can
// compare them. hierarchy.js loads first because devflow's epicRows delegates
// to window.TodomdHierarchy.childrenOf, exactly like index.html's <script>
// order. Only the pure data layer is exercised here — render() needs the DOM
// and app.js globals, which don't exist under node.
function loadDevflow() {
  globalThis.window = globalThis.window || {};
  for (const f of ['hierarchy.js', 'devflow.js']) {
    const src = fs.readFileSync(path.join(__dirname, `../public/${f}`), 'utf8');
    vm.runInThisContext(src, { filename: f });
  }
  return globalThis.window.TodomdDevflow;
}

const D = loadDevflow();

const STAGE_CONFIG = { stages: { Build: { command: 'todomd-build' }, Verify: { command: 'todomd-verify' } } };

test('laneKeyFor: Review, missing and garbage statuses are off the dev board', () => {
  assert.equal(D.laneKeyFor('Review'), null); // intake column — not dev work
  assert.equal(D.laneKeyFor(null), null);
  assert.equal(D.laneKeyFor(undefined), null);
  assert.equal(D.laneKeyFor(''), null);
  assert.equal(D.laneKeyFor('   '), null);
  assert.equal(D.laneKeyFor(42), null);
  assert.equal(D.laneKeyFor({ status: 'Queue' }), null);
  assert.doesNotThrow(() => D.laneKeyFor(Symbol('x')));
});

test('laneKeyFor: every explicit LANES status maps to its lane', () => {
  assert.equal(D.laneKeyFor('Planned'), 'backlog');
  assert.equal(D.laneKeyFor('Queue'), 'committed');
  for (const s of ['Build', 'CI', 'Verify', 'Escalate']) {
    assert.equal(D.laneKeyFor(s), 'in-flight', s);
    assert.equal(D.laneKeyFor(s, STAGE_CONFIG), 'in-flight', s);
  }
  assert.equal(D.laneKeyFor('Needs Human'), 'needs-me');
  assert.equal(D.laneKeyFor('Done'), 'shipped');
});

test('laneKeyFor: Plan and unknown custom statuses are pre-commitment → backlog', () => {
  assert.equal(D.laneKeyFor('Plan'), 'backlog');
  assert.equal(D.laneKeyFor('Triage-Extra'), 'backlog'); // hand-added column
  assert.equal(D.laneKeyFor('CustomStage', STAGE_CONFIG), 'backlog');
});

test('sprintOf: missing/scalar/list/number all coerce, never throws', () => {
  assert.equal(D.sprintOf({}), '');
  assert.equal(D.sprintOf({ sprint: 'sprint-3' }), 'sprint-3');
  assert.equal(D.sprintOf({ sprint: '  sprint-3  ' }), 'sprint-3'); // trimmed
  // hand-edited `sprint:` can be a YAML list — first element wins
  assert.equal(D.sprintOf({ sprint: ['sprint-2', 'sprint-3'] }), 'sprint-2');
  assert.equal(D.sprintOf({ sprint: [] }), '');
  assert.equal(D.sprintOf({ sprint: 3 }), '3'); // unquoted scalar
  assert.equal(D.sprintOf(null), '');
  assert.equal(D.sprintOf(undefined), '');
});

test('devVisible: archived and Review cards never reach the dev board', () => {
  assert.equal(D.devVisible({ id: 'a', status: 'Queue' }), true);
  assert.equal(D.devVisible({ id: 'a', status: 'Done' }), true);
  assert.equal(D.devVisible({ id: 'a', status: 'Review' }), false);
  assert.equal(D.devVisible({ id: 'a', status: 'Queue', archived: true }), false);
  assert.equal(D.devVisible({ id: 'a' }), false); // missing status
  assert.equal(D.devVisible(null), false);
  assert.equal(D.devVisible('task-0001'), false);
});

test('sortForLane: board_order ranked first (numeric), then priority, then id', () => {
  const cards = [
    { id: 'task-0009', priority: 'low' },
    { id: 'task-0002', board_order: 2 },
    { id: 'task-0004', priority: 'bogus' },       // unknown priority sorts last
    { id: 'task-0001', board_order: '1' },        // string numbers still rank
    { id: 'task-0005', priority: 'critical' },
    { id: 'task-0003', priority: 'high' },
  ];
  const sorted = D.sortForLane(cards).map((c) => c.id);
  assert.deepEqual(sorted, ['task-0001', 'task-0002', 'task-0005', 'task-0003', 'task-0009', 'task-0004']);
});

test('sortForLane: equal priority tie-breaks by id ascending', () => {
  const out = D.sortForLane([
    { id: 'task-0007', priority: 'medium' },
    { id: 'task-0001', priority: 'medium' },
    { id: 'task-0004' }, // no priority — after both
  ]);
  assert.deepEqual(out.map((c) => c.id), ['task-0001', 'task-0007', 'task-0004']);
});

test('sortForLane does not mutate the input array (callers pass boardData order)', () => {
  const cards = [
    { id: 'b', board_order: 2 },
    { id: 'a', board_order: 1 },
  ];
  D.sortForLane(cards);
  assert.deepEqual(cards.map((c) => c.id), ['b', 'a']);
});

test('sortForLane: a null/blank board_order is unranked, not rank 0', () => {
  // Number(null) === 0 — a naive coerce would fake "ranked first"
  const out = D.sortForLane([
    { id: 'a', board_order: null },
    { id: 'b', board_order: 5 },
    { id: 'c', board_order: ' ' },
  ]);
  assert.equal(out[0].id, 'b');
});

test('groupBySprint: named sprints sorted ascending, unscheduled last', () => {
  const cards = [
    { id: 'a', sprint: 'sprint-3' },
    { id: 'b' },                        // '' would localeCompare FIRST — it must still go last
    { id: 'c', sprint: 'sprint-1' },
    { id: 'd', sprint: 'sprint-3' },
  ];
  const groups = D.groupBySprint(cards);
  assert.deepEqual(groups.map((g) => g.name), ['sprint-1', 'sprint-3', '']);
  assert.deepEqual(groups[0].cards.map((c) => c.id), ['c']);
  assert.deepEqual(groups[1].cards.map((c) => c.id), ['a', 'd']); // input order kept
  assert.deepEqual(groups[2].cards.map((c) => c.id), ['b']);
});

test('sprintStats: per-sprint total/done for the chip strip', () => {
  const cards = [
    { id: 'a', sprint: 's1', status: 'Done' },
    { id: 'b', sprint: 's1', status: 'Queue' },
    { id: 'c', sprint: 's1', status: 'Done' },
    { id: 'd', status: 'Build' },
  ];
  assert.deepEqual(D.sprintStats(cards), [
    { name: 's1', total: 3, done: 2 },
    { name: '', total: 1, done: 0 },
  ]);
});

test('epicRows: a same-lane child that is not a row nests under the epic', () => {
  const cards = [
    { id: 'epic-1', epic: true, status: 'Queue' },
    { id: 'kid-1', parent: 'epic-1', status: 'Queue' },   // same lane, filtered out of the rows
    { id: 'kid-2', parent: 'epic-1', status: 'Build' },   // different lane — renders there as a row
    { id: 'kid-3', parent: 'epic-1', status: 'Review' },  // no dev lane — must nest or it vanishes
  ];
  const laneCards = cards.filter((c) => c.id === 'epic-1'); // e.g. kid-1 hidden by sprint/text filter
  const rows = D.epicRows(cards, laneCards);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].children.map((k) => k.id), ['kid-1', 'kid-3']);
});

test('epicRows: a child already rendered as a lane row is not swallowed', () => {
  const cards = [
    { id: 'epic-1', epic: true, status: 'Queue' },
    { id: 'kid-1', parent: 'epic-1', status: 'Queue' },
  ];
  const rows = D.epicRows(cards, cards); // both are rows in this lane
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.card.id === 'epic-1').children, []);
  assert.deepEqual(rows.find((r) => r.card.id === 'kid-1').children, []);
});

test('epicRows: a child whose status maps to a different lane is never nested', () => {
  const cards = [
    { id: 'epic-1', epic: true, status: 'Planned' },
    { id: 'in-flight-kid', parent: 'epic-1', status: 'CI' }, // renders in the in-flight lane
  ];
  const rows = D.epicRows(cards, [cards[0]]);
  assert.deepEqual(rows[0].children, []);
});

test('epicRows: an orphan whose epic is filtered out still renders as its own row', () => {
  const cards = [{ id: 'orphan', parent: 'gone-epic', status: 'Planned' }];
  const rows = D.epicRows(cards, cards);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].card.id, 'orphan');
  assert.deepEqual(rows[0].children, []);
});

test('epicRows: non-epic rows always get an empty children array', () => {
  const cards = [
    { id: 'plain', status: 'Queue' },
    { id: 'epic-1', epic: true, status: 'Queue' },
  ];
  const rows = D.epicRows(cards, cards);
  assert.deepEqual(rows.find((r) => r.card.id === 'plain').children, []);
});

test('hostile cards (scalar/mapping/missing fields) never throw anywhere — the codebase has scars here', () => {
  // a scalar `dependencies:` once reached `.some()` and blanked the whole
  // board (test/ui/ui-smoke.test.js); sprint/labels/board_order can arrive
  // just as malformed from hand-edited markdown
  const cards = [
    { id: 'task-0002', status: 'Queue', labels: { a: 1 }, sprint: ['s1', 's2'] },
    { id: 'task-0003', epic: true, children: 'task-0004', status: 'Planned' },
    { id: 'task-0004', parent: 'task-0003', dependencies: 'task-0002', status: 'Planned', board_order: 'x' },
    { id: 'task-0005', status: null, priority: 7 },
    'not-a-card',
    null,
    undefined,
  ];
  assert.doesNotThrow(() => {
    for (const c of cards) {
      D.laneKeyFor(c && c.status, STAGE_CONFIG);
      D.sprintOf(c);
      D.devVisible(c);
    }
    D.sortForLane(cards);
    D.groupBySprint(cards);
    D.sprintStats(cards);
    D.epicRows(cards, cards);
    D.epicRows(undefined, undefined);
    D.sortForLane(undefined);
    D.groupBySprint(null);
  });
});
