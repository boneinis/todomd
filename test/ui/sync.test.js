// "Sync now" is the one piece of task-0044 that only matters as a rendered
// interaction: clicking the button must fetch+merge remote board metadata AND
// the already-open Mine view must pick up the new assignee without a manual
// reload. Node tests can assert the merge itself (github-sync.test.js) and
// the endpoint (server-routes.test.js); only a real page load proves the
// button is wired to it and that renderBoard() re-filters afterward.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isolateHome, makeRepo, git, tmp, until } from '../helpers.js';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';
import { pushMetadata } from '../../src/github-sync.js';
import { openPage } from '../browser.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function enableGithubSync(repo, remote, branch = 'todomd-state') {
  const file = path.join(repo, '.todomd/config.yml');
  fs.appendFileSync(file, `\ngithub_sync:\n  enabled: true\n  remote: ${remote}\n  branch: ${branch}\n`);
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'enable github_sync']);
}
function cloneRepo(from, into) {
  git(path.dirname(into), ['clone', '-q', from, into]);
  git(into, ['config', 'user.email', 'test@todomd.local']);
  git(into, ['config', 'user.name', 'todomd-test']);
  fs.mkdirSync(path.join(into, '.todomd/tasks'), { recursive: true });
  return into;
}

let page, srv, name;
const SKIP = 'no Chrome/Chromium found (set TODOMD_CHROME_BIN to run this)';

before(async () => {
  isolateHome();
  const origin = makeRepo();
  const dir = tmp('sync-ui');
  const worker = cloneRepo(origin, path.join(dir, 'worker'));
  const viewer = cloneRepo(origin, path.join(dir, 'viewer'));
  enableGithubSync(worker, 'origin');
  enableGithubSync(viewer, 'origin');

  // worker assigns a card to alice and publishes just the board metadata —
  // the viewer clone (below, the one the server/browser actually open) has
  // never seen this card until it clicks "sync now".
  const card = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(card), { recursive: true });
  fs.writeFileSync(card,
    '---\nid: task-0001\ntitle: Assigned elsewhere\nstatus: Queue\ntype: module\npriority: low\n' +
    'labels: []\ndependencies: []\ncreated_date: 2026-01-01\nsource: ui\nagent: claude\nassignee: alice\n' +
    'verification: { attempts: 0, max_attempts: 3, last_verdict: }\n---\n\n## Description\n\nbody\n\n' +
    '## Acceptance Criteria\n\n- [ ] done\n\n## Implementation Plan\n\n## Run Log\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  const push = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(push.ok, true, push.error);

  addProject(viewer);
  name = path.basename(viewer);
  page = await openPage();
  if (!page) return;
  srv = await startServer({ port: await freePort() });
});

after(async () => {
  try { await page?.close(); } catch { /* browser already gone */ }
  try { srv?.close(); } catch { /* already closed */ }
});

test('clicking "sync now" merges a remote assignee change and the open Mine view picks it up', async (t) => {
  if (!page) return t.skip(SKIP);
  // seeded before app.js's top-level script runs, so it boots straight into
  // "my work" filtered to the assignee the remote change is about
  await page.presetScript(`
    localStorage.setItem('todomd-me', 'alice');
    localStorage.setItem('todomd-view', 'mine');
  `);
  await page.goto(`http://127.0.0.1:${srv.port}/?token=${srv.token}&project=${encodeURIComponent(name)}`);
  await until(async () => await page.eval(`Array.isArray(boardData?.cards)`));

  // the card doesn't exist in this clone yet — Mine view has nothing to show
  assert.equal(await page.eval(`!!document.querySelector('[data-id="task-0001"]')`), false);
  assert.equal(await page.eval(`document.getElementById('sync-now').hidden`), false);

  await page.eval(`document.getElementById('sync-now').click()`);
  await until(async () => await page.eval(`!!document.querySelector('[data-id="task-0001"]')`));
  assert.match(await page.eval(`document.querySelector('[data-id="task-0001"]').textContent`), /Assigned elsewhere/);
});
