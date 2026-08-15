#!/usr/bin/env node
// Stdio MCP server over the To-do MD board API. Point an MCP-capable agent
// (Claude, Codex, ...) at this command; see README.md for setup.
import { startMcpServer } from '../src/mcp-server.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
};

// --url wins over --port; with neither, mcp-server.js discovers the port from
// TODOMD_MCP_URL/TODOMD_MCP_PORT or ~/.todomd/server.pid.
const port = flag('--port');
try {
  const token = flag('--token');
  const access = flag('--access');
  const url = flag('--url');
  if (args.includes('--token') && token === undefined) throw new Error('--token requires a value');
  if (args.includes('--access') && access === undefined) throw new Error('--access requires viewer or full');
  if (access !== undefined && (url !== undefined || port !== undefined)) {
    throw new Error('--access uses verified local discovery and cannot be combined with --url or --port');
  }
  await startMcpServer({
    token,
    access,
    baseUrl: url || (port ? `http://127.0.0.1:${port}` : undefined),
  });
} catch (e) {
  console.error(`todomd-mcp: ${e.message}`);
  process.exit(1);
}
