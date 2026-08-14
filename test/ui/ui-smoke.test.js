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
import { recordUsage } from '../../src/runstore.js';
import { loadConfig, readCard } from '../../src/board.js';
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
  recordUsage({ run_id: 'ui-codex', provider: 'codex', model: 'gpt-5.6-sol', execution_type: 'subscription_cli',
    usage: { available: true, input_tokens: 1200, cached_input_tokens: 900, output_tokens: 50 } });
  recordUsage({ run_id: 'ui-gateway', provider: 'gemini', execution_type: 'gateway', usage: { available: false } });
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
    const usageText = await page.eval(`document.getElementById('usage').textContent`);
    assert.match(usageText, /2 AI runs/);
    assert.match(usageText, /1\.2K in \/ 50 out/);
    assert.match(usageText, /1 usage unavailable/);
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

    // In-column drag uses the reorder endpoint (not the status-move endpoint),
    // persists the rank, then reloads the column in that same order.
    await page.eval(`(() => {
      const source = document.querySelector('[data-id="task-0003"]');
      const first = document.querySelector('[data-id="task-0001"]');
      const column = first.closest('.column');
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      column.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientY: first.getBoundingClientRect().top,
      }));
      column.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    const reviewOrder = await until(async () => {
      const ids = await page.eval(`[...document.querySelector('.column[data-status="Review"] .col-cards').children]
        .filter((el) => el.classList.contains('card')).map((el) => el.dataset.id)`);
      return ids[0] === 'task-0003' ? ids : null;
    }, { timeout: BUDGET.quick, label: 'task-0003 reordered before task-0001 in Review' });
    assert.equal(reviewOrder[0], 'task-0003');

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

test('UI smoke: Add Card is prompt-first and preserves Advanced options', async (t) => {
  if (!page) return t.skip(SKIP);
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  addProject(repo);
  const promptProject = path.basename(repo);

  page.errors.length = 0;
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(promptProject)}`);
  await until(async () => (await page.eval(`currentProject`)) === promptProject || null,
    { timeout: BUDGET.stage, label: 'prompt test project selected' });

  await page.eval(`document.getElementById('new-card').click()`);
  const initial = await page.eval(`({
    open: document.getElementById('card-advanced').open,
    focused: document.activeElement?.name,
    promptVisible: document.querySelector('[name=prompt]').getClientRects().length > 0,
    titleVisible: document.querySelector('#card-form [name=title]').getClientRects().length > 0,
  })`);
  assert.deepEqual(initial, { open: false, focused: 'prompt', promptVisible: true, titleVisible: false });

  await page.eval(`document.querySelector('#card-advanced summary').click()`);
  assert.equal(await page.eval(`document.querySelector('#card-form [name=title]').getClientRects().length > 0`), true,
    'the original structured fields remain available under Advanced options');
  await page.setViewport(390, 844);
  const mobileAdvanced = await page.eval(`(() => {
    const form = document.getElementById('card-form');
    return { overflowY: getComputedStyle(form).overflowY, scrolls: form.scrollHeight > form.clientHeight };
  })()`);
  assert.deepEqual(mobileAdvanced, { overflowY: 'auto', scrolls: true },
    'the full Advanced form remains scrollable on a phone-sized viewport');
  await page.setViewport(1280, 900);

  const prompt = '## Fix interrupted builds\n\nResume from the preserved worktree without losing partial changes.';
  await page.eval(`(() => {
    const form = document.getElementById('card-form');
    form.elements.prompt.value = ${JSON.stringify(prompt)};
    form.elements.description.value = 'Keep the board API compatible.';
    form.requestSubmit();
  })()`);
  await until(async () => (await page.eval(
    `!!document.querySelector('[data-id="task-0001"]') && document.getElementById('modal-backdrop').hidden`)) || null,
  { timeout: BUDGET.stage, label: 'prompt-created Review card rendered' });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.title, 'Fix interrupted builds');
  assert.equal(card.data.status, 'Review');
  assert.match(card.body, /Resume from the preserved worktree without losing partial changes\./);
  assert.match(card.body, /Additional context:\nKeep the board API compatible\./);
  assert.deepEqual(page.errors, [], 'prompt-first creation produces no browser errors');
});

