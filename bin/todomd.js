#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, listProjects } from '../src/registry.js';
import { initProject } from '../src/templates.js';
import { startServer } from '../src/server.js';
import { killAllChildren } from '../src/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TODOMD_BIN = fileURLToPath(import.meta.url);
const TODOMD_DIR = path.join(process.env.TODOMD_HOME || process.env.HOME || process.env.USERPROFILE, '.todomd');
const PID_FILE = path.join(TODOMD_DIR, 'server.pid');
const USAGE = 'usage: todomd [init|serve|revoke|stop|install-launcher|upgrade-commands|intake-test <project>] [--port N] [--lan] [--no-open]';

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
const onPath = (bin) => {
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

if (cmd === 'init') {
  if (!isGitRepo(process.cwd())) {
    console.error('⚠ not a git repo. todomd commits each board change to git — run `git init` first, then `todomd init`.');
    process.exit(1);
  }
  const created = initProject(process.cwd(), { nodeBin: process.execPath, todomdBin: TODOMD_BIN });
  addProject(process.cwd());
  console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'board already initialized');
  // warn if .claude/commands won't be shared (repo ignores .claude/)
  try {
    execFileSync('git', ['check-ignore', '-q', '.claude/commands'], { cwd: process.cwd(), stdio: 'ignore' });
    console.log('\nnote: this repo gitignores .claude/ — the pipeline commands work locally but');
    console.log('      won\'t be committed/shared. `git add -f .claude/commands` to share them.');
  } catch { /* not ignored — good */ }
  const haveClaude = onPath('claude'), haveCodex = onPath('codex');
  if (!haveClaude && !haveCodex) {
    console.log('\nnote: no agent CLI on PATH. Install `claude` (the default) or `codex`, run it once');
    console.log('      to log in, then drive the pipeline. todomd just spawns the CLI you authenticate.');
  } else if (!haveClaude) {
    console.log('\nnote: using `codex` (claude not on PATH) — set `default_agent: codex` in .todomd/config.yml,');
    console.log('      or pick the agent per card. (`claude` is the default; install it for claude cards.)');
  }
  console.log('\nrun `todomd` to open the board.');
  process.exit(0);
}

if (cmd === 'revoke') {
  // cut off mobile/viewer links without touching the desktop session;
  // new tokens are minted on the next server start. Use TODOMD_DIR so a
  // TODOMD_HOME override is honored (the server writes tokens there too).
  let n = 0;
  for (const f of ['token-mobile', 'token-viewer']) {
    try { fs.unlinkSync(path.join(TODOMD_DIR, f)); n++; } catch {}
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
    // the pid file is "<pid> <port>" (older versions wrote just the pid)
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim().split(/\s+/)[0]);
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

if (cmd === 'upgrade-commands') {
  if (!isGitRepo(process.cwd())) {
    console.error('⚠ not a git repo — run from inside a repo with an existing board.');
    process.exit(1);
  }
  const { CMD_PLAN, CMD_BUILD, CMD_VERIFY, cmdDispatch, CMD_TRIAGE } = await import('../src/templates.js');
  const { readCommandParts, writeCommandCustom } = await import('../src/board.js');
  const commands = [
    ['todomd-plan', CMD_PLAN],
    ['todomd-build', CMD_BUILD],
    ['todomd-verify', CMD_VERIFY],
    ['todomd-dispatch', cmdDispatch(process.execPath, TODOMD_BIN)],
    ['todomd-triage', CMD_TRIAGE],
  ];
  const updated = [];
  for (const [name, content] of commands) {
    const dest = path.join(process.cwd(), '.claude', 'commands', `${name}.md`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = readCommandParts(process.cwd(), name);
    fs.writeFileSync(dest, content);
    if (existing && (existing.hasRegion || existing.custom)) {
      await writeCommandCustom(process.cwd(), name, existing.custom);
    }
    updated.push(path.relative(process.cwd(), dest));
  }
  console.log(`upgraded ${updated.length} command file(s):\n  ${updated.join('\n  ')}`);
  process.exit(0);
}

if (cmd === 'fanout') {
  const id = positional[1];
  if (!id) { console.error('usage: todomd fanout <id>'); process.exit(1); }
  const { materializeChunks } = await import('../src/chunks.js');
  const { readCard, parseChunks } = await import('../src/board.js');
  const card = readCard(process.cwd(), id);
  if (!card) { console.error(`card not found: ${id}`); process.exit(1); }
  if (card.data?.epic === true || (card.data?.children?.length ?? 0) > 0) {
    console.error(`already fanned out: ${id}`);
    process.exit(1);
  }
  const chunks = parseChunks(card.body || '');
  if (chunks.length < 2) { console.error(`no multi-chunk breakdown found in ${id}`); process.exit(1); }
  const ids = await materializeChunks(process.cwd(), id, chunks);
  console.log(`fanned out ${ids.length} chunk(s) from ${id}`);
  process.exit(0);
}

if (cmd === 'advance') {
  const id = positional[1];
  if (!id) { console.error('usage: todomd advance <id>'); process.exit(1); }
  const { advanceEpicChildren } = await import('../src/chunks.js');
  const { readCard } = await import('../src/board.js');
  const card = readCard(process.cwd(), id);
  if (!card || !card.data?.epic) { console.error(`not an epic: ${id}`); process.exit(1); }
  const moved = await advanceEpicChildren(process.cwd(), id);
  console.log(moved.length ? `advanced: ${moved.join(', ')}` : 'no cards ready to advance');
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
  // Single-instance guard: a second serve's boot reconciliation would kill the
  // first instance's agents. If the pid file names a live process that still
  // looks like a todomd server (same `ps` style check pipeline uses), point the
  // user at it and bail. A dead pid — or a recycled pid owned by an unrelated
  // process — means a stale file: proceed as today.
  try {
    const [pidStr, portStr] = fs.readFileSync(PID_FILE, 'utf8').trim().split(/\s+/);
    const pid = Number(pidStr);
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if dead → stale pid file, fall through
      const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (cmdline.includes('todomd')) {
        const runningPort = Number(portStr) || port;
        console.error(`todomd is already running on port ${runningPort} — open http://127.0.0.1:${runningPort} or run \`todomd stop\``);
        process.exit(1);
      }
    }
  } catch { /* no pid file, dead process, or no ps — proceed */ }
  // backstop: a stray rejection (IMAP socket, watcher, pipeline sweep) must
  // never take the board down
  process.on('unhandledRejection', (e) => console.error('todomd: unhandled rejection:', e));
  const { url, lanUrl, close } = await startServer({ port, lan: args.includes('--lan') });
  // record the pid so `todomd stop` can stop a detached (launcher-started) server
  try {
    fs.mkdirSync(TODOMD_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, `${process.pid} ${port}`);
    // only remove the pid file if it's still OURS — never clobber another
    // running instance's pid (e.g. a terminal serve exiting on EADDRINUSE)
    const cleanup = () => {
      try { if (fs.readFileSync(PID_FILE, 'utf8').trim().split(/\s+/)[0] === String(process.pid)) fs.rmSync(PID_FILE, { force: true }); } catch {}
    };
    // graceful shutdown: kill tracked agent CLIs first (an orphan keeps running
    // and billing), then close the server, then remove the pid file. Guarded so
    // a second signal while the first is still shutting down doesn't re-enter.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await killAllChildren(); } catch {}
      try { close?.(); } catch {}
      cleanup();
      process.exit(0);
    };
    process.on('exit', cleanup);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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
