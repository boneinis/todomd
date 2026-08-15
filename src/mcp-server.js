// A thin MCP (Model Context Protocol) server over the existing To-do MD HTTP
// API. Every tool below is an HTTP client of that API — the same routes
// src/server.js already exposes — rather than a second importer of
// board.js/pipeline.js. That matters beyond style: pipeline.js's run/queue
// state (children, runs, triggerClaims, ...) lives in the memory of whichever
// process called pipeline.init() — the one running `todomd serve`. An MCP
// server that imported pipeline.js directly would be a SECOND process with
// its own, permanently-empty copy of that state: get_run_state would never
// see a live run, and hasLiveRun()/waitForTriage() guards would silently
// never trigger, letting a write tool race or conflict with a real run. Going
// through HTTP means every guard, every CARD_ID/project check, and every
// piece of run state is read from the one authoritative process — nothing
// here duplicates that logic, it just calls it.
//
// MCP itself is newline-delimited JSON-RPC 2.0 over stdio — small enough
// that, like the rest of this repo's HTTP/WebSocket layer, it's hand-rolled
// here rather than pulled in as a dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { loadToken } from './server.js';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_MCP_FILE_BYTES = 2 * 1024 * 1024;

const eq = (a, b) => {
  const ba = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// A read tool works for either token tier; a write tool needs the full
// token. The tier decides which tools a session sees *and* is re-checked in
// callTool() before dispatch; server.js's viewerAuthed()/fullAccess checks on
// the HTTP request itself remain the backstop behind both.
export function resolveTier(suppliedToken) {
  const full = loadToken('token');
  const viewer = loadToken('token-viewer');
  if (eq(suppliedToken, full)) return 'full';
  if (eq(suppliedToken, viewer)) return 'viewer';
  return null;
}

// Plugin configs must not contain a raw board token. An explicit access tier
// lets a local MCP process read exactly one protected token file at startup.
// In particular, viewer startup must not call loadToken('token'): loadToken()
// creates a missing file, which would make a supposedly read-only plugin touch
// the full-access credential as a side effect.
export function resolveStartupCredential({ token, access, envToken = process.env.TODOMD_MCP_TOKEN } = {}) {
  if (access !== undefined) {
    if (token !== undefined) throw new Error('choose either --access or --token, not both');
    if (access !== 'viewer' && access !== 'full') {
      throw new Error('--access must be viewer or full');
    }

    // Full MCP control deliberately has its own credential. The primary token
    // opens the desktop UI and may authorize broader API routes; Codex never
    // needs it, and the control credential is additionally lease-gated by the
    // live HTTP server for every mutation.
    const name = access === 'viewer' ? 'token-viewer' : 'token-control';
    const home = process.env.TODOMD_HOME || os.homedir();
    const file = path.join(home, '.todomd', name);
    let resolved;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('wrong owner');
      if ((st.mode & 0o077) !== 0) throw new Error('permissions are too broad');
      resolved = fs.readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`couldn't read ${access} token file at ${file}`);
    }
    if (!/^[a-f0-9]{32}$/.test(resolved)) {
      throw new Error(`invalid ${access} token file at ${file}`);
    }
    return { token: resolved, tier: access };
  }

  const resolved = token || envToken || '';
  const tier = resolveTier(resolved);
  if (!tier) {
    throw new Error('bad or missing token — set TODOMD_MCP_TOKEN (or pass --token) to the value in ~/.todomd/token or ~/.todomd/token-viewer');
  }
  return { token: resolved, tier };
}

// `todomd serve` records "<pid> <port>" in ~/.todomd/server.pid (bin/todomd.js)
// — read it so an MCP client doesn't have to know or pass the port itself.
export function discoverBaseUrl() {
  if (process.env.TODOMD_MCP_URL) return process.env.TODOMD_MCP_URL;
  if (process.env.TODOMD_MCP_PORT) return `http://127.0.0.1:${process.env.TODOMD_MCP_PORT}`;
  const home = process.env.TODOMD_HOME || os.homedir();
  try {
    const [, portStr] = fs.readFileSync(path.join(home, '.todomd', 'server.pid'), 'utf8').trim().split(/\s+/);
    if (Number(portStr)) return `http://127.0.0.1:${Number(portStr)}`;
  } catch { /* no pid file — fall through to the default port */ }
  return 'http://127.0.0.1:7337';
}