test('UI smoke: column agent and model selections persist and stay synchronized', async (t) => {
  if (!page) return t.skip(SKIP);
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  addProject(repo);
  const routingProject = path.basename(repo);

  page.errors.length = 0;
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(routingProject)}`);
  await until(async () => (await page.eval(`currentProject`)) === routingProject || null,
    { timeout: BUDGET.stage, label: 'routing test project selected' });
  await page.eval(`document.querySelector('.column[data-status="Plan"] .col-edit').click()`);
  await until(async () => (await page.eval(
    `!document.getElementById('prompts-backdrop').hidden && document.querySelectorAll('#stage-model option').length > 1`)) || null,
  { timeout: BUDGET.stage, label: 'Plan routing controls loaded' });

  assert.equal(await page.eval(`document.getElementById('stage-model').tagName`), 'SELECT',
    'the model is a real selectable control rather than a fragile free-text datalist');
  await page.eval(`(() => {
    const select = document.getElementById('stage-agent');
    select.value = 'gemini';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => loadConfig(repo).stages.Plan.agent === 'gemini' || null,
    { timeout: BUDGET.quick, label: 'Gemini agent persisted' });
  await until(async () => (await page.eval(
    `document.getElementById('stage-model').value === '' && [...document.querySelectorAll('#stage-model option')].some((o) => o.value === 'gemini-3.7-flash-high')`)) || null,
  { timeout: BUDGET.stage, label: 'model reset and Gemini choices loaded' });

  await page.eval(`(() => {
    const select = document.getElementById('stage-model');
    select.value = 'gemini-3.7-flash-high';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => loadConfig(repo).stages.Plan.model === 'gemini-3.7-flash-high' || null,
    { timeout: BUDGET.quick, label: 'Gemini model persisted' });
  await until(async () => /runs as gemini · gemini-3\.7-flash-high/.test(
    await page.eval(`document.getElementById('stage-routing-note').textContent`)) || null,
  { timeout: BUDGET.quick, label: 'effective-route note matches the saved values' });
  assert.deepEqual(page.errors, [], 'routing changes produce no browser errors');
});

// The CI column (task-0041) added three run-state values — 'deferred-for-load',
// 'passed', 'failed' — alongside the existing 'queued'/'running'/'deferred'.
// renderBoard() only ever sees these via runStates, which a WebSocket
// 'run-state' message assigns verbatim (see connectWs) — so writing directly
// into runStates and re-rendering exercises the exact same code path a live
// event would, without needing a real CI run.
test('UI smoke: all five CI job states render their own card class and visible text', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    page.errors.length = 0;
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null, { timeout: BUDGET.stage });

    const cases = [
      { state: 'queued', stage: 'CI' },
      { state: 'running', stage: 'CI' },
      { state: 'deferred-for-load', stage: 'CI', reason: 'cpu critical' },
      { state: 'passed', stage: 'CI' },
      { state: 'failed', stage: 'CI' },
    ];
    for (const rs of cases) {
      const result = await page.eval(`(() => {
        runStates['task-0001'] = ${JSON.stringify(rs)};
        renderBoard();
        const el = document.querySelector('[data-id="task-0001"]');
        return { classes: [...el.classList], text: el.querySelector('.card-run').textContent };
      })()`);
      assert.ok(result.classes.includes(rs.state), `${rs.state} sets the .${rs.state} card class (got: ${result.classes.join(' ')})`);
      assert.ok(result.text.trim().length > 0, `${rs.state} renders non-empty run-status text`);
    }

    await page.eval(`(() => { delete runStates['task-0001']; renderBoard(); })()`); // leave no state behind for later tests
    assert.deepEqual(page.errors, [], 'no uncaught exception or console error rendering any of the five states');
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
    assert.match(rows[0], /body is very short/, 'the held-message reason is rendered');
    assert.match(rows[1], /Summer sale/);
    assert.match(rows[1], /spam/);
    assert.match(rows[1], /List-Unsubscribe header/, 'the spam reason is rendered');
    assert.equal(await page.eval(`document.getElementById('intake-audit-empty').hidden`), true,
      'the empty state is hidden once records are present');

    assert.deepEqual(page.errors, [], 'no uncaught exception or console error rendering the screened-email list');
  }
});

test('UI smoke: queue pause control persists across reload and resumes explicitly', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    page.errors.length = 0;
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
    // The button ships with textContent 'pause queue' in index.html, so its
    // label says nothing about whether the board has loaded yet — and its
    // click handler no-ops until `boardData` exists with full access. Wait for
    // the loaded board itself, or a click can land on the static markup and
    // silently do nothing.
    const boardLoaded = async () => (await page.eval(`boardData?.access`)) === 'full' || null;
    await until(boardLoaded, { timeout: BUDGET.stage, label: 'the board is loaded with full access' });

    // Poll the WHOLE end state, never a partial one: the button flips straight
    // from the POST response (applyQueuePause), while #usage is only rewritten
    // by the loadBoard() round-trip that follows it. Waiting on aria-pressed
    // and then hard-asserting #usage samples that gap — which widens with
    // server latency — and fails intermittently under load.
    const pauseState = `({
      pressed: document.getElementById('queue-pause').getAttribute('aria-pressed'),
      label: document.getElementById('queue-pause').textContent,
      usage: document.getElementById('usage').textContent,
    })`;
    const pausedEverywhere = (s) => s.pressed === 'true' && s.label === 'resume queue' && /queue paused/.test(s.usage);

    await page.eval(`document.getElementById('queue-pause').click()`);
    await until(async () => pausedEverywhere(await page.eval(pauseState)) || null,
      { timeout: BUDGET.stage, label: 'pause reflected in the button and the usage line' });
    assert.equal(await page.eval(`document.getElementById('queue-run').disabled`), true,
      'run queue is guarded while this project is paused');

    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
    await until(async () => pausedEverywhere(await page.eval(pauseState)) || null,
      { timeout: BUDGET.stage, label: 'the server-backed pause survives a page and board reload' });

    await until(boardLoaded, { timeout: BUDGET.stage, label: 'the reloaded board is ready for the resume click' });
    await page.eval(`document.getElementById('queue-pause').click()`);
    await until(async () => {
      const s = await page.eval(pauseState);
      return (s.pressed === 'false' && s.label === 'pause queue' && !/queue paused/.test(s.usage)) || null;
    }, { timeout: BUDGET.stage, label: 'resume clears the button and the usage line' });
    assert.deepEqual(page.errors, [], 'pause/resume produces no browser errors');
  }
});

test('UI smoke: token scrubbing preserves the explicit project and card hash', async (t) => {
  if (!page) return t.skip(SKIP);
  await page.eval(`localStorage.setItem('todomd-project', 'stale-project')`);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}#task-0001`);
  await until(async () => (await page.eval(`currentProject`)) === name || null,
    { timeout: BUDGET.stage, label: 'explicit project selected' });
  const locationState = await page.eval(`({ search: location.search, hash: location.hash, project: currentProject,
    stored: localStorage.getItem('todomd-project') })`);
  assert.equal(locationState.project, name);
  assert.equal(locationState.stored, name);
  assert.match(locationState.search, /project=/);
  assert.doesNotMatch(locationState.search, /token=/);
  assert.equal(locationState.hash, '#task-0001');
});

