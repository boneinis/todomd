// A minimal headless-Chrome driver for the UI smoke test.
//
// Deliberately NOT Playwright/Puppeteer: this repo ships zero devDependencies
// and `npm test` is plain `node --test`. Chrome speaks the DevTools Protocol
// over a WebSocket, and `ws` is already a runtime dependency — so driving a
// browser costs ~100 lines and no install. Everything here degrades to
// "no browser found" so a machine without Chrome just skips the test.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean);

export function findChrome() {
  // An explicit override is authoritative in BOTH directions: if you named a
  // binary and it isn't there, skip rather than silently driving some other
  // Chrome. It's also the only way to exercise the skip path on a machine that
  // has Chrome installed.
  if (process.env.TODOMD_CHROME_BIN) {
    return fs.existsSync(process.env.TODOMD_CHROME_BIN) ? process.env.TODOMD_CHROME_BIN : null;
  }
  for (const bin of CANDIDATES) {
    try { if (fs.existsSync(bin)) return bin; } catch { /* unreadable path */ }
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch { /* not on PATH */ }
  }
  return null;
}

// request/response correlation + event fan-out over one CDP socket
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.method || 'cdp'})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 15_000).unref?.();
    });
  }
  on(fn) { this.listeners.add(fn); }
}

// Launch headless Chrome and attach to one blank page.
// Returns null when no browser is installed — the caller skips.
export async function openPage() {
  const bin = findChrome();
  if (!bin) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todomd-chrome-'));
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',        // 0 = OS picks; parsed off stderr below
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-gpu', '--disable-dev-shm-usage',  // the latter matters in containers
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  let browserWsUrl;
  try {
    browserWsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Chrome never printed a DevTools endpoint')), 20_000);
      child.stderr.on('data', (c) => {
        buf += c;
        const m = buf.match(/ws:\/\/\S+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)); });
    });
  } catch (e) { cleanup(); throw e; }

  const ws = new WebSocket(browserWsUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const cdp = new Cdp(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  // Everything the page complains about, in one list. An uncaught exception is
  // the signal that matters: it means a render aborted half-way.
  const errors = [];
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text || 'uncaught exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  return {
    errors,
    async goto(url) {
      await cdp.send('Page.navigate', { url }, sessionId);
    },
    // returns the value of `expression` evaluated in the page
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result?.value;
    },
    async close() {
      try { ws.close(); } catch { /* already closing */ }
      cleanup();
    },
  };
}
