import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isolateHome, makeRepo } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';

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
