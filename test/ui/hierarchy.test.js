// Covers the epic card's expandable subtask nesting (task-0029): a planned or
// queued child renders as a compact row inside its epic card instead of a
// peer card in its own column; a child in an active execution (stage) column
// is promoted back to a normal full card; expand/collapse state survives a
// board re-render; a filter term that only matches a nested child still
// surfaces it. Same browser-driver pattern as test/ui/ui-smoke.test.js —
// budget mode so the server never spawns an agent, skip if no Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, until, git, BUDGET } from '../helpers.js';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';
import { openPage } from '../browser.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// One epic with two non-execution children (Queue, Planned — both nest) and
// one execution-column child (Build — must stay a full card). task-0002
// depends on task-0003 so its row exercises the dependency-lock state too.
function hierarchyBoard() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  writeCard(repo, 'task-0001', { status: 'Queue', title: 'Sequential chunking epic', extra: 'epic: true\nchildren: [task-0002, task-0003, task-0004]\n' });
  // give the epic a raw "## Chunks" planner section (the same shape src/board.js
  // parseChunks reads) so the drawer's Subtasks/Planner split has something to split
  const epicFile = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(epicFile, fs.readFileSync(epicFile, 'utf8').replace('## Run Log\n',
    '## Chunks\n\n```yaml\n- title: Alpha subtask\n  plan: do the alpha work\n  criteria: ["alpha done"]\n```\n\n' +
    'Risks:\n- none noted\n\n## Run Log\n'));
  writeCard(repo, 'task-0002', { status: 'Queue', title: 'Alpha subtask', deps: ['task-0003'], extra: 'parent: task-0001\nassignee: Ada Lovelace\n' });
  writeCard(repo, 'task-0003', { status: 'Planned', title: 'Beta subtask', extra: 'parent: task-0001\n' });
  writeCard(repo, 'task-0004', { status: 'Build', title: 'Gamma execution subtask', extra: 'parent: task-0001\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'hierarchy UI fixtures']);
  return repo;
}

let page, srv, name;
const SKIP = 'no Chrome/Chromium found (set TODOMD_CHROME_BIN to run this)';

before(async () => {
  isolateHome();
  const repo = hierarchyBoard();
  addProject(repo);
  name = path.basename(repo);
  page = await openPage();
  if (!page) return;
  srv = await startServer({ port: await freePort() });
});

after(async () => {
  try { await page?.close(); } catch { /* browser already gone */ }
  try { srv?.close(); } catch { /* already closed */ }
});

test('epic hierarchy: nesting, promotion to a full card, toggling, and row click-through', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });

    // exactly two full cards: the epic itself (Queue) and the Build child
    // (promoted — an active execution column is never nested)
    const fullCardIds = await page.eval(`[...document.querySelectorAll('.card')].map((c) => c.dataset.id).sort()`);
    assert.deepEqual(fullCardIds, ['task-0001', 'task-0004'],
      'the Queue/Planned children are nested rows, not peer cards; the Build child is a full card');
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.card[data-id="task-0004"] .card-epic')).display`),
      'none', 'ordinary cards do not show an empty epic controls strip');

    // the two non-execution children render as subtask rows inside the epic
    const rowIds = await page.eval(
      `[...document.querySelectorAll('[data-id="task-0001"] .subtask-row')].map((r) => r.dataset.id).sort()`);
    assert.deepEqual(rowIds, ['task-0002', 'task-0003'], 'both planned/queued children nest under the epic');

    // dependency lock on the row: task-0002 depends on (not-yet-Done) task-0003
    assert.match(
      await page.eval(`document.querySelector('[data-id="task-0001"] .subtask-row[data-id="task-0002"] .subtask-dep').textContent`),
      /waiting on task-0003/);
    // assignee initials on the row
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .subtask-row[data-id="task-0002"] .subtask-assignee').textContent`),
      'AL');

    // column counts reflect what's actually rendered — the nested children
    // must not be double-counted or silently dropped
    const queueCount = await page.eval(`document.querySelector('.column[data-status="Queue"] .col-count').textContent`);
    const queueCards = await page.eval(`document.querySelectorAll('.column[data-status="Queue"] .card').length`);
    assert.equal(Number(queueCount), queueCards);
    assert.equal(queueCards, 1, 'only the epic itself is a Queue card — task-0002 is nested, not a peer');
    const buildCount = await page.eval(`document.querySelector('.column[data-status="Build"] .col-count').textContent`);
    assert.equal(Number(buildCount), 1);

    // toggle: default expanded, collapses on click
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'true');
    assert.equal(await page.eval(`document.querySelector('[data-id="task-0001"] .card-subtasks').hidden`), false);
    await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').click()`);
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'false');
    assert.equal(await page.eval(`document.querySelector('[data-id="task-0001"] .card-subtasks').hidden`), true);

    // collapsed state survives a full board re-render (a fresh fetch + re-render,
    // not just a DOM mutation — the card node is rebuilt from scratch every poll)
    await page.eval(`loadBoard()`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'false', 'collapsed state survived loadBoard()\'s re-render');
    assert.equal(await page.eval(`document.querySelector('[data-id="task-0001"] .card-subtasks').hidden`), true);

    // re-expand
    await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').click()`);
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'true');
    assert.equal(await page.eval(`document.querySelector('[data-id="task-0001"] .card-subtasks').hidden`), false);

    // The same task id in another project starts expanded. Collapse state is
    // project-local, but still survives returning to the original project.
    await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').click();
      window.__hierarchyProject = currentProject;
      currentProject = 'another-project'; renderBoard()`);
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'true', 'collapse state does not leak to another project with the same task id');
    await page.eval(`currentProject = window.__hierarchyProject; renderBoard()`);
    assert.equal(
      await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').getAttribute('aria-expanded')`),
      'false', 'returning to the original project restores its collapse state');
    await page.eval(`document.querySelector('[data-id="task-0001"] .epic-toggle').click()`);

    // clicking a subtask row opens THAT child's drawer, not the parent epic's
    await page.eval(`document.querySelector('[data-id="task-0001"] .subtask-row[data-id="task-0002"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    assert.match(await page.eval(`document.getElementById('drawer-title').textContent`), /Alpha subtask/);
    assert.equal(await page.eval(`document.getElementById('drawer-id').textContent`), 'task-0002');
    await page.eval(`document.getElementById('drawer-close').click()`);

    // a filter term that matches only a nested child (not its epic parent)
    // surfaces that child as a full card of its own
    await page.eval(`document.getElementById('filter').value = 'alpha';
      document.getElementById('filter').dispatchEvent(new Event('input'))`);
    await until(async () =>
      (await page.eval(`!!document.querySelector('.card[data-id="task-0002"]')`)) || null, { timeout: BUDGET.quick });
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0002"]')`), true,
      'the filtered-in child renders as its own full card');
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0001"]')`), false,
      'the non-matching epic parent is hidden by the filter, as any other non-matching card would be');

    // If only the parent matches, nonmatching children stay hidden rather than
    // leaking through as nested rows.
    await page.eval(`document.getElementById('filter').value = 'sequential';
      document.getElementById('filter').dispatchEvent(new Event('input'))`);
    assert.equal(await page.eval(`document.querySelectorAll('.subtask-row').length`), 0,
      'a parent-only filter match does not expose nonmatching child rows');
    await page.eval(`document.getElementById('filter').value = '';
      document.getElementById('filter').dispatchEvent(new Event('input'))`);

    // ── drawer Subtasks/Planner view (task-0030) ──
    // opening the epic's own drawer strips the raw "## Chunks" yaml out of the
    // main details flow and hides it behind a closed-by-default Planner record
    await page.eval(`document.querySelector('.card[data-id="task-0001"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    assert.doesNotMatch(
      await page.eval(`document.getElementById('drawer-body').textContent`),
      /Alpha subtask/, 'the raw Chunks yaml is stripped out of the main details flow');
    assert.equal(await page.eval(`document.getElementById('drawer-tabs').hidden`), false,
      'an epic card shows the Details/Subtasks tabs');
    assert.equal(await page.eval(`document.getElementById('drawer-planner').hidden`), false,
      'an epic with a Chunks section shows the Planner record');
    assert.equal(await page.eval(`document.getElementById('drawer-planner').open`), false,
      'the Planner record is closed by default');
    await page.eval(`document.getElementById('drawer-planner').open = true`);
    assert.match(
      await page.eval(`document.getElementById('drawer-planner-body').textContent`),
      /Alpha subtask/, 'the raw planner yaml is still reachable once opened');

    // Subtasks tab lists ALL of the epic's children (not just the nested ones —
    // the Build child belongs here too) with dependency state; a row click opens
    // that child
    assert.equal(await page.eval(`document.getElementById('drawer-details').hidden`), false);
    assert.equal(await page.eval(`document.getElementById('drawer-subtasks').hidden`), true);
    await page.eval(`document.querySelector('.drawer-tab[data-tab="subtasks"]').click()`);
    assert.equal(await page.eval(`document.getElementById('drawer-details').hidden`), true);
    assert.equal(await page.eval(`document.getElementById('drawer-subtasks').hidden`), false);
    const drawerRowIds = await page.eval(
      `[...document.querySelectorAll('#drawer-subtasks-list .subtask-row')].map((r) => r.dataset.id).sort()`);
    assert.deepEqual(drawerRowIds, ['task-0002', 'task-0003', 'task-0004'],
      'the drawer Subtasks tab lists every child, including the Build (execution-column) one');
    assert.match(
      await page.eval(`document.querySelector('#drawer-subtasks-list .subtask-row[data-id="task-0002"] .subtask-dep').textContent`),
      /waiting on task-0003/);
    await page.eval(`document.querySelector('#drawer-subtasks-list .subtask-row[data-id="task-0004"]').click()`);
    await until(async () =>
      (await page.eval(`document.getElementById('drawer-id').textContent === 'task-0004'`)) || null, { timeout: BUDGET.quick });
    assert.match(await page.eval(`document.getElementById('drawer-title').textContent`), /Gamma execution subtask/);
    // the click-through lands on Details, and the child (not itself an epic) shows
    // neither the Subtasks tab nor the Planner record
    assert.equal(await page.eval(`document.getElementById('drawer-tabs').hidden`), true,
      'a non-epic card shows neither the Subtasks tab nor the planner record');
    assert.equal(await page.eval(`document.getElementById('drawer-planner').hidden`), true);
    assert.equal(await page.eval(`document.getElementById('drawer-details').hidden`), false,
      'the drawer resets to Details so a click-through never lands on a tab this card doesn\'t have');
    await page.eval(`document.getElementById('drawer-close').click()`);

    // responsive rail: sticky alongside the details at a wide viewport, stacks
    // under it (static position, full width) at a narrow one
    await page.eval(`document.querySelector('.card[data-id="task-0001"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    await page.setViewport(1200, 900);
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.drawer-rail')).position`),
      'sticky', 'the rail is sticky alongside the details at a wide viewport');
    await page.setViewport(400, 800);
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.drawer-cols')).flexDirection`),
      'column', 'the details/rail columns stack at a narrow viewport');
    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('.drawer-rail')).position`),
      'static', 'the rail stacks under the details instead of sticking to a collapsed column at a narrow viewport');
    await page.setViewport(1200, 900);
    await page.eval(`document.getElementById('drawer-close').click()`);

    // Hostile hand-edited metadata: a parent link to a normal card must not
    // make the child disappear merely because the referenced card exists.
    await page.eval(`boardData.cards.push(
      { id: 'task-0090', status: 'Queue', title: 'Ordinary parent' },
      { id: 'task-0091', status: 'Planned', title: 'Child of ordinary card', parent: 'task-0090' }
    ); renderBoard()`);
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0091"]')`), true,
      'a child of a non-epic parent remains a full card');

    // A parent that cannot itself render as a full card cannot own nested rows.
    await page.eval(`boardData.cards.push(
      { id: 'task-0094', status: 'Unknown', title: 'Unknown-column epic', epic: true },
      { id: 'task-0095', status: 'Planned', title: 'Visible child', parent: 'task-0094' },
      { id: 'task-0096', status: 'Queue', title: 'Root epic', epic: true },
      { id: 'task-0097', status: 'Planned', title: 'Nested epic', epic: true, parent: 'task-0096' },
      { id: 'task-0098', status: 'Planned', title: 'Grandchild', parent: 'task-0097' }
    ); renderBoard()`);
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0095"]')`), true,
      'a child of an unknown-column epic remains visible as a full card');
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0098"]')`), true,
      'a child of an epic that is itself nested remains visible as a full card');

    // Archived-only view must not leak an active child through an archived
    // epic. Both parent and child have to pass the current view predicate.
    await page.eval(`boardData.cards.push(
      { id: 'task-0092', status: 'Queue', title: 'Archived epic', epic: true, archived: true },
      { id: 'task-0093', status: 'Planned', title: 'Active child', parent: 'task-0092', archived: false }
    ); showArchived = true; renderBoard()`);
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0092"]')`), true);
    assert.equal(await page.eval(`!!document.querySelector('[data-id="task-0092"] .subtask-row[data-id="task-0093"]')`), false,
      'archived-only view does not expose an active child as a nested row');
    assert.equal(await page.eval(`!!document.querySelector('.card[data-id="task-0093"]')`), false,
      'archived-only view does not expose an active child as a full card either');

    assert.deepEqual(page.errors, [], 'no uncaught exception or console error anywhere in the flow');
  }
});
