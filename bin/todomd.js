#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { addProject, listProjects } from '../src/registry.js';
import { initProject } from '../src/templates.js';
import { startServer } from '../src/server.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--port']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) positional.push(args[i]);
}
const cmd = positional[0] || 'serve';
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

if (cmd === 'init') {
  const created = initProject(process.cwd());
  addProject(process.cwd());
  console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'board already initialized');
  console.log('\nrun `todomd` to open the board.');
  process.exit(0);
}

if (cmd === 'revoke') {
  // cut off mobile/viewer links without touching the desktop session;
  // new tokens are minted on the next server start
  const dir = path.join(process.env.HOME || process.env.USERPROFILE, '.todomd');
  let n = 0;
  for (const f of ['token-mobile', 'token-viewer']) {
    try { fs.unlinkSync(path.join(dir, f)); n++; } catch {}
  }
  console.log(n ? `revoked ${n} device token(s) — restart todomd; old QR links are now dead.` : 'no device tokens to revoke');
  process.exit(0);
}

if (cmd === 'serve') {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, '.todomd', 'tasks'))) {
    addProject(cwd);
  } else if (listProjects().length === 0) {
    console.log('no boards registered and no .todomd/ here — run `todomd init` inside a repo first.');
    process.exit(1);
  }
  const port = Number(flag('--port', 7337));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port: ${flag('--port')}`);
    process.exit(1);
  }
  const { url, lanUrl } = await startServer({ port, lan: args.includes('--lan') });
  console.log(`todomd board: ${url}`);
  if (lanUrl) console.log(`mobile monitor (read-only, this network): ${lanUrl}`);
  if (!args.includes('--no-open')) {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
  }
} else {
  console.log('usage: todomd [init|serve|revoke] [--port N] [--lan] [--no-open]');
  process.exit(cmd === 'help' ? 0 : 1);
}