// File-sourced plugin credentials must never follow inherited endpoint
// overrides or a blind default port. Verify the live server first using the
// pid file's per-process nonce, then return its loopback URL. No credential is
// sent during this handshake.
export async function discoverVerifiedBaseUrl({ fetchImpl = fetch } = {}) {
  const home = process.env.TODOMD_HOME || os.homedir();
  const file = path.join(home, '.todomd', 'server.pid');
  let pid, port, nonce;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('wrong owner');
    if ((st.mode & 0o077) !== 0) throw new Error('permissions are too broad');
    [pid, port, nonce] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
  } catch {
    throw new Error('couldn\'t verify a running todomd server — start it with `todomd serve --no-open --safe-output`');
  }
  pid = Number(pid); port = Number(port);
  if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{32}$/.test(nonce || '')) {
    throw new Error('invalid todomd server identity file — restart the server');
  }
  try { process.kill(pid, 0); }
  catch { throw new Error('todomd server identity is stale — restart the server'); }

  const baseUrl = `http://127.0.0.1:${port}`;
  const challenge = crypto.randomBytes(32).toString('hex');
  const healthUrl = new URL('/api/health', baseUrl);
  healthUrl.searchParams.set('challenge', challenge);
  let response, body;
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(2000) });
    body = await response.json();
  } catch {
    throw new Error('couldn\'t authenticate the local todomd server — restart it');
  }
  const expectedProof = crypto.createHmac('sha256', nonce).update(challenge).digest('hex');
  if (!response.ok || !eq(body?.proof, expectedProof)) {
    throw new Error('local server identity did not match todomd — refusing to send credentials');
  }
  return baseUrl;
}

async function resolveBaseUrl(ctx) {
  return ctx.strictDiscovery ? discoverVerifiedBaseUrl() : ctx.baseUrl;
}

const enc = encodeURIComponent;

// One JSON call against the live todomd HTTP API.
async function apiCall(ctx, method, pathname, { query = {}, body } = {}) {
  let baseUrl;
  try { baseUrl = await resolveBaseUrl(ctx); }
  catch (e) { return { status: 0, json: { ok: false, error: e.message } }; }
  const url = new URL(pathname, baseUrl);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-todomd-token': ctx.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, json: { ok: false, error: `couldn't reach the todomd server at ${baseUrl} — is \`todomd serve\` running? (${e.message})` } };
  }
  let json;
  try { json = await res.json(); } catch { json = { ok: false, error: `bad response from todomd server (status ${res.status})` }; }
  return { status: res.status, json };
}

// /api/file isn't JSON — it streams the raw attachment bytes with a
// content-type header — so it gets its own thin fetch instead of apiCall().
async function fetchFile(ctx, project, rel) {
  let baseUrl;
  try { baseUrl = await resolveBaseUrl(ctx); }
  catch (e) { return { status: 0, json: { ok: false, error: e.message } }; }
  const url = new URL('/api/file', baseUrl);
  url.searchParams.set('project', project);
  url.searchParams.set('p', rel);
  let res;
  try { res = await fetch(url, { headers: { 'x-todomd-token': ctx.token } }); }
  catch (e) { return { status: 0, json: { ok: false, error: `couldn't reach the todomd server: ${e.message}` } }; }
  if (!res.ok) {
    let json;
    try { json = await res.json(); } catch { json = { ok: false, error: `not found (status ${res.status})` }; }
    return { status: res.status, json };
  }
  const declaredSize = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_MCP_FILE_BYTES) {
    try { await res.body?.cancel(); } catch {}
    return { status: 413, json: { ok: false, error: `attachment exceeds the ${MAX_MCP_FILE_BYTES} byte MCP limit` } };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MCP_FILE_BYTES) {
    return { status: 413, json: { ok: false, error: `attachment exceeds the ${MAX_MCP_FILE_BYTES} byte MCP limit` } };
  }
  return { status: 200, json: { ok: true, path: rel, contentType: res.headers.get('content-type') || '', base64: buf.toString('base64') } };
}

