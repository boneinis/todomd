import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeRepo, BUDGET, timeoutScale } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// grab an OS-assigned free port so parallel/repeated runs never collide (a fixed
// port EADDRINUSE's a second concurrent instance)
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// boots the real server on a free test port and exercises the LAN toggle
test('runtime LAN toggle: off at start, status gated by token, primary-only POST', async () => {
  isolateHome();
  addProject(makeRepo()); // serve needs a registered project for some routes
  const { token, port, close } = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${port}`;
  try {
    // no token → 401
    assert.equal((await fetch(`${base}/api/lan`)).status, 401);
    // with the desktop token → enabled:false at start (loopback-only default)
    let r = await fetch(`${base}/api/lan`, { headers: { 'x-todomd-token': token } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).enabled, false);
    // QR while off → lan_off signal
    r = await fetch(`${base}/api/qr`, { headers: { 'x-todomd-token': token } });
    assert.equal((await r.json()).error, 'lan_off');
    // a cross-site POST (foreign Origin) is rejected
    r = await fetch(`${base}/api/lan`, { method: 'POST', headers: { 'x-todomd-token': token, 'content-type': 'application/json', origin: 'http://evil.com' }, body: '{"enabled":true}' });
    assert.equal(r.status, 403);
    // but a SAME-origin POST (the browser always sends Origin) must NOT be blocked
    r = await fetch(`${base}/api/lan`, { method: 'POST', headers: { 'x-todomd-token': token, 'content-type': 'application/json', origin: base }, body: '{"enabled":false}' });
    assert.notEqual(r.status, 403, 'same-origin browser POST must pass the Origin check');
    // disabling (no-op) succeeds and stays off
    r = await fetch(`${base}/api/lan`, { method: 'POST', headers: { 'x-todomd-token': token, 'content-type': 'application/json' }, body: '{"enabled":false}' });
    assert.equal((await r.json()).enabled, false);
  } finally {
    close();
  }
});

// close() must release EVERY event-loop handle: the listeners, open WebSockets,
// the ping/rescan timers and the chokidar watchers (a live rescan timer would
// re-open watchers right after close). Asserted the only way that can't be
// faked from inside the same process: a child that boots the server against a
// registered board, closes it, and must exit on its own. A regression here
// doesn't fail a test — it hangs whatever process embeds the server.
test('close() releases every handle — the process exits on its own', async () => {
  const home = isolateHome();
  const repo = makeRepo();
  addProject(repo);
  const script = path.join(ROOT, 'test/fixtures/boot-and-close.mjs');

  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, TODOMD_HOME: home, TODOMD_TEST_REPO: repo },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  // scaled like until(): this child boots a whole server, and a fixed 15s
  // deadline reported "handle leak" (exit=null) on a machine that was merely
  // busy — the exact false alarm this scaling exists to prevent
  const deadline = Math.round(BUDGET.stage * timeoutScale());
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, deadline);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exited, 0, exited === null
    ? `server process was still alive ${deadline}ms after close() — a handle was leaked (or the machine is too busy; scale was ${timeoutScale().toFixed(1)}x)`
    : `server process exited ${exited} instead of 0 after close(): ${stderr}`);
});
