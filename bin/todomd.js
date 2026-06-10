#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, listProjects } from '../src/registry.js';
import { initProject } from '../src/templates.js';
import { startServer } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TODOMD_BIN = fileURLToPath(import.meta.url);
const TODOMD_DIR = path.join(process.env.TODOMD_HOME || process.env.HOME || process.env.USERPROFILE, '.todomd');
const PID_FILE = path.join(TODOMD_DIR, 'server.pid');
const USAGE = 'usage: todomd [init|serve|revoke|stop|install-launcher|intake-test <project>] [--port N] [--lan] [--no-open]';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--port']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) positional.push(args[i]);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const cmd = positional[0] || 'serve';
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const isGitRepo = (dir) => {
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' }); return true; }
  catch { return false; }
};
const claudeAvailable = () => {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

if (cmd === 'init') {
  if (!isGitRepo(process.cwd())) {
    console.error('⚠ not a git repo. todomd commits each board change to git — run `git init` first, then `todomd init`.');
    process.exit(1);
  }
  const created = initProject(process.cwd());
  addProject(process.cwd());
  console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'board already initialized');
  // warn if .claude/commands won't be shared (repo ignores .claude/)
  try {
    execFileSync('git', ['check-ignore', '-q', '.claude/commands'], { cwd: process.cwd(), stdio: 'ignore' });
    console.log('\nnote: this repo gitignores .claude/ — the pipeline commands work locally but');
    console.log('      won\'t be committed/shared. `git add -f .claude/commands` to share them.');
  } catch { /* not ignored — good */ }
  if (!claudeAvailable()) {
    console.log('\nnote: the `claude` CLI isn\'t on PATH. Install it and run `claude` once to log in');
    console.log('      before driving the pipeline (Codex cards need `codex` logged in too).');
  }
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

if (cmd === 'install-launcher') {
  const { installLauncher } = await import('../src/launcher.js');
  try {
    const r = installLauncher({ nodeBin: process.execPath, todomdBin: TODOMD_BIN, port: Number(flag('--port', 7337)) });
    console.log(`launcher created: ${r.path}\n${r.hint}`);
    process.exit(0);
  } catch (e) {
    console.error(`could not create launcher: ${e.message}`);
    process.exit(1);
  }
}

if (cmd === 'stop') {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0); // throws if the pid is dead → don't signal a recycled pid
    process.kill(pid);
    fs.rmSync(PID_FILE, { force: true });
    console.log(`stopped todomd (pid ${pid})`);
  } catch {
    fs.rmSync(PID_FILE, { force: true }); // clear a stale pid file
    console.log('no running todomd server found');
  }
  process.exit(0);
}

if (cmd === 'intake-test') {
  const name = positional[1];
  if (!name) { console.error('usage: todomd intake-test <project-name>'); process.exit(1); }
  const { testIntake } = await import('../src/intake.js');
  const r = await testIntake(name);
  if (r.ok) {
    const routing = r.kind === 'inbox' ? `, ${r.routes} route(s)` : '';
    console.log(`✓ connected to ${name} (${r.kind}): folder "${r.folder}", ${r.unseen} unseen message(s)${routing}`);
  } else console.error(`✗ ${r.error}`);
  process.exit(r.ok ? 0 : 1);
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
  // record the pid so `todomd stop` can stop a detached (launcher-started) server
  try {
    fs.mkdirSync(TODOMD_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    // only remove the pid file if it's still OURS — never clobber another
    // running instance's pid (e.g. a terminal serve exiting on EADDRINUSE)
    const cleanup = () => {
      try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true }); } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch {}
  console.log(`todomd board: ${url}`);
  if (lanUrl) console.log(`mobile monitor (read-only, this network): ${lanUrl}`);
  if (!args.includes('--no-open')) {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
  }
} else {
  console.log(USAGE);
  process.exit(cmd === 'help' ? 0 : 1);
}