const TOOLS = [
  {
    name: 'list_projects', tier: 'viewer',
    description: 'List registered To-do MD project names.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (ctx) => apiCall(ctx, 'GET', '/api/projects'),
  },
  {
    name: 'get_board', tier: 'viewer',
    description: "Get a project's board (columns, cards, run state, usage, banners).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project name' },
        includeArchived: { type: 'boolean', description: 'Include archived cards', default: false },
      },
      required: ['project'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'GET', '/api/board', { query: { project: args.project, archived: args.includeArchived ? '1' : undefined } }),
  },
  {
    name: 'get_run_state', tier: 'viewer',
    description: 'Get live run state, banners, and usage for a project (diagnostic info).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    call: async (ctx, args) => {
      const { status, json } = await apiCall(ctx, 'GET', '/api/board', { query: { project: args.project } });
      // Transport failures use status 0. Preserve that diagnostic envelope;
      // destructuring it as a successful board response would replace the
      // useful connection error with an opaque empty object.
      if (status === 0 || status >= 400) return { status, json };
      const { runStates, banners, usage } = json;
      return { status, json: { runStates, banners, usage } };
    },
  },
  {
    name: 'get_card', tier: 'viewer',
    description: 'Get a single card by id, including recovery actions.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'GET', `/api/cards/${enc(args.id)}`, { query: { project: args.project } }),
  },
  {
    name: 'get_card_file', tier: 'viewer',
    description: 'Read an attachment file from a card (base64), confined to .todomd/attachments/.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, path: { type: 'string', description: 'Attachment-relative path, as stored on the card' } },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    call: (ctx, args) => fetchFile(ctx, args.project, args.path),
  },
  {
    name: 'list_commands', tier: 'full',
    description: "List a project's pipeline stage commands (agent/model routing). Requires full access.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'GET', '/api/commands', { query: { project: args.project } }),
  },
  {
    name: 'create_card', tier: 'full',
    description: "Create a new card on a project's board.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string' },
        priority: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        criteria: { type: 'array', items: { type: 'string' } },
      },
      required: ['project', 'title'],
      additionalProperties: false,
    },
    // Built from an explicit allowlist rather than `{ project, ...rest }`:
    // POST /api/cards is a trusted-caller route that deliberately honours
    // internal orchestrator fields (status, triaged, parent, plan, agent, ...)
    // for the Plan stage's chunk creator — see board.js createCard(). The
    // schema check in callTool() already rejects those, and this keeps a
    // future schema edit from silently widening what gets forwarded.
    call: (ctx, args) => {
      const body = {};
      for (const k of ['title', 'description', 'type', 'priority', 'labels', 'criteria']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return apiCall(ctx, 'POST', '/api/cards', { query: { project: args.project }, body });
    },
  },
  {
    name: 'move_card', tier: 'full',
    description: 'Move a card to a new status column (a human move).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' } },
      required: ['project', 'id', 'status'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/move`, { query: { project: args.project }, body: { status: args.status } }),
  },
  {
    name: 'assign_card', tier: 'full',
    description: "Set a card's assignee.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, assignee: { type: 'string' } },
      required: ['project', 'id', 'assignee'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/set`, { query: { project: args.project }, body: { assignee: args.assignee } }),
  },
  {
    name: 'retry_verify', tier: 'full',
    description: 'Retry verification for a card that failed Verify.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/retry-verify`, { query: { project: args.project } }),
  },
  {
    name: 'cancel_card', tier: 'full',
    description: "Cancel a card's in-progress run.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/cancel`, { query: { project: args.project } }),
  },
  {
    name: 'archive_card', tier: 'full',
    description: 'Archive or unarchive a card.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, archived: { type: 'boolean' } },
      required: ['project', 'id', 'archived'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/archive`, { query: { project: args.project }, body: { archived: args.archived } }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function listToolsFor(tier) {
  return TOOLS.filter((t) => tier === 'full' || t.tier === 'viewer').map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function toolResult(status, json) {
  const isError = status === 0 || status >= 400 || json?.ok === false;
  return { content: [{ type: 'text', text: JSON.stringify(json) }], isError };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

// Type check for one property, with NO coercion — a string "false" is not a
// boolean here, because `archived: "false"` coerced to true would archive a
// card the caller asked to *un*archive. Only string, boolean and
// array-of-string appear across the schemas above.
function typeError(spec, value) {
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return 'must be an array';
    if (spec.items?.type === 'string' && !value.every((v) => typeof v === 'string')) return 'must be an array of strings';
    return null;
  }
  return typeof value === spec.type ? null : `must be a ${spec.type}`;
}

// Validate one tool call against the `inputSchema` the tool advertises.
// Returns null when valid, or a message naming the offending property.
// Hand-rolled rather than pulling in a JSON-Schema validator: this repo ships
// with no runtime deps for its HTTP/WebSocket layer either, and the schemas
// above only use object/string/boolean/array-of-string.
function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined) return `missing required property: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      if (schema.additionalProperties === false) return `unknown property: ${key}`;
      continue;
    }
    const bad = typeError(spec, value);
    if (bad) return `property ${key} ${bad}`;
  }
  return null;
}