// task-0045: a scrollbar-consuming column and border-left status stripes both
// shrank a card's content box, so dragging a card between columns (or into a
// running/queued state) visibly changed its width. This test replaces the
// board with a minimal synthetic layout — real .column/.col-cards/.card
// markup, no app state needed — so it exercises the CSS rules directly rather
// than depending on runStates plumbing. It's the LAST test in this file: it
// tears down boardEl's contents and doesn't restore them.
test('UI smoke: card width is unaffected by column overflow or running/queued status', async (t) => {
  if (!page) return t.skip(SKIP);
  {
    await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
    await until(async () => (await page.eval(`document.querySelectorAll('.card').length`)) || null,
      { timeout: BUDGET.stage });
    await page.setViewport(1200, 900);

    const widths = await page.eval(`(() => {
      boardEl.innerHTML = '';
      const makeColumn = (cardCount) => {
        const col = document.createElement('section');
        col.className = 'column';
        const list = document.createElement('div');
        list.className = 'col-cards';
        for (let i = 0; i < cardCount; i++) {
          const card = document.createElement('div');
          card.className = 'card';
          if (i === 0) card.classList.add('running');
          if (i === 1) card.classList.add('queued');
          list.appendChild(card);
        }
        col.appendChild(list);
        boardEl.appendChild(col);
      };
      makeColumn(80); // enough cards to force .col-cards to scroll
      makeColumn(1);  // no overflow — should still match
      return [...document.querySelectorAll('.card')].map((c) => c.getBoundingClientRect().width);
    })()`);
    const unique = new Set(widths.map((w) => Math.round(w * 100) / 100));
    assert.equal(unique.size, 1,
      `every card (overflowing column, non-overflowing column, running, queued, plain) must report the same width, got ${JSON.stringify(widths)}`);

    assert.deepEqual(page.errors, [], 'no console error building the synthetic card-width layout');
  }
});
