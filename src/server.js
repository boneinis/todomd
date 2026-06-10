import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';
import { listProjects } from './registry.js';
import { loadBoard, readCard, createCard } from './board.js';
import * as pipeline from './pipeline.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

export function startServer({ port = 7337 } = {}) {
  const token = crypto.randomBytes(16).toString('hex');

  const authed = (req) => {
    const url = new URL(req.url, 'http://x');
    return url.searchParams.get('token') === token || req.headers['x-todomd-token'] === token;
  };

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const findProject = (name) => listProjects().find((p) => p.name === name);

  async function handleApi(req, res, url) {
    if (!authed(req)) return json(res, 401, { error: 'bad token' });

    if (url.pathname === '/api/projects') {
      return json(res, 200, { projects: listProjects().map((p) => p.name) });
    }
    const project = findProject(url.searchParams.get('project') || '');
    if (!project) return json(res, 404, { error: 'unknown project' });

    if (url.pathname === '/api/board') {
      return json(res, 200, {
        ...loadBoard(project.path),
        runStates: pipeline.getRunStates(project.name),
        banners: pipeline.getBanners(),
        usage: pipeline.usage(),
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
      return json(res, result.ok ? 200 : 400, result);
    }
    const cardMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)$/);
    if (cardMatch && req.method === 'GET') {
      const card = readCard(project.path, cardMatch[1]);
      return card ? json(res, 200, card) : json(res, 404, { error: 'card not found' });
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
    const cancelMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const result = await pipeline.cancel(project, cancelMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/resume-queues' && req.method === 'POST') {
      pipeline.resumeQueues(listProjects());
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
    if (!authed(req)) return socket.destroy();
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
      const w = chokidar.watch(dir, { ignoreInitial: true });
      w.on('error', () => {});
      w.on('all', () => {
        clearTimeout(timer);
        timer = setTimeout(() => broadcast({ type: 'board-changed', project: name }), 150);
      });
      watchers.set(dir, w);
    }
  };
  watchProjects();
  setInterval(watchProjects, 10_000).unref();

  pipeline.init({ broadcast });
  pipeline.reconcileOnBoot().catch(() => {});

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}/?token=${token}`, port, token, server });
    });
  });
}
