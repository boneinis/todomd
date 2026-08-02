// A thin MCP (Model Context Protocol) server over the existing To-do MD API.
// It does not re-implement board/pipeline logic: every tool below calls the
// same functions src/server.js's HTTP routes call (board.js, pipeline.js,
// registry.js, api-shared.js), so the two front-ends share one source of
// truth for auth, sanitization, and board mutation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listProjects } from './registry.js';
import { loadBoard, loadConfig, readCard, createCard, patchFrontmatter } from './board.js';
import { sanitizeAssignee, resolveAttachmentFile } from './api-shared.js';
import { loadToken } from './server.js';
import * as pipeline from './pipeline.js';

const eq = (a, b) => {
  const ba = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// A read tool works for either token tier; a write tool needs the full
// token — the same read/write split server.js's handleApi enforces via
// viewerAuthed()/fullAccess. A couple of "read" HTTP routes (commands) are
// full-token-only in server.js because they expose repo file contents; those
// tools are marked tier: 'full' below to match, not weakened for MCP.
const TOOLS = [
  {
    name: 'list_projects',
    tier: 'viewer',
    description: 'List registered To-do MD project names.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ projects: listProjects().map((p) => p.name) }),
  },
  {
    name: 'get_board',
    tier: 'viewer',
    description: 'Get a project\'s board (columns, cards, run state, usage, banners).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project name' },
        includeArchived: { type: 'boolean', description: 'Include archived cards', default: false },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: (args, project) => {
      const board = loadBoard(project.path, { includeArchived: !!args.includeArchived });
      return {
        ...board,
        mode: board.config.mode || 'launcher',
        runStates: pipeline.getRunStates(project.name),
        banners: pipeline.getBanners(),
        usage: pipeline.usage(project.name),
      };
    },
  },
  {
    name: 'get_run_state',
    tier: 'viewer',
    description: 'Get live run state, banners, and usage for a project (diagnostic info).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    handler: (args, project) => ({
      runStates: pipeline.getRunStates(project.name),
      banners: pipeline.getBanners(),
      usage: pipeline.usage(project.name),
    }),
  },
  {
    name: 'get_card',
    tier: 'viewer',
    description: 'Get a single card by id, including recovery actions.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    handler: async (args, project) => {
      const card = readCard(project.path, args.id);
      if (!card) return { ok: false, error: 'card not found' };
      return { ...card, recovery: await pipeline.recoveryActions(project, args.id) };
    },
  },
  {
    name: 'get_card_file',
    tier: 'viewer',
    description: 'Read an attachment file from a card (base64), confined to .todomd/attachments/.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, path: { type: 'string', description: 'Attachment-relative path, as stored on the card' } },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    handler: (args, project) => {
      const resolved = resolveAttachmentFile(project.path, args.path);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: true, path: args.path, base64: fs.readFileSync(resolved.real).toString('base64') };
    },
  },
  {
    name: 'list_commands',
    tier: 'full',
    description: 'List a project\'s pipeline stage commands (agent/model routing). Requires full access.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    handler: (args, project) => {
      const cfg = loadConfig(project.path);
      const list = [];
      for (const [col, s] of Object.entries(cfg.stages || {})) {
        list.push({ column: col, command: s.command || `todomd-${col.toLowerCase()}`, model: s.model || '', agent: s.agent || '' });
      }
      return { commands: list, defaultAgent: cfg.default_agent || 'claude' };
    },
  },
  {
    name: 'create_card',
    tier: 'full',
    description: 'Create a new card on a project\'s board.',
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
    handler: async (args, project) => {
      const { project: _p, ...fields } = args;
      const result = await createCard(project.path, fields);
      if (result.ok) pipeline.maybeTriage(project, result.id).catch(() => {});
      return result;
    },
  },
  {
    name: 'move_card',
    tier: 'full',
    description: 'Move a card to a new status column (a human move).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' } },
      required: ['project', 'id', 'status'],
      additionalProperties: false,
    },
    handler: (args, project) => pipeline.humanMove(project, args.id, args.status),
  },
  {
    name: 'assign_card',
    tier: 'full',
    description: 'Set a card\'s assignee.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, assignee: { type: 'string' } },
      required: ['project', 'id', 'assignee'],
      additionalProperties: false,
    },
    handler: (args, project) => patchFrontmatter(project.path, args.id, { assignee: sanitizeAssignee(args.assignee) }),
  },
  {
    name: 'retry_verify',
    tier: 'full',
    description: 'Retry verification for a card that failed Verify.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    handler: (args, project) => pipeline.retryVerification(project, args.id),
  },
  {
    name: 'cancel_card',
    tier: 'full',
    description: 'Cancel a card\'s in-progress run.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    handler: (args, project) => pipeline.cancel(project, args.id),
  },
  {
    name: 'archive_card',
    tier: 'full',
    description: 'Archive or unarchive a card.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' }, archived: { type: 'boolean', default: true } },
      required: ['project', 'id'],
      additionalProperties: false,
    },
    handler: (args, project) => pipeline.archiveCard(project, args.id, args.archived !== false),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Resolve the two credential tiers once (persisted per machine, same files
// server.js's loadToken() reads/writes) and build the tool server bound to a
// SINGLE caller tier for its lifetime — this process was started with one
// token, so it never needs to re-check auth per call, mirroring the
// stdio-per-session model MCP clients use.
export function resolveTier(suppliedToken) {
  const full = loadToken('token');
  const viewer = loadToken('token-viewer');
  if (eq(suppliedToken, full)) return 'full';
  if (eq(suppliedToken, viewer)) return 'viewer';
  return null;
}

const findProject = (name) => listProjects().find((p) => p.name === name);

// Builds an (unconnected) MCP Server bound to the given caller tier. Split
// out from startMcpServer() so tests can drive it over an in-memory
// transport instead of real stdio.
export function createMcpServer(tier) {
  const server = new Server({ name: 'todomd', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS
      .filter((t) => tier === 'full' || t.tier === 'viewer')
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS_BY_NAME.get(req.params.name);
    if (!tool) return errorResult(`unknown tool: ${req.params.name}`);
    if (tool.tier === 'full' && tier !== 'full') return errorResult('full access required');
    const args = req.params.arguments || {};
    // every tool but list_projects targets one registered project — validate
    // it against the registry before touching anything, the same boundary
    // findProject() enforces for every HTTP route (server.js:323-324)
    let project;
    if (tool.name !== 'list_projects') {
      project = findProject(args.project);
      if (!project) return errorResult('unknown project');
    }
    try {
      const result = await tool.handler(args, project);
      const isError = result && result.ok === false;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError };
    } catch (e) {
      return errorResult(String(e?.message || e));
    }
  });

  return server;
}

function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

// Entry point used by bin/todomd-mcp.js: validates the token, connects a
// stdio transport, and never returns while the transport is open.
export async function startMcpServer({ token } = {}) {
  const tier = resolveTier(token || process.env.TODOMD_MCP_TOKEN || '');
  if (!tier) {
    throw new Error('bad or missing token — set TODOMD_MCP_TOKEN (or pass --token) to the value in ~/.todomd/token or ~/.todomd/token-viewer');
  }
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createMcpServer(tier);
  await server.connect(new StdioServerTransport());
  return server;
}
