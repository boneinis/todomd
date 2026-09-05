import { createBoardAgent } from './board-agent.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { listProjects, addProject, removeProject } from './registry.js';
import { loadBoard, readCard, cardParseFailure, createCard, patchFrontmatter, attachCard, readCommandParts, writeCommandCustom, loadConfig, deleteCard, listSkills, readRunLog, setStageRouting, readLocalPrompt, writeLocalPrompt } from './board.js';
import { listModels, SUPPORTED_VENDORS, validateModelRoute } from './models.js';
import { initProject } from './templates.js';
import { isGitRepo } from './git.js';
import { createMetadataScheduler } from './github-sync.js';
import { buildVoiceSummary, buildCardStatus, prepareVoiceAction, confirmVoiceAction, rejectVoiceAction, invalidateProject as invalidateVoiceProject } from './voice.js';
import { createRealtimeSession } from './realtime.js';
import { sanitizeAssignee, resolveAttachmentFile } from './api-shared.js';

const FILE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv', '.json': 'application/json',
};
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.pdf', '.txt', '.md']);

// JSON API bodies are tiny (the attachment endpoint has its own 25 MB cap) —
// cap everything else so a client can't exhaust memory with an unbounded body.
const MAX_BODY = 1024 * 1024; // 1 MB
// Bound concurrent attachment uploads (each buffers its body in memory, up to
// the 25 MB per-request cap) — beyond the cap the extra upload gets a 429.
const MAX_UPLOADS = 4;
let uploadsInFlight = 0;
// Returns the body bytes, or null when it exceeds MAX_BODY (caller sends 413).
// Keep this byte-safe: message/rfc822 bodies may contain binary MIME parts.
async function readBodyBuffer(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

// JSON/form callers consume text; the raw-email route calls readBodyBuffer.
async function readBody(req) {
  const body = await readBodyBuffer(req);
  return body === null ? null : body.toString('utf8');
}

// Real card ids come from createCard: task-0001 (zero-padded, growing past 4
// digits). Enforced at the route layer — before any filesystem use — so `..`
// or other junk in a card route is a clean 400, not a filename-lookup accident.
const CARD_ID = /^task-\d{1,6}(-[\w-]*)?$/;
import * as pipeline from './pipeline.js';
import { startIntake, restartIntake, publicIntake, saveBoardIntake, testIntake, intakeMessage, parseInboundMessage } from './intake.js';
import { readIntakeAudit } from './screen.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// Tokens persisted per machine so restarts don't invalidate open tabs.
// `token` = full access; `viewer` = read-only (the QR/mobile monitor link).
export function loadToken(name) {
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

// File types whose OS handler would *execute* rather than just display them —
// refused by /api/open so a card's text can't turn a click into code execution.
const NO_OPEN_EXT = new Set([
  '.command', '.app', '.scpt', '.applescript', '.osascript', '.workflow', '.terminal',
  '.action', '.prefpane', '.webloc', '.inetloc', '.url', '.desktop',
  '.bat', '.cmd', '.ps1', '.exe', '.msi', '.com', '.scr', '.vbs', '.jar', '.pkg', '.dmg',
]);

// Open a repo-relative file with the OS default handler. Strictly confined to
// the repo (realpath both sides so a symlink can't escape), regular files only,
// and execution-capable types are refused. Returns {ok} or {ok:false,error}.
function openInRepo(repoPath, rel) {
  rel = String(rel || '').replace(/^[/\\]+/, '');
  if (!rel || rel.includes('\0')) return { ok: false, error: 'bad path' };
  const abs = path.resolve(repoPath, rel);
  let realRoot, real;
  try { realRoot = fs.realpathSync(repoPath); } catch { return { ok: false, error: 'repo not found' }; }
  try { real = fs.realpathSync(abs); } catch { return { ok: false, error: `no such file: ${rel}` }; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, error: 'outside the repo' };
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, error: `no such file: ${rel}` }; }
  if (!st.isFile()) return { ok: false, error: 'not a file' };
  if (NO_OPEN_EXT.has(path.extname(real).toLowerCase())) return { ok: false, error: `won't open an executable file type` };
  // TODOMD_OPENER overrides the OS default opener (a power-user escape hatch; the
  // tests point it at a harmless command so they don't actually launch apps)
  const [cmd, args] = process.env.TODOMD_OPENER ? [process.env.TODOMD_OPENER, [real]]
    : process.platform === 'darwin' ? ['open', [real]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', real]]
    : ['xdg-open', [real]];
  try {
    const child = execFile(cmd, args, { windowsHide: true }, () => {});
    child.on('error', () => {}); // detached; failures (no opener) are non-fatal
    child.unref?.();
  } catch (e) { return { ok: false, error: `couldn't open: ${e.message}` }; }
  return { ok: true, path: rel };
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

  const boardAgent = createBoardAgent();

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

    if (url.pathname === '/api/board-agent' || url.pathname.startsWith('/api/board-agent/')) {
      if (!primary(req)) return json(res, 403, { ok: false, error: 'Board Agent requires the primary desktop token' });
      const route = url.pathname.slice('/api/board-agent'.length);
      if (req.method === 'GET' && route === '') return json(res, 200, boardAgent.publicState());
      if (req.method === 'GET' && route === '/context') return json(res, 200, boardAgent.context());
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      const raw = await readBody(req);
      if (raw === null) return json(res, 413, { ok: false, error: 'body too large' });
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'expected an object' });
      let result;
      if (route === '/config') result = boardAgent.configure(body);
      else if (route === '/message') result = await boardAgent.message(body.text);
      else if (route === '/actions') result = await boardAgent.external(body);
      else if (route === '/reply') result = boardAgent.reply(body);
      else if (route === '/stop') result = boardAgent.stop();
      else if (route.startsWith('/proposals/') && typeof body.accept === 'boolean') result = await boardAgent.decide(route.slice('/proposals/'.length), body.accept);
      else return json(res, 400, { ok: false, error: 'unknown action or invalid approval' });
      return json(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') return json(res, 200, { projects: listProjects().map((p) => p.name) });
      if (req.method === 'POST') {
        // add a repo: validate it's a git repo, scaffold the board, register it
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
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
      const removedPath = findProject(name)?.path;
      removeProject(name);            // unregister; board files untouched
      pipeline.forgetProject(name);   // drop in-memory queue/quota state for the name
      // a freed name can be claimed by an unrelated repo later — any pending
      // voice proposal for this path must not carry over to whatever reuses it
      if (removedPath) invalidateVoiceProject(removedPath);
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
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
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
          assignee: sanitizeAssignee(f.assignee) || undefined,
        });
        restartIntake();               // pick up the change without a server restart
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/intake/test' && req.method === 'POST') {
        const r = await testIntake(name);
        return json(res, r.ok ? 200 : 400, r);
      }
    }
    // Push a raw email into the board — a webhook/automation counterpart to
    // IMAP polling. Screened through the exact same screenEmail/intakeMessage
    // path pollSource uses, so a pushed message gets identical work/spam/unclear
    // handling and audit logging (no card, or a Needs Human hold, for the same
    // reasons a polled message would get one).
    const emailPushMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/email$/);
    if (emailPushMatch && req.method === 'POST') {
      let pname;
      try { pname = decodeURIComponent(emailPushMatch[1]); } catch { return json(res, 400, { error: 'bad project name' }); }
      const proj = findProject(pname);
      if (!proj) return json(res, 404, { error: 'unknown project' });
      const body = await readBodyBuffer(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      if (!body.length) return json(res, 400, { error: 'empty body — send the raw email source (RFC 5322 / message/rfc822)' });
      let parsed;
      try { parsed = await parseInboundMessage(body); } catch (e) { return json(res, 400, { error: `couldn't parse email: ${e.message}` }); }
      // dedup key mirrors mailboxIntakeKey's shape but scoped to this project +
      // route instead of a mailbox account; messages with no Message-ID skip
      // dedup entirely rather than risk colliding on an empty key
      const intakeKey = parsed.messageId ? JSON.stringify(['push', proj.name, parsed.messageId]) : '';
      const outcome = await intakeMessage(proj, parsed, { label: 'push', intakeKey });
      if (outcome.error) return json(res, 400, { error: outcome.error });
      if (outcome.verdict === 'work' && (outcome.created || outcome.recovered)) {
        pipeline.maybeTriage(proj, outcome.id).catch(() => {}); // only real work is auto-triaged
      }
      return json(res, 200, {
        ok: true, verdict: outcome.verdict, reason: outcome.reason || '', duplicate: !!outcome.duplicate,
        ...(outcome.id ? { id: outcome.id } : {}),
      });
    }
    // Recent screened-out/held email, newest first — backs the Screened email
    // list in the intake settings panel. Full token only, same as /api/intake:
    // sender/subject/reason are meaningful content, not just connection status.
    const auditMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/intake-audit$/);
    if (auditMatch && req.method === 'GET') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      let pname;
      try { pname = decodeURIComponent(auditMatch[1]); } catch { return json(res, 400, { error: 'bad project name' }); }
      const proj = findProject(pname);
      if (!proj) return json(res, 404, { error: 'unknown project' });
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      return json(res, 200, { records: readIntakeAudit(proj.path, limit) });
    }
    // LAN access state + runtime toggle. Enabling exposes the board to the
    // network, so the toggle needs the PRIMARY desktop token (not mobile).
    if (url.pathname === '/api/lan') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      if (req.method === 'GET') return json(res, 200, { enabled: lanEnabled, canToggle: primary(req), ip: lanAddress() });
      if (req.method === 'POST') {
        if (!primary(req)) return json(res, 403, { error: 'enable LAN from the computer running todomd' });
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
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
      // stage columns carry per-column agent/model routing (the "column" tier);
      // triage/dispatch don't, so they're flagged stage:false to hide selectors
      for (const [col, s] of Object.entries(cfg.stages || {})) {
        list.push({ column: col, command: s.command || `todomd-${col.toLowerCase()}`, model: s.model || '', effort: s.effort || '', workflow: s.workflow || '', agent: s.agent || '', stage: true });
      }
      if (cfg.triage) list.push({ column: 'Triage (auto)', command: cfg.triage.command || 'todomd-triage', model: cfg.triage.model || '', stage: false });
      list.push({ column: 'Dispatch (budget mode)', command: 'todomd-dispatch', model: '', stage: false });
      for (const it of list) it.exists = fs.existsSync(path.join(project.path, '.claude', 'commands', `${it.command}.md`));
      return json(res, 200, { commands: list, defaultAgent: cfg.default_agent || 'claude', defaultModel: cfg.default_model || '', defaultEffort: cfg.default_effort || '' });
    }
    const cmdMatch = url.pathname.match(/^\/api\/commands\/([\w-]+)$/);
    if (cmdMatch) {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      if (req.method === 'GET') {
        const parts = readCommandParts(project.path, cmdMatch[1]);
        if (parts === null) return json(res, 400, { error: 'bad command name' });
        // `local` is the gitignored layer — returned alongside so the editor can
        // show both, and so it's obvious which half leaves this machine
        return json(res, 200, { ...parts, local: readLocalPrompt(project.path, cmdMatch[1]) || '' });
      }
      if (req.method === 'POST') {
        // Two independent halves: `custom` is the committed shared region (the
        // locked core is preserved), `local` is written to .todomd/local/ and
        // never committed. A request may carry either or both.
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
        let custom, local;
        try { ({ custom, local } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        let result = { ok: true };
        if (local !== undefined) result = await writeLocalPrompt(project.path, cmdMatch[1], local);
        if (result.ok && custom !== undefined) {
          result = { ...(await writeCommandCustom(project.path, cmdMatch[1], custom)), ...(local !== undefined ? { local: true } : {}) };
        }
        return json(res, result.ok ? 200 : 400, result);
      }
    }

    // per-column agent/model routing (the "column" tier). Full token only.
    if (url.pathname === '/api/stages' && req.method === 'POST') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let fields;
      try { fields = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const col = String(fields.column || '');
      const cfg = loadConfig(project.path);
      if (!(cfg.stages || {})[col]) return json(res, 400, { error: `unknown stage column: ${col}` });
      const updates = {};
      if ('agent' in fields) {
        const agent = pipeline.normalizeVendor(fields.agent);
        if (fields.agent && !SUPPORTED_VENDORS.includes(agent)) return json(res, 400, { error: `agent must be ${SUPPORTED_VENDORS.join(', ')}` });
        updates.agent = fields.agent ? agent : '';
        if (!('model' in fields)) updates.model = '';
      }
      if ('model' in fields) updates.model = String(fields.model || '');
      if ('effort' in fields) updates.effort = String(fields.effort || '');
      if ('workflow' in fields) {
        if (col !== 'Build') return json(res, 400, { error: 'workflow presets are available only for Build' });
        updates.workflow = String(fields.workflow || '');
      }
      const effectiveAgent = updates.agent || (cfg.stages || {})[col]?.agent || cfg.default_agent || 'claude';
      const effectiveModel = 'model' in updates ? updates.model : (cfg.stages || {})[col]?.model || cfg.default_model || '';
      const route = validateModelRoute(effectiveAgent, effectiveModel, cfg);
      if (!route.ok) return json(res, 400, { error: route.error });
      const result = await setStageRouting(project.path, col, updates);
      return json(res, result.ok ? 200 : 400, result);
    }
    // open a repo file the card references, with the OS default app. Full token
    // only (it runs the OS opener on the host) and same-origin (enforced above).
    if (url.pathname === '/api/open' && req.method === 'POST') {
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let p;
      try { ({ path: p } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = openInRepo(project.path, p);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/board') {
      const board = loadBoard(project.path, { includeArchived: url.searchParams.get('archived') === '1' });
      return json(res, 200, {
        ...board,
        mode: board.config.mode || 'launcher',
        access: fullAccess ? 'full' : 'viewer',
        // `access: full` includes the revocable mobile-control token. Voice
        // remains desktop-only, so expose the narrower tier separately and
        // let the client hide controls that its token cannot actually use.
        primary: primary(req),
        runStates: pipeline.getRunStates(project.name, {
          includeProgress: true,
          // Activity can include an agent message or command. The full desktop
          // token can already read the raw run log; monitor links receive only
          // safe timing/checkpoint metadata.
          includeDetails: fullAccess,
        }),
        banners: pipeline.getBanners(),
        usage: pipeline.usage(project),
        skills: listSkills(project.path), // available command/skill names for the picker
      });
    }
    // Voice Actions API (docs/voice.md): the speech model may only read and
    // propose; TODOMD prepares, reads back, and — once a human confirms at the
    // right tier — executes. Summary/card-status are read-only, so any viewer
    // may ask; prepare/confirm/reject mutate (or gate a mutation) and need the
    // PRIMARY desktop session specifically, like /api/voice/session — voice is
    // a desktop-only feature this release, and a mobile link must not gain a
    // spoken path to board mutation its own UI doesn't expose.
    if (url.pathname === '/api/voice/summary' && req.method === 'GET') {
      return json(res, 200, buildVoiceSummary(project));
    }
    const voiceCardMatch = url.pathname.match(/^\/api\/voice\/cards\/([\w.-]+)$/);
    if (voiceCardMatch && req.method === 'GET') {
      const cardStatus = await buildCardStatus(project, voiceCardMatch[1]);
      if (!cardStatus) return json(res, 404, { error: 'card not found' });
      return json(res, 200, cardStatus);
    }
    if (url.pathname === '/api/voice/actions' && req.method === 'POST') {
      if (!primary(req)) return json(res, 403, { error: 'voice actions require the primary desktop session' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let fields;
      try { fields = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const { status, ...result } = await prepareVoiceAction(project, fields);
      return json(res, status, result);
    }
    const voiceConfirmMatch = url.pathname.match(/^\/api\/voice\/actions\/([\w-]+)\/confirm$/);
    if (voiceConfirmMatch && req.method === 'POST') {
      if (!primary(req)) return json(res, 403, { error: 'voice actions require the primary desktop session' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let fields;
      try { fields = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const { status, ...result } = await confirmVoiceAction(project, voiceConfirmMatch[1], fields);
      return json(res, status, result);
    }
    const voiceRejectMatch = url.pathname.match(/^\/api\/voice\/actions\/([\w-]+)\/reject$/);
    if (voiceRejectMatch && req.method === 'POST') {
      if (!primary(req)) return json(res, 403, { error: 'voice actions require the primary desktop session' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let fields = {};
      try { if (body) fields = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const { status, ...result } = await rejectVoiceAction(project, voiceRejectMatch[1], fields);
      return json(res, status, result);
    }
    // Post-wake Realtime SDP exchange (docs/voice.md, docs/security.md § Voice
    // control). Sits after the generic non-GET write guard above — a viewer
    // token is already rejected there, and a mobile token is rejected by this
    // route's own primary(req) check, same shape as /api/lan. The standard
    // OPENAI_API_KEY lives only in createRealtimeSession and never reaches
    // this response.
    if (url.pathname === '/api/voice/session' && req.method === 'POST') {
      if (!primary(req)) return json(res, 403, { error: 'voice actions require the primary desktop session' });
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/sdp') return json(res, 400, { error: 'content-type must be application/sdp' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      const ac = new AbortController();
      let responded = false;
      res.on('close', () => { if (!responded) ac.abort(); });
      const result = await createRealtimeSession(body, { signal: ac.signal });
      responded = true;
      if (!result.ok) return json(res, result.status, { error: result.error });
      res.writeHead(200, { 'content-type': 'application/sdp' });
      return res.end(result.sdp);
    }
    if (url.pathname === '/api/models') { // model suggestions for the chosen vendor (CLI --help + config)
      // full token only: this spawns blocking CLI --help processes
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const agent = (url.searchParams.get('agent') || 'claude').replace(/[^\w-]/g, '');
      if (!SUPPORTED_VENDORS.includes(agent)) return json(res, 400, { error: `agent must be ${SUPPORTED_VENDORS.join(', ')}` });
      return json(res, 200, { agent, models: listModels(agent, loadConfig(project.path)) });
    }
    if (url.pathname === '/api/cards' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
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
      const resolved = resolveAttachmentFile(project.path, rel);
      if (!resolved.ok) return json(res, 404, { error: resolved.error });
      const { real, ext } = resolved;
      res.writeHead(200, {
        'content-type': FILE_MIME[ext] || 'application/octet-stream',
        'content-disposition': `${INLINE_EXT.has(ext) ? 'inline' : 'attachment'}; filename="${path.basename(real).replace(/"/g, '')}"`,
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'x-content-type-options': 'nosniff',
      });
      return res.end(fs.readFileSync(real));
    }
    // Validate the card id BEFORE any card route touches the filesystem — a
    // non-conforming id (e.g. `..`) is a clean 400 here, not a 404 that happens
    // to fall out of board.js's filename lookup.
    const cardIdInPath = url.pathname.match(/^\/api\/cards\/([^/]+)/);
    if (cardIdInPath) {
      let cid = cardIdInPath[1];
      try { cid = decodeURIComponent(cid); } catch { return json(res, 400, { error: 'invalid card id' }); }
      if (!CARD_ID.test(cid)) return json(res, 400, { error: 'invalid card id' });
      if (req.method === 'POST' && !url.pathname.endsWith('/cancel')) {
        const invalid = cardParseFailure(readCard(project.path, cid));
        if (invalid) return json(res, 400, invalid);
      }
    }
    const cardMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)$/);
    if (cardMatch && req.method === 'GET') {
      const card = readCard(project.path, cardMatch[1]);
      if (!card) return json(res, 404, { error: 'card not found' });
      const summary = loadBoard(project.path, { includeArchived: true }).cards.find((c) => c.file === card.file);
      return json(res, 200, { ...card, dependencyIssues: summary?.dependencyIssues,
        recovery: card.parseError ? {} : await pipeline.recoveryActions(project, cardMatch[1]) });
    }
    // the streamed events of the card's most recent run, to back-fill the drawer
    const runlogMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/runlog$/);
    if (runlogMatch && req.method === 'GET') {
      // full access only — the raw run stream can carry command output/secrets.
      // 403, not 401: a viewer IS authenticated, just not permitted. The UI
      // turns any 401 into "session expired — restart todomd", so a 401 here
      // told every viewer on the default QR link to restart the server each
      // time they opened a card drawer.
      if (!fullAccess) return json(res, 403, { error: 'full access required' });
      const card = readCard(project.path, runlogMatch[1]);
      const agent = card?.data?.agent || 'claude';
      return json(res, 200, { agent, ...readRunLog(project.path, runlogMatch[1]) });
    }
    if (cardMatch && req.method === 'DELETE') {
      if (pipeline.hasLiveRun(project.name, cardMatch[1])) return json(res, 400, { error: 'run in progress — cancel it first' });
      const delCard = readCard(project.path, cardMatch[1]);
      if (delCard?.data?.epic && pipeline.hasLiveBuildingChild(project, cardMatch[1])) return json(res, 400, { error: 'a child card is building — cancel it first' });
      await pipeline.releaseCardResources(project, cardMatch[1]); // free worktree/claim/queue before removing files
      if (delCard?.data?.epic) await pipeline.cascadeEpicCleanup(project, cardMatch[1]);
      const result = await deleteCard(project.path, cardMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
    }
    const attachMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/attach$/);
    if (attachMatch && req.method === 'POST') {
      if (uploadsInFlight >= MAX_UPLOADS) return json(res, 429, { error: 'too many concurrent uploads' });
      uploadsInFlight++;
      try {
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
      } finally { uploadsInFlight--; }
    }
    const moveMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/move$/);
    if (moveMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let status;
      let instruction = '';
      try {
        ({ status, instruction = '' } = JSON.parse(body || '{}'));
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      // every API move is a human move: the §3.1 table is enforced here
      const result = await pipeline.humanMove(project, moveMatch[1], status, { instruction });
      return json(res, result.ok ? 200 : 400, result);
    }
    const reorderMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/reorder$/);
    if (reorderMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let beforeId = null;
      try {
        ({ beforeId = null } = JSON.parse(body || '{}'));
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      if (beforeId !== null && (typeof beforeId !== 'string' || !/^[\w.-]+$/.test(beforeId))) {
        return json(res, 400, { error: 'beforeId must be a card id or null' });
      }
      const result = await pipeline.reorder(project, reorderMatch[1], beforeId);
      return json(res, result.ok ? 200 : 400, result);
    }
    // human-owned routing fields, editable from the drawer
    const setMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/set$/);
    if (setMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let fields;
      try {
        fields = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      await pipeline.waitForTriage(project.name, setMatch[1]);
      if (pipeline.hasLiveRun(project.name, setMatch[1])) {
        return json(res, 400, { error: 'run in progress — cancel it first' });
      }
      const current = readCard(project.path, setMatch[1]);
      const updates = {};
      if ('agent' in fields) {
        const agent = pipeline.normalizeVendor(fields.agent);
        if (!SUPPORTED_VENDORS.includes(agent)) return json(res, 400, { error: `agent must be ${SUPPORTED_VENDORS.join(', ')}` });
        updates.agent = agent;
        if (!('model' in fields)) updates.model = '';
      }
      if ('model' in fields) updates.model = String(fields.model || '').replace(/[^\w.-]/g, '');
      if ('effort' in fields) updates.effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(fields.effort || '')) ? fields.effort : '';
      if ('workflow' in fields) updates.workflow = fields.workflow === 'ultra_code' ? 'ultra_code' : '';
      if ('build_profile' in fields) {
        const profile = String(fields.build_profile || '');
        if (!['standard', 'long', 'split_required'].includes(profile)) {
          return json(res, 400, { error: 'build_profile must be standard, long, or split_required' });
        }
        updates.build_profile = profile;
        // Re-resolve and freeze limits on the next Build admission. This is
        // what lets a preserved budget pause be deliberately resumed as long.
        if (current?.data?.build_profile !== profile) updates.build_limits = {};
      }
      if ('skill' in fields) updates.skill = String(fields.skill || '').replace(/[^\w:-]/g, '');
      if ('assignee' in fields) updates.assignee = sanitizeAssignee(fields.assignee);
      if (!Object.keys(updates).length) return json(res, 400, { error: 'nothing to set' });
      const effectiveAgent = updates.agent || current?.data?.agent || loadConfig(project.path).default_agent || 'claude';
      const effectiveModel = 'model' in updates ? updates.model : current?.data?.model || '';
      const route = validateModelRoute(effectiveAgent, effectiveModel, loadConfig(project.path));
      if (!route.ok) return json(res, 400, { error: route.error });
      const result = await patchFrontmatter(project.path, setMatch[1], updates);
      return json(res, result.ok ? 200 : 400, result);
    }
    const cancelMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const result = await pipeline.cancel(project, cancelMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
    }
    const summariesMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/summaries$/);
    if (summariesMatch && req.method === 'POST') {
      const result = await pipeline.summarizeCard(project, summariesMatch[1]);
      return json(res, result.ok ? 200 : 400, result);
    }
    const recoveryReviewMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/recover$/);
    if (recoveryReviewMatch && req.method === 'POST') {
      const result = await pipeline.reviewAndProcessRecovery(project, recoveryReviewMatch[1]);
      return json(res, result.ok ? 202 : 400, result);
    }
    const promptMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/prompt$/);
    if (promptMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let prompt;
      try { ({ prompt } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = await pipeline.promptCard(project, promptMatch[1], prompt);
      return json(res, result.ok ? 202 : 400, result);
    }
    const instructionMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/instruction$/);
    if (instructionMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let instruction;
      try { ({ instruction } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      if (pipeline.hasLiveRun(project.name, instructionMatch[1])) {
        return json(res, 400, { error: 'run in progress — save instructions after it finishes' });
      }
      const result = pipeline.setCardInstruction(project, instructionMatch[1], instruction);
      return json(res, result.ok ? 200 : 400, result);
    }
    const returnBuildMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/return-build$/);
    if (returnBuildMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let instruction = '';
      try { ({ instruction = '' } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = await pipeline.returnToBuild(project, returnBuildMatch[1], instruction);
      return json(res, result.ok ? 202 : 400, result);
    }
    const retryVerifyMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/retry-verify$/);
    if (retryVerifyMatch && req.method === 'POST') {
      const result = await pipeline.retryVerification(project, retryVerifyMatch[1]);
      return json(res, result.ok ? 202 : 400, result);
    }
    const resumeBuildMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/resume-build$/);
    if (resumeBuildMatch && req.method === 'POST') {
      const result = await pipeline.resumeBuild(project, resumeBuildMatch[1]);
      return json(res, result.ok ? 202 : 400, result);
    }
    const restartBuildMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/restart-build$/);
    if (restartBuildMatch && req.method === 'POST') {
      const result = await pipeline.restartBuild(project, restartBuildMatch[1]);
      return json(res, result.ok ? 202 : 400, result);
    }
    // answer an agent's pending question → threads the answer into the next build
    const answerMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/answer$/);
    if (answerMatch && req.method === 'POST') {
      if (pipeline.hasLiveRun(project.name, answerMatch[1])) return json(res, 400, { error: 'run in progress — cancel it first' });
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let answer;
      try { ({ answer } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = await pipeline.answerCard(project, answerMatch[1], answer);
      return json(res, result.ok ? 200 : 400, result);
    }
    const archiveMatch = url.pathname.match(/^\/api\/cards\/([\w.-]+)\/archive$/);
    if (archiveMatch && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return json(res, 413, { error: 'body too large (1 MB max)' });
      let on;
      try { ({ archived: on } = JSON.parse(body || '{}')); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const result = await pipeline.archiveCard(project, archiveMatch[1], !!on);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/resume-queues' && req.method === 'POST') {
      // resume only the board the user clicked, not every paused project
      pipeline.resumeQueues([project]);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/queue/pause' && req.method === 'POST') {
      return json(res, 200, pipeline.pauseQueue(project));
    }
    if (url.pathname === '/api/queue/resume' && req.method === 'POST') {
      return json(res, 200, pipeline.resumeQueue(project));
    }
    if (url.pathname === '/api/queue/kick' && req.method === 'POST') {
      const result = await pipeline.kickQueue(project);
      return json(res, result.ok ? 200 : 400, result);
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
  // isLan tags sockets that arrived via the LAN listener — setLan(false) drops
  // them explicitly (closeAllConnections() doesn't see upgraded WS sockets)
  const upgradeHandler = (isLan) => (req, socket, head) => {
    if (!hostOk(req) || !originOk(req) || !viewerAuthed(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => { ws.todomdLan = isLan; wss.emit('connection', ws, req); });
  };

  const server = http.createServer(requestHandler);
  server.on('upgrade', upgradeHandler(false));

  // Toggle a second listener bound to the LAN ip (port stays free on loopback
  // because the two listeners bind distinct addresses). Never touches the main
  // loopback listener, so the localhost-only default is preserved when off.
  function setLan(on) {
    if (on && !lanServer) {
      const ip = lanAddress();
      if (!ip) return { ok: false, error: 'no LAN connection found' };
      lanServer = http.createServer(requestHandler);
      lanServer.on('upgrade', upgradeHandler(true));
      lanServer.on('error', () => { lanServer = null; lanEnabled = false; });
      lanEnabled = true; // hostOk must allow the LAN host before the socket accepts
      lanServer.listen(port, ip);
    } else if (!on && lanServer) {
      try { lanServer.close(); lanServer.closeAllConnections?.(); } catch {}
      for (const ws of wss.clients) if (ws.todomdLan) ws.terminate(); // upgraded WS sockets outlive closeAllConnections
      lanServer = null; lanEnabled = false;
    }
    return { ok: true, enabled: lanEnabled, url: lanUrl() };
  }
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.todomdAccess = authed(req) ? 'full' : 'viewer'; // the run-event stream is full-only
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  pingTimer.unref();

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      // the raw run-event stream can carry command output — full access only;
      // viewers still get board-changed / run-state / banners
      if (msg.type === 'run-event' && client.todomdAccess !== 'full') continue;
      if (client.readyState === 1) client.send(data);
    }
  };

  // watch every registered project's tasks dir; reconcile with the registry
  // so removed projects release their watchers (chokidar v4: plain paths only)
  const watchers = new Map();
  const metadataSync = createMetadataScheduler({
    onResult: (project, result) => console.log(`metadata sync ${project.name}: ${result.ok ? (result.skipped || 'pushed') : result.error}`),
  });
  let closed = false;
  const watchProjects = () => {
    if (closed) return; // a rescan after close() would re-open watchers we just released
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
      const w = chokidar.watch([dir, path.join(project.path, '.todomd', 'config.yml')], { ignoreInitial: true });
      w.on('error', () => {});
      w.on('all', (_event, changedPath) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (closed || !watchers.has(dir)) return;
          broadcast({ type: 'board-changed', project: name });
          boardAgent.changed(name);
          // File edits under the board lock approve Queue work just like the
          // move API. Reuse project-scoped admission, including pause/budget gates.
          if (project) pipeline.kickQueue(project).catch(() => {});
          if (project) pipeline.triageSweep(project); // annotate externally-arrived cards
          if (project) {
            const match = path.basename(changedPath || '').match(/^(task-\d+)/);
            const card = match ? readCard(project.path, match[1]) : null;
            metadataSync.schedule(project, { done: card?.data?.status === 'Done' });
          }
        }, 1500);
      });
      watchers.set(dir, w);
    }
  };
  watchProjects();
  const watchTimer = setInterval(watchProjects, 10_000);
  watchTimer.unref();

  pipeline.init({ broadcast });
  pipeline.reconcileOnBoot().catch(() => {});

  // IMAP email intake: poll configured mailboxes → cards in Review → triage
  const stopIntake = startIntake({
    getProject: (name) => listProjects().find((p) => p.name === name),
    onCard: (project, id) => pipeline.maybeTriage(project, id).catch(() => {}),
    log: (m) => console.log(m),
  });

  // Clean shutdown: stop both listeners, every open WebSocket, the rescan/ping
  // timers, file watchers, and intake. Everything here holds an event-loop
  // handle — leaving any of it behind keeps the process alive after close()
  // (and the 10s rescan would re-open the watchers we just released).
  const close = () => {
    closed = true;
    boardAgent.close();
    clearInterval(watchTimer);
    clearInterval(pingTimer);
    try { server.close(); server.closeAllConnections?.(); } catch {}
    setLan(false);
    // upgraded WS sockets survive closeAllConnections — drop them explicitly
    for (const ws of wss.clients) { try { ws.terminate(); } catch {} }
    try { wss.close(); } catch {}
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
    metadataSync.close();
    try { stopIntake(); } catch {}
  };

  return new Promise((resolve) => {
    // a port conflict on the MAIN listener is fatal — say why and bail (the
    // LAN listener already has its own quiet error handler above)
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') console.error(`port ${port} already in use — is todomd already running? (\`todomd stop\`)`);
      else console.error(`todomd server error: ${e.message}`);
      process.exit(1);
    });
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
