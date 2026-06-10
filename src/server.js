import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { listProjects, addProject, removeProject } from './registry.js';
import { loadBoard, readCard, createCard, patchFrontmatter, attachCard } from './board.js';
import { initProject } from './templates.js';
import { isGitRepo } from './git.js';

const FILE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv', '.json': 'application/json',
};
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.pdf', '.txt', '.md']);
import * as pipeline from './pipeline.js';
import { startIntake } from './intake.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// Tokens persisted per machine so restarts don't invalidate open tabs.
// `token` = full access; `viewer` = read-only (the QR/mobile monitor link).
function loadToken(name) {
  const file = path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', name);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

export function startServer({ port = 7337, lan = false } = {}) {
  const token = loadToken('token');
  const viewerToken = loadToken('token-viewer');
  const mobileToken = loadToken('token-mobile'); // full control, revocable per device class

  const sentToken = (req) => {
    const url = new URL(req.url, 'http://x');
    return url.searchParams.get('token') || req.headers['x-todomd-token'] || '';
  };
  const eq = (a, b) => {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  const primary = (req) => eq(sentToken(req), token);
  const authed = (req) => primary(req) || eq(sentToken(req), mobileToken);
  const viewerAuthed = (req) => authed(req) || eq(sentToken(req), viewerToken);

  // DNS-rebinding / CSRF defense: the browser sends the rebound or foreign
  // hostname as Host, and a cross-site page sends its own Origin. Allow only
  // our own loopback (and the LAN ip when --lan). Native clients (curl, the
  // CLI) send no Origin, which is fine — they still need a token.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (lan && lanAddress()) allowedHosts.add(`${lanAddress()}:${port}`);
  const hostOk = (req) => allowedHosts.has(req.headers.host);
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return allowedHosts.has(new URL(o).host); } catch { return false; }
  };

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const findProject = (name) => listProjects().find((p) => p.name === name);

  async function handleApi(req, res, url) {
    if (!hostOk(req)) return json(res, 403, { error: 'bad host' });
    if (req.method !== 'GET' && !originOk(req)) return json(res, 403, { error: 'bad origin' });
    // reads work with either token; anything that mutates or spawns
    // requires the full token (the viewer/QR link is monitor-only)
    if (!viewerAuthed(req)) return json(res, 401, { error: 'bad token' });
    const fullAccess = authed(req);
    if (!fullAccess && req.method !== 'GET') {
      return json(res, 403, { error: 'read-only link — open the board on your computer to make changes' });
    }

    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') return json(res, 200, { projects: listProjects().map((p) => p.name) });
      if (req.method === 'POST') {
        // add a repo: validate it's a git repo, scaffold the board, register it
        let body = '';
        for await (const chunk of req) body += chunk;
        let dir;
        try { dir = String(JSON.parse(body || '{}').path || '').trim(); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        if (!dir) return json(res, 400, { error: 'path is required' });
        if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
        // realpath so a symlinked path can't redirect the scaffold writes elsewhere
        try { dir = fs.realpathSync(path.resolve(dir)); } catch { return json(res, 400, { error: 'not a folder on this machine' }); }
        if (!fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'not a folder on this machine' });
        if (!(await isGitRepo(dir))) return json(res, 400, { error: 'not a git repo — run `git init` there first' });
        try {
          initProject(dir);                 // idempotent: scaffolds a board or no-ops
          const abs = addProject(dir);
          const name = listProjects().find((p) => p.path === abs)?.name;
          return json(res, 200, { ok: true, name });
        } catch (e) {
          return json(res, 400, { error: String(e.message || e) });
        }
      }
    }
    const rmProject = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (rmProject && req.method === 'DELETE') {
      let name;
      try { name = decodeURIComponent(rmProject[1]); } catch { return json(res, 400, { error: 'bad project name' }); }
      if (pipeline.projectHasLiveRun(name)) {
        return json(res, 400, { error: 'a card is running in this project — cancel it first' });
      }
      removeProject(name);            // unregister; board files untouched
      pipeline.forgetProject(name);   // drop in-memory queue/quota state for the name
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/qr') {
      const wantFull = url.searchParams.get('access') === 'full';
      // minting any QR needs full access; minting the CONTROL QR needs the
      // primary desktop token specifically (a phone can't escalate itself)
      if (!fullAccess || (wantFull && !primary(req))) return json(res, 403, { error: 'not allowed from this link' });
      const ip = lan ? lanAddress() : null;
      if (!ip) {
        return json(res, 400, { error: 'LAN access is off — restart with `todomd --lan` to enable the mobile link' });
      }
      const link = `http://${ip}:${port}/?token=${wantFull ? mobileToken : viewerToken}`;
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 240, color: { dark: wantFull ? '#ffb454' : '#d4dcc9', light: '#0a0c0a' } });
      return json(res, 200, { url: link, svg, access: wantFull ? 'full' : 'viewer' });
    }
    const project = findProject(url.searchParams.get('project') || '');
    if (!project) return json(res, 404, { error: 'unknown project' });

    if (url.pathname === '/api/board') {
      const board = loadBoard(project.path);
      return json(res, 200, {
        ...board,
        mode: board.config.mode || 'launcher',
        access: fullAccess ? 'full' : 'viewer',
        runStates: pipeline.getRunStates(project.name),
        banners: pipeline.getBanners(),
        usage: pipeline.usage(project.name),
      });
    }
    if (url.pathname === '/api/cards' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let fields;
      try {
        fields = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      const result = await createCard(project.path, fields);
      if (result.ok) pipeline.maybeTriage(project, result.id).catch(() => {});
      return json(res, result.ok ? 200 : 400, result);
    }
    // serve an attachment — STRICTLY confined to .todomd/attachments/ so a
    // viewer-token holder can't read arbitrary repo files (source, secrets)
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('p') || '';
      const attDir = path.join(project.path, '.todomd', 'attachments');
      const abs = path.resolve(project.path, rel);
      if (!abs.startsWith(attDir + path.sep)) return json(res, 404, { error: 'not found' });
      // realpath both sides so a symlink inside attachments/ can't read repo
      // secrets: the resolved target must still live under the resolved dir
      let real, root;
      try { root = fs.realpathSync(attDir); real = fs.realpathSync(abs); } catch { return json(res, 404, { error: 'not found' }); }
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) {
        return json(res, 404, { error: 'not found' });
      }
      const ext = path.extname(real).toLowerCase();
      res.writeHead(200, {
        'content-type': FILE_MIME[ext] || 'application/octet-stream',
        'content-disposition': `${INLINE_EXT.has(ext) ? 'inline' : 'attachment'}; filename="${path.basename(real).replace(/"/g, '')}"`,
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
      });
      return res.end(fs.readFileSync(real));
    }
    const cardMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)$/);
    if (cardMatch && req.method === 'GET') {
      const card = readCard(project.path, cardMatch[1]);
      return card ? json(res, 200, card) : json(res, 404, { error: 'card not found' });
    }
    const attachMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/attach$/);
    if (attachMatch && req.method === 'POST') {
      let name = req.headers['x-filename'] || url.searchParams.get('name') || 'file';
      try { name = decodeURIComponent(name); } catch { /* keep raw — attachCard sanitizes */ }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'file too large (25 MB max)' });
        chunks.push(c);
      }
      const result = await attachCard(project.path, attachMatch[1], name, Buffer.concat(chunks));
      return json(res, result.ok ? 200 : 400, result);
    }
    const moveMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/move$/);
    if (moveMatch && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let status;
      try {
        ({ status } = JSON.parse(body || '{}'));
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      // every API move is a human move: the §3.1 table is enforced here
      const result = await pipeline.humanMove(project, moveMatch[1], status);
      return json(res, result.ok ? 200 : 400, result);
    }
    // human-owned routing fields, editable from the drawer
    const setMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/set$/);
    if (setMatch && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let fields;
      try {
        fields = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      if (pipeline.hasLiveRun(project.name, setMatch[1])) {
        return json(res, 400, { error: 'run in progress — cancel it first' });
      }
      const updates = {};
      if ('agent' in fields) {
        if (!['claude', 'codex'].includes(fields.agent)) return json(res, 400, { error: 'agent must be claude or codex' });
        updates.agent = fields.agent;
      }
      if ('model' in fields) updates.model = String(fields.model || '').replace(/[^\w.-]/g, '');
      if ('skill' in fields) updates.skill = String(fields.skill || '').replace(/[^\w:-]/g, '');
      if ('assignee' in fields) updates.assignee = String(fields.assignee || '').replace(/[^\w.@ -]/g, '').trim();
      if (!Object.keys(updates).length) return json(res, 400, { error: 'nothing to set' });
      const result = await patchFrontmatter(project.path, setMatch[1], updates);
      return json(res, result.ok ? 200 : 400, result);
    }
    const cancelMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const result = await pipeline.cancel(project, cancelMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/resume-queues' && req.method === 'POST') {
      // resume only the board the user clicked, not every paused project
      pipeline.resumeQueues([project]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const abs = path.join(PUBLIC, path.normalize(file));
      if (abs.startsWith(PUBLIC + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(abs));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      // a bad request or a corrupt board file must never take the server down
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
      else res.end();
    }
  });

  // websocket: push "board changed" pings per project, with liveness pings
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req) || !originOk(req) || !viewerAuthed(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000).unref();

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };

  // watch every registered project's tasks dir; reconcile with the registry
  // so removed projects release their watchers (chokidar v4: plain paths only)
  const watchers = new Map();
  const watchProjects = () => {
    const current = new Map(
      listProjects().map((p) => [path.join(p.path, '.todomd', 'tasks'), p.name])
    );
    for (const [dir, w] of watchers) {
      if (!current.has(dir)) { w.close(); watchers.delete(dir); }
    }
    for (const [dir, name] of current) {
      if (watchers.has(dir) || !fs.existsSync(dir)) continue;
      let timer;
      const project = listProjects().find((p) => p.name === name);
      const w = chokidar.watch(dir, { ignoreInitial: true });
      w.on('error', () => {});
      w.on('all', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          broadcast({ type: 'board-changed', project: name });
          if (project) pipeline.triageSweep(project); // annotate externally-arrived cards
        }, 1500);
      });
      watchers.set(dir, w);
    }
  };
  watchProjects();
  setInterval(watchProjects, 10_000).unref();

  pipeline.init({ broadcast });
  pipeline.reconcileOnBoot().catch(() => {});

  // IMAP email intake: poll configured mailboxes → cards in Review → triage
  startIntake({
    getProject: (name) => listProjects().find((p) => p.name === name),
    onCard: (project, id) => pipeline.maybeTriage(project, id).catch(() => {}),
    log: (m) => console.log(m),
  });

  return new Promise((resolve) => {
    server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        lanUrl: lan && lanAddress() ? `http://${lanAddress()}:${port}/?token=${viewerToken}` : null,
        port, token, server,
      });
    });
  });
}
