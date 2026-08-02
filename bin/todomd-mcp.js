#!/usr/bin/env node
// Stdio MCP server over the To-do MD board API. Point an MCP-capable agent
// (Claude, Codex, ...) at this command; see README.md for setup.
import { startMcpServer } from '../src/mcp-server.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
};

try {
  await startMcpServer({ token: flag('--token') });
} catch (e) {
  console.error(`todomd-mcp: ${e.message}`);
  process.exit(1);
}
