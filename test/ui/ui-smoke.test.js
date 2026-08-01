// The board UI is ~1000 lines of vanilla JS that nothing else covers: node
// tests can't see a render, so a throw inside renderBoard ships silently. Two
// such bugs were only ever found by loading the page in a browser — a scalar
// `dependencies:` reaching `.some()` blanked the ENTIRE board, and a mapping
// `labels:` made a card un-openable (the click threw, so no drawer at all).
//
// This is deliberately a SMOKE test, not an e2e suite: seed the shapes that
// broke it, then assert the board rendered and the console stayed clean. The
// pipeline is covered properly by the fake-agent tests; driving it through a
// browser would be slow and flaky for no extra coverage.
//
// It lives in test/ui/ so `node --test test/*.test.js` does NOT pick it up:
// `npm test` runs the two globs in sequence. Headless Chrome is ~15 processes,
// and running it alongside 18 subprocess-heavy test files starved them into
// `until()` timeouts — `npm test` is also todomd's verify_command, where a
// flaky suite means false Needs Human escalations on real cards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, until, git, BUDGET } from '../helpers.js';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';
import { appendIntakeAudit } from '../../src/screen.js';
import { openPage } from '../browser.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Every card shape that has broken the UI, plus one that can't be parsed at
// all. Budget mode so the server manages the board without spawning agents.
function hostileBoard() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  const card = (name, body) => fs.writeFileSync(path.join(repo, '.todomd/tasks', name), body);
  card('task-0001-scalar-label.md',
    '---\nid: task-0001\ntitle: labels as a bare string\nstatus: Review\ntype: improvement\n' +
    'labels: ui\nassignee: 12345\n---\n\n## Description\n\nhand-edited\n');
  card('task-0002-mapping-label.md',
    '---\nid: task-0002\ntitle: labels as a YAML mapping\nstatus: Queue\ntype: bug\n' +
    'labels: {a: 1}\nneeds_human_reason: 42\n---\n\n## Description\n\nhand-edited\n');
  card('task-0003-scalar-children.md',
    '---\nid: task-0003\ntitle: epic with scalar children\nstatus: Review\ntype: module\n' +
    'epic: true\nchildren: task-0004\n---\n\n## Description\n\nhand-edited\n');
  card('task-0004-scalar-deps.md',
    // status: Build (a stage/execution column), not Review — task-0029 nests a
    // child under its epic when its own column isn't an active execution
    // column, and this hostile-shapes suite still wants task-0004 as a full
    // card (see test/ui/hierarchy.test.js for the nesting behavior itself).
    '---\nid: task-0004\ntitle: chunk with scalar dependencies\nstatus: Build\ntype: module\n' +
    'parent: task-0003\ndependencies: task-0002\n---\n\n## Description\n\nhand-edited\n');
  // not valid frontmatter at all — must be surfaced, not fatal
  card('task-0005-broken.md', '---\ntitle: "unterminated\nstatus: Review\n---\nbroken\n');
  card('task-0006-resumable.md',
    '---\nid: task-0006\ntitle: resumable orphaned build\nstatus: Needs Human\ntype: bug\n' +
    'labels: []\nneeds_human_reason: orphaned_run\nrecovery_stage: Build\nworktree: todomd/task-0006\n---\n\n## Description\n\npreserved\n');
  card('task-0007-restartable.md',
    '---\nid: task-0007\ntitle: restartable orphaned build\nstatus: Needs Human\ntype: bug\n' +
    'labels: []\nneeds_human_reason: orphaned_run\nworktree: todomd/task-0007\n---\n\n## Description\n\nmissing worktree\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'hostile UI fixtures']);
  git(repo, ['worktree', 'add', '-q', '-b', 'todomd/task-0006', path.join(repo, '.todomd/worktrees/task-0006')]);
  return repo;
}

// One Chrome launch and one server for the whole file: `npm test` is also
// todomd's own verify gate, so every build pays this — a second browser boot
// would be ~8s of pure overhead per run.
let page, srv, name, viewerToken;
const SKIP = 'no Chrome/Chromium found (set TODOMD_CHROME_BIN to run this)';