async function callTool(ctx, name, args = {}) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return errorResult(`unknown tool: ${name}`);
  if (tool.tier === 'full' && ctx.tier !== 'full') return errorResult('full access required');
  // The advertised schemas ARE the trust boundary for MCP callers. The HTTP
  // API behind them is a trusted-caller interface — POST /api/cards honours
  // internal fields like status/triaged so the Plan stage can mint chunk
  // cards — so an unvalidated pass-through would let a full-token MCP caller
  // create a card born `status: "Done"`, skipping Review → triage → build →
  // verify entirely. Enforce the contract here, before anything is dispatched.
  const invalid = validateArgs(tool.inputSchema, args);
  if (invalid) return errorResult(`invalid arguments for ${name}: ${invalid}`);
  try {
    const { status, json } = await tool.call(ctx, args);
    return toolResult(status, json);
  } catch (e) {
    return errorResult(String(e?.message || e));
  }
}

// Builds a tier- and server-bound MCP request handler. `baseUrl` defaults to
// discoverBaseUrl() but is overridable so tests can point it at a throwaway
// `startServer()` instance instead of a real, already-running `todomd serve`.
function createTieredMcpServer({ token, tier, baseUrl, strictDiscovery = false }) {
  const ctx = { token, tier, baseUrl: baseUrl || (strictDiscovery ? undefined : discoverBaseUrl()), strictDiscovery };

  // handleMessage: given one parsed JSON-RPC request/notification, returns
  // the JSON-RPC response object, or null for a notification (no reply).
  async function handleMessage(msg) {
    const { id, method, params } = msg || {};
    const respond = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'todomd', version: '0.1.0' },
          });
        case 'notifications/initialized':
        case 'ping':
          return respond({});
        case 'tools/list':
          return respond({ tools: listToolsFor(tier) });
        case 'tools/call': {
          const result = await callTool(ctx, params?.name, params?.arguments || {});
          return respond(result);
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    } catch (e) {
      return fail(-32603, String(e?.message || e));
    }
  }

  // Exposed for tests that want to skip JSON-RPC framing and call a tool
  // directly; startMcpServer() only ever goes through handleMessage.
  return { handleMessage, listTools: () => listToolsFor(tier), callTool: (name, args) => callTool(ctx, name, args), tier };
}

// Test/programmatic entry point for explicit-token clients. Keep tier
// derivation inside this module so a caller cannot claim full access by
// passing an arbitrary tier alongside an unrelated token.
export function createMcpServer({ token, baseUrl = discoverBaseUrl() }) {
  return createTieredMcpServer({ token, tier: resolveTier(token), baseUrl });
}

// Entry point used by bin/todomd-mcp.js: validates the token, then reads
// newline-delimited JSON-RPC requests from stdin and writes responses to
// stdout — the MCP stdio transport. Never returns while stdin stays open.
export async function startMcpServer({ token, access, baseUrl, input = process.stdin, output = process.stdout } = {}) {
  const credential = resolveStartupCredential({ token, access });
  const server = createTieredMcpServer({
    token: credential.token,
    tier: credential.tier,
    baseUrl,
    strictDiscovery: access !== undefined && baseUrl === undefined,
  });
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }) + '\n');
      return;
    }
    const reply = await server.handleMessage(msg);
    if (reply) output.write(JSON.stringify(reply) + '\n');
  });
  await new Promise((resolve) => rl.once('close', resolve));
  return server;
}
