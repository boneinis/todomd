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

const eq = (a, b) => {
  const ba = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// A read tool works for either token tier; a write tool needs the full
// token. The tier decides which tools a session sees *and* is re-checked in
// callTool() before dispatch; server.js's viewerAuthed()/fullAccess checks on
// the HTTP request itself remain the backstop behind both.
export function resolveTier(suppliedToken, boardAgentOnly = false) {
  try {
    const scoped = fs.readFileSync(path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'token-board-agent'), 'utf8').trim();
    if (scoped && eq(suppliedToken, scoped)) return 'agent';
  } catch { /* a running v2 server creates this credential */ }
  if (boardAgentOnly) return null;
  const full = loadToken('token');
  const viewer = loadToken('token-viewer');
  if (eq(suppliedToken, full)) return 'full';
  if (eq(suppliedToken, viewer)) return 'viewer';
  return null;
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

const enc = encodeURIComponent;

// One JSON call against the live todomd HTTP API.
async function apiCall(ctx, method, pathname, { query = {}, body } = {}) {
  const url = new URL(pathname, ctx.baseUrl);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-todomd-token': ctx.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, json: { ok: false, error: `couldn't reach the todomd server at ${ctx.baseUrl} — is \`todomd serve\` running? (${e.message})` } };
  }
  let json;
  try { json = await res.json(); } catch { json = { ok: false, error: `bad response from todomd server (status ${res.status})` }; }
  return { status: res.status, json };
}

// /api/file isn't JSON — it streams the raw attachment bytes with a
// content-type header — so it gets its own thin fetch instead of apiCall().
async function fetchFile(ctx, project, rel) {
  const url = new URL('/api/file', ctx.baseUrl);
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
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: 200, json: { ok: true, path: rel, contentType: res.headers.get('content-type') || '', base64: buf.toString('base64') } };
}