before(async () => {
  isolateHome();
  const repo = hostileBoard();
  addProject(repo);
  name = path.basename(repo);
  page = await openPage();
  if (!page) return;
  srv = await startServer({ port: await freePort() });
  viewerToken = fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', 'token-viewer'), 'utf8').trim();
});

after(async () => {
  try { await page?.close(); } catch { /* browser already gone */ }
  try { srv?.close(); } catch { /* already closed */ }
});

test('UI smoke: hostile card shapes render, drawer opens, console stays clean', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);

    // all seven cards render — a throw anywhere in the render path drops the
    // whole board, so the COUNT is the assertion that catches it
    const count = await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null,
      { timeout: BUDGET.stage });
    assert.equal(count, 7, 'every card rendered (a render throw would blank the board)');
    assert.equal(await page.eval(`!!document.querySelector('[data-id="task-0005-broken"]')`), true,
      'the unparseable card is surfaced rather than swallowed');

    // the epic/chunk badges are computed FROM the scalar fields — the exact
    // expressions (.some / .length on a list field) that blanked the board
    assert.match(await page.eval(`document.querySelector('[data-id="task-0003"] .card-rel').textContent`),
      /epic 0\/1/, 'scalar children still drives the epic badge');
    assert.match(await page.eval(`document.querySelector('[data-id="task-0004"] .card-rel').textContent`),
      /chunk/, 'scalar dependencies still drives the chunk badge');

    // loadBoard normalizes the payload, so a raw scalar can no longer reach the
    // client through /api/board — which also means the client's OWN guard is
    // only reachable directly. Exercise it here, or it silently rots: if the
    // server ever stops normalizing (or a new endpoint doesn't), the board must
    // still not blank. This is the exact shape that took the whole board down.
    const survived = await page.eval(`(() => {
      const chunk = boardData.cards.find((c) => c.id === 'task-0004');
      chunk.dependencies = 'task-0002';
      chunk.labels = { a: 1 };
      renderBoard();
      return document.querySelectorAll('.card').length;
    })()`);
    assert.equal(survived, 7, 'the client survives a raw scalar on its own, independent of the server');

    // the drawer is the other place a bad shape aborted mid-render — and this
    // one is NOT masked by the server: /api/cards/:id returns raw frontmatter
    await page.eval(`document.querySelector('[data-id="task-0002"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    assert.match(await page.eval(`document.getElementById('drawer-title').textContent`), /YAML mapping/);
    assert.equal(await page.eval(`document.getElementById('drawer-resume-build').hidden`), true,
      'an ineligible card never shows Resume Build');

    await page.eval(`document.querySelector('[data-id="task-0006"]').click()`);
    await until(async () => /resumable orphaned build/.test(
      await page.eval(`document.getElementById('drawer-title').textContent`)) || null, { timeout: BUDGET.quick });
    assert.equal(await page.eval(`document.getElementById('drawer-resume-build').hidden`), false,
      'an eligible card with a registered preserved worktree shows Resume Build');

    await page.eval(`document.querySelector('[data-id="task-0007"]').click()`);
    await until(async () => /restartable orphaned build/.test(
      await page.eval(`document.getElementById('drawer-title').textContent`)) || null, { timeout: BUDGET.quick });
    assert.equal(await page.eval(`document.getElementById('drawer-restart-build').hidden`), false,
      'an orphan whose preserved assets are gone shows Restart Build');

    assert.deepEqual(page.errors, [], 'no uncaught exception or console error anywhere in the flow');
  }
});

test('UI smoke: a viewer is not told its session expired when it opens a card', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    page.errors.length = 0; // fresh slate: assert only on this flow
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${viewerToken}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });

    // The drawer fetches the run log, which viewers may not read. That denial
    // must be a 403: the UI turns ANY 401 into "session expired — restart
    // todomd", which nagged every viewer on the default QR link.
    await page.eval(`document.querySelector('[data-id="task-0001"]').click()`);
    await until(async () => (await page.eval(`!document.getElementById('drawer').hidden`)) || null, { timeout: BUDGET.quick });
    await until(async () => (await page.eval(
      `document.activeElement === document.getElementById('drawer-close')`)) || null,
    { timeout: BUDGET.quick });

    // Viewer mode hides the entire action rail with CSS (rather than hidden
    // attributes), so the focus trap must skip those invisible controls.
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))`);
    assert.equal(await page.eval(
      `document.activeElement.getClientRects().length > 0 && !document.activeElement.closest('.drawer-rail')`),
    true, 'Shift+Tab wraps to the last rendered modal control, not a CSS-hidden viewer action');
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }))`);
    assert.equal(await page.eval(`document.activeElement === document.getElementById('drawer-close')`), true,
      'Tab from the last rendered control wraps forward to close');

    const toast = await page.eval(
      `document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`);
    assert.doesNotMatch(toast, /session expired/, 'a permitted-but-limited viewer is never told to restart todomd');
    assert.deepEqual(page.errors, [], 'no console error on the viewer path');
  }
});

test('UI smoke: screened email list renders seeded records, and a held email card sits in Needs Human', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    // a separate project so this doesn't disturb hostileBoard()'s card count
    const repo = makeRepo();
    const cfg = path.join(repo, '.todomd/config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
    addProject(repo);
    const emailProject = path.basename(repo);

    writeCard(repo, 'task-0001', {
      status: 'Needs Human',
      title: 'Quick question about export',
      body: 'From: Jane Doe <jane@example.com>\n\nDoes the export feature support CSV?',
      extra: 'needs_human_reason: "Unclear whether this is real work (body is very short)"\n',
    });
    await appendIntakeAudit(repo, {
      timestamp: '2026-07-31T10:00:00.000Z', source: 'main', from: 'Shop <no-reply@shop.example.com>',
      subject: 'Summer sale', messageId: '<a@shop.example.com>', verdict: 'spam',
      reason: 'Looks like marketing/automated mail (has a List-Unsubscribe header)', card: '',
    });
    await appendIntakeAudit(repo, {
      timestamp: '2026-07-31T11:00:00.000Z', source: 'main', from: 'Jane Doe <jane@example.com>',
      subject: 'Quick question about export', messageId: '<b@example.com>', verdict: 'unclear',
      reason: 'Unclear whether this is real work (body is very short)', card: 'task-0001',
    });

    page.errors.length = 0;
    // the project switcher (not a URL param) is how the client picks a board —
    // reload, wait for the registry-backed <select> to list both projects, then
    // switch to the freshly-registered one the way a user would.
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
    await until(async () => (await page.eval(`document.querySelectorAll('#project option').length`)) >= 2 || null,
      { timeout: BUDGET.stage });
    await page.eval(`(() => {
      const sel = document.getElementById('project');
      sel.value = ${JSON.stringify(emailProject)};
      sel.dispatchEvent(new Event('change'));
    })()`);

    // the held email card renders in the Needs Human column
    await until(async () => (await page.eval(
      `!!document.querySelector('.column[data-status="Needs Human"] [data-id="task-0001"]')`)) || null,
    { timeout: BUDGET.stage });

    // open the intake settings panel and wait for the screened-email list to load
    await page.eval(`document.getElementById('intake-btn').click()`);
    await until(async () => (await page.eval(`!document.getElementById('intake-backdrop').hidden`)) || null, { timeout: BUDGET.quick });
    await until(async () => (await page.eval(`document.querySelectorAll('#intake-audit-list .intake-audit-row').length`)) || null,
      { timeout: BUDGET.quick });

    const rows = await page.eval(
      `[...document.querySelectorAll('#intake-audit-list .intake-audit-row')].map((r) => r.textContent)`);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /Quick question about export/, 'newest record first');
    assert.match(rows[0], /unclear/);
    assert.match(rows[1], /Summer sale/);
    assert.match(rows[1], /spam/);
    assert.equal(await page.eval(`document.getElementById('intake-audit-empty').hidden`), true,
      'the empty state is hidden once records are present');

    assert.deepEqual(page.errors, [], 'no uncaught exception or console error rendering the screened-email list');
  }
});
