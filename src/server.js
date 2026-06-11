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
import { loadBoard, readCard, createCard, patchFrontmatter, attachCard, readCommandParts, writeCommandCustom, loadConfig, setArchived, deleteCard, listSkills, readRunLog } from './board.js';
import { listModels } from './models.js';
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
import { startIntake, restartIntake, publicIntake, saveBoardIntake, testIntake } from './intake.js';

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
  // our own loopback (and the live LAN ip when LAN access is on). Native
  // clients (curl, the CLI) send no Origin, which is fine — they still need a token.
  const loopbackHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  let lanEnabled = false;     // runtime-toggleable; the LAN listener below
  let lanServer = null;
  const hostOk = (req) => {
    const h = req.headers.host;
    if (loopbackHosts.has(h)) return true;
    return lanEnabled && lanAddress() && h === `${lanAddress()}:${port}`; // live IP, not frozen at boot
  };
  const lanUrl = () => (lanEnabled && lanAddress() ? `http://${lanAddress()}:${port}/?token=${viewerToken}` : null);
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true; // native clients (curl, the CLI) send none
    try { return hostOk({ headers: { host: new URL(o).host } }); } catch { return false; }
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
        try { dir = String(JSON.parse(body || '{}').path || ''); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        // forgive common paste artifacts: zero-width junk, non-breaking / odd
        // spaces (a nbsp pasted into "web dev" is the usual culprit), wrapping quotes
        dir = dir.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/[\u00A0\u2007\u2009\u202F]/g, " ").trim().replace(/^['"]|['"]$/g, "").trim();
        if (!dir) return json(res, 400, { error: 'path is required' });
        if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
        // realpath so a symlinked path can't redirect the scaffold writes elsewhere
        try { dir = fs.realpathSync(path.resolve(dir)); } catch { return json(res, 400, { error: `couldn't find that folder — check for typos or stray spaces. Got: ${dir}` }); }
        if (!fs.statSync(dir).isDirectory()) return json(res, 400, { error: `that path is a file, not a folder: ${dir}` });
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
    // IMAP email-intake settings for a project. Full token only (host/user are
    // sensitive; the password is never sent back to the browser).
    if (url.pathname === '/api/intake' || url.pathname === '/api/intake/test') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const name = url.searchParams.get('project') || '';
      if (!listProjects().some((p) => p.name === name)) return json(res, 404, { error: 'unknown project' });
      if (url.pathname === '/api/intake' && req.method === 'GET') {
        return json(res, 200, publicIntake(name));
      }
      if (url.pathname === '/api/intake' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let f;
        try { f = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        saveBoardIntake(name, {
          host: String(f.host || '').trim(),
          port: Number(f.port) || 993,
          secure: f.secure !== false,
          user: String(f.user || '').trim(),
          pass: f.pass ? String(f.pass) : '', // blank keeps the saved one
          folder: String(f.folder || 'INBOX').trim(),
          pollSeconds: Math.max(30, Number(f.pollSeconds) || 300),
          assignee: String(f.assignee || '').replace(/[^\w.@ -]/g, '').trim() || undefined,
        });
        restartIntake();               // pick up the change without a server restart
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/intake/test' && req.method === 'POST') {
        const r = await testIntake(name);
        return json(res, r.ok ? 200 : 400, r);
      }
    }
    // LAN access state + runtime toggle. Enabling exposes the board to the
    // network, so the toggle needs the PRIMARY desktop token (not mobile).
    if (url.pathname === '/api/lan') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      if (req.method === 'GET') return json(res, 200, { enabled: lanEnabled, canToggle: primary(req), ip: lanAddress() });
      if (req.method === 'POST') {
        if (!primary(req)) return json(res, 403, { error: 'enable LAN from the computer running todomd' });
        let body = '';
        for await (const chunk of req) body += chunk;
        let on;
        try { on = !!JSON.parse(body || '{}').enabled; } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        const r = setLan(on);
        return json(res, r.ok ? 200 : 400, r);
      }
    }
    if (url.pathname === '/api/qr') {
      const wantFull = url.searchParams.get('access') === 'full';
      // minting any QR needs full access; minting the CONTROL QR needs the
      // primary desktop token specifically (a phone can't escalate itself)
      if (!fullAccess || (wantFull && !primary(req))) return json(res, 403, { error: 'not allowed from this link' });
      const ip = lanEnabled ? lanAddress() : null;
      if (!ip) return json(res, 400, { error: 'lan_off' });
      const link = `http://${ip}:${port}/?token=${wantFull ? mobileToken : viewerToken}`;
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 240, color: { dark: wantFull ? '#ffb454' : '#d4dcc9', light: '#0a0c0a' } });
      return json(res, 200, { url: link, svg, access: wantFull ? 'full' : 'viewer' });
    }
    const project = findProject(url.searchParams.get('project') || '');
    if (!project) return json(res, 404, { error: 'unknown project' });

    // column prompts = the .claude/commands/*.md files. Full token only (editing repo files).
    if (url.pathname === '/api/commands' && req.method === 'GET') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const cfg = loadConfig(project.path);
      const list = [];
      for (const [col, s] of Object.entries(cfg.stages || {})) {
        list.push({ column: col, command: s.command || `todomd-${col.toLowerCase()}`, model: s.model || '' });
      }
      if (cfg.triage) list.push({ column: 'Triage (auto)', command: cfg.triage.command || 'todomd-triage', model: cfg.triage.model || '' });
      list.push({ column: 'Dispatch (budget mode)', command: 'todomd-dispatch', model: '' });
      for (const it of list) it.exists = fs.existsSync(path.join(project.path, '.claude', 'commands', `${it.command}.md`));
      return json(res, 200, { commands: list });
    }
    const cmdMatch = url.pathname.match(/^\/api\/commands\/([\w-]+)$/);
    if (cmdMatch) {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      if (req.method === 'GET') {
        const parts = readCommandParts(project.path, cmdMatch[1]);
        return parts === null ? json(res, 400, { error: 'bad command name' }) : json(res, 200, parts);
      }
      if (req.method === 'POST') {
        // only the editable region is writable — the locked core is preserved
        let body = '';
        for await (const chunk of req) body += chunk;
        let custom;
        try { ({ custom } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        const result = await writeCommandCustom(project.path, cmdMatch[1], custom);
        return json(res, result.ok ? 200 : 400, result);
      }
    }

    if (url.pathname === '/api/board') {
      const board = loadBoard(project.path, { includeArchived: url.searchParams.get('archived') === '1' });
      return json(res, 200, {
        ...board,
        mode: board.config.mode || 'launcher',
        access: fullAccess ? 'full' : 'viewer',
        runStates: pipeline.getRunStates(project.name),
        banners: pipeline.getBanners(),
        usage: pipeline.usage(project.name),
        skills: listSkills(project.path), // available command/skill names for the picker
      });
    }
    if (url.pathname === '/api/models') { // model suggestions for the chosen vendor (CLI --help + config)
      const agent = (url.searchParams.get('agent') || 'claude').replace(/[^\w-]/g, '');
      return json(res, 200, { agent, models: listModels(agent, loadConfig(project.path)) });
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
    // the streamed events of the card's most recent run, to back-fill the drawer
    const runlogMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/runlog$/);
    if (runlogMatch && req.method === 'GET') {
      const card = readCard(project.path, runlogMatch[1]);
      const agent = card?.data?.agent || 'claude';
      return json(res, 200, { agent, ...readRunLog(project.path, runlogMatch[1]) });
    }
    if (cardMatch && req.method === 'DELETE') {
      if (pipeline.hasLiveRun(project.name, cardMatch[1])) return json(res, 400, { error: 'run in progress — cancel it first' });
      await pipeline.releaseCardResources(project, cardMatch[1]); // free worktree/claim/queue before removing files
      const result = await deleteCard(project.path, cardMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
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
    // answer an agent's pending question → threads the answer into the next build
    const answerMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/answer$/);
    if (answerMatch && req.method === 'POST') {
      if (pipeline.hasLiveRun(project.name, answerMatch[1])) return json(res, 400, { error: 'run in progress — cancel it first' });
      let body = '';
      for await (const chunk of req) body += chunk;
      let answer;
      try { ({ answer } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = await pipeline.answerCard(project, answerMatch[1], answer);
      return json(res, result.ok ? 200 : 400, result);
    }
    const archiveMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/archive$/);
    if (archiveMatch && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let on;
      try { ({ archived: on } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      if (on && pipeline.hasLiveRun(project.name, archiveMatch[1])) return json(res, 400, { error: 'run in progress — cancel it first' });
      if (on) await pipeline.releaseCardResources(project, archiveMatch[1]); // taking it off the board frees its build resources
      const result = await setArchived(project.path, archiveMatch[1], !!on);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/resume-queues' && req.method === 'POST') {
      // resume only the board the user clicked, not every paused project
      pipeline.resumeQueues([project]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  // request + upgrade handlers are shared by the loopback listener and the
  // optional LAN listener, so enabling LAN at runtime needs no rebind.
  const requestHandler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!hostOk(req)) { res.writeHead(403); return res.end('bad host'); }
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
  };
  const wss = new WebSocketServer({ noServer: true });
  const upgradeHandler = (req, socket, head) => {
    if (!hostOk(req) || !originOk(req) || !viewerAuthed(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const server = http.createServer(requestHandler);
  server.on('upgrade', upgradeHandler);

  // Toggle a second listener bound to the LAN ip (port stays free on loopback
  // because the two listeners bind distinct addresses). Never touches the main
  // loopback listener, so the localhost-only default is preserved when off.
  function setLan(on) {
    if (on && !lanServer) {
      const ip = lanAddress();
      if (!ip) return { ok: false, error: 'no LAN connection found' };
      lanServer = http.createServer(requestHandler);
      lanServer.on('upgrade', upgradeHandler);
      lanServer.on('error', () => { lanServer = null; lanEnabled = false; });
      lanEnabled = true; // hostOk must allow the LAN host before the socket accepts
      lanServer.listen(port, ip);
    } else if (!on && lanServer) {
      try { lanServer.close(); lanServer.closeAllConnections?.(); } catch {}
      lanServer = null; lanEnabled = false;
    }
    return { ok: true, enabled: lanEnabled, url: lanUrl() };
  }
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
  const stopIntake = startIntake({
    getProject: (name) => listProjects().find((p) => p.name === name),
    onCard: (project, id) => pipeline.maybeTriage(project, id).catch(() => {}),
    log: (m) => console.log(m),
  });

  // Clean shutdown: stop both listeners, file watchers, and intake.
  const close = () => {
    try { server.close(); server.closeAllConnections?.(); } catch {}
    setLan(false);
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    try { stopIntake(); } catch {}
  };

  return new Promise((resolve) => {
    // main listener is ALWAYS loopback-only; LAN is a separate, toggleable listener
    server.listen(port, '127.0.0.1', () => {
      if (lan) setLan(true); // honor the --lan start flag
      resolve({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        lanUrl: lanUrl(),
        port, token, server, close,
      });
    });
  });
}