const string = { type: 'string' };
const scopedProperties = { session_id: string, request_id: string, scope: { type: 'string', enum: ['portfolio'] }, board_id: string };
const TOOLS = [
  { name: 'board_agent_overview', tier: 'agent',
    description: 'List every selected board with stable board_id, status, policy and connection health. Resolve names or aliases here; ask the user when the target is ambiguous. Installing another board never grants access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: (ctx) => apiCall(ctx, 'GET', '/api/board-agent/overview') },
  { name: 'board_agent_context', tier: 'agent',
    description: 'Read one board’s separate memory, policy, committed repository rules, diagnostics and paginated cards. Supply session_id to record which full plans you reviewed. Follow next_cursor with card_revision as revision; fetch a card with card_id and next_detail_cursor as detail_cursor. Never infer omitted cards are absent.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['board_id', 'session_id'],
      properties: { board_id: string, session_id: string, card_id: string, cursor: string, detail_cursor: string, revision: string, limit: { type: 'integer' } } },
    call: (ctx, args) => apiCall(ctx, 'GET', '/api/board-agent/context', { query: args }) },
  { name: 'board_agent_message', tier: 'agent',
    description: 'Save the user’s request and establish session focus. Provide either board_id or scope=portfolio. Keep one stable session_id for this Codex conversation. A new user request resets its action budget; do not invent user messages to evade limits. Ending voice does not cancel board work.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id', 'request_id', 'text'], properties: { ...scopedProperties, text: string } },
    call: (ctx, args) => apiCall(ctx, 'POST', '/api/board-agent/message', { body: args }) },
  { name: 'board_agent_propose', tier: 'agent',
    description: 'Submit an explicit board action after saving the user request. Routine actions follow that board’s rules; exceptions wait for visible desktop approval. Reuse request_id only for an identical retry. Report each actual result, including partial outcomes. No spoken or agent-supplied approval bypass exists.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id', 'request_id', 'action', 'board_id', 'why'],
      properties: { session_id: string, request_id: string, board_id: string,
        action: { type: 'string', enum: ['create_card', 'plan', 'approve', 'kick_queue', 'resume_build', 'retry_verification', 'pause_queue', 'resume_queue', 'cancel', 'archive', 'restart_build', 'retriage', 'retry_planned'] },
        card_id: string, title: string, description: string, why: string } },
    call: (ctx, args) => apiCall(ctx, 'POST', '/api/board-agent/actions', { body: args }) },
  { name: 'board_agent_reply', tier: 'agent',
    description: 'Save a response in portfolio or one board’s history. Report actual receipts and pending exceptions; keep repo-specific decisions in that board’s context.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id', 'request_id', 'text'], properties: { ...scopedProperties, text: string } },
    call: (ctx, args) => apiCall(ctx, 'POST', '/api/board-agent/reply', { body: args }) },
  { name: 'board_agent_events', tier: 'agent',
    description: 'Resume recent results and exceptions using a cursor and explicit board_id or scope=portfolio. If reset_required, refresh context and inspect uncertain receipts before retrying. This is a read, not a background scheduler.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { board_id: string, scope: { type: 'string', enum: ['portfolio'] }, cursor: string } },
    call: (ctx, args) => apiCall(ctx, 'GET', '/api/board-agent/events', { query: args }) },

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
      properties: { project: { type: 'string' }, id: { type: 'string' }, archived: { type: 'boolean', default: true } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    call: (ctx, args) => apiCall(ctx, 'POST', `/api/cards/${enc(args.id)}/archive`, { query: { project: args.project }, body: { archived: args.archived !== false } }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function listToolsFor(tier, boardAgentOnly = false) {
  return TOOLS.filter((t) => (!boardAgentOnly || t.tier === 'agent') && (tier === 'full' || (tier === 'agent' ? t.tier === 'agent' : tier === 'viewer' && t.tier === 'viewer'))).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
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
  if (spec.enum && !spec.enum.includes(value)) return 'must be one of the advertised values';
  if (spec.type === 'integer') return Number.isInteger(value) ? null : 'must be an integer';
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
  if ((ctx.boardAgentOnly || ctx.tier === 'agent') && (typeof name !== 'string' || !name.startsWith('board_agent_'))) return errorResult('tool unavailable in Board Agent mode');
  if (!tool) return errorResult(`unknown tool: ${name}`);
  if (!ctx.tier || (tool.tier === 'agent' && !['agent', 'full'].includes(ctx.tier))) return errorResult('Board Agent access required');
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
export function createMcpServer({ token, baseUrl = discoverBaseUrl(), boardAgentOnly = false }) {
  const tier = resolveTier(token, boardAgentOnly);
  const ctx = { token, tier, baseUrl, boardAgentOnly };

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
          return respond({ tools: listToolsFor(tier, boardAgentOnly) });
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
  return { handleMessage, listTools: () => listToolsFor(tier, boardAgentOnly), callTool: (name, args) => callTool(ctx, name, args), tier };
}

// Entry point used by bin/todomd-mcp.js: validates the token, then reads
// newline-delimited JSON-RPC requests from stdin and writes responses to
// stdout — the MCP stdio transport. Never returns while stdin stays open.
export async function startMcpServer({ token, baseUrl, boardAgentOnly = false, input = process.stdin, output = process.stdout } = {}) {
  let resolvedToken = token || process.env.TODOMD_MCP_TOKEN || '';
  if (boardAgentOnly && !resolvedToken) {
    try { resolvedToken = fs.readFileSync(path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'token-board-agent'), 'utf8').trim(); } catch { /* actionable error below */ }
  }
  const tier = resolveTier(resolvedToken, boardAgentOnly);
  if (!tier) {
    if (boardAgentOnly) throw new Error('Board Agent requires a running v2 todomd server and its scoped token-board-agent credential; primary/viewer tokens are refused in --board-agent mode');
    throw new Error('bad or missing token — set TODOMD_MCP_TOKEN (or pass --token) to the value in ~/.todomd/token or ~/.todomd/token-viewer');
  }
  const server = createMcpServer({ token: resolvedToken, baseUrl, boardAgentOnly });
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
