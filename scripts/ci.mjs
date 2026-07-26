#!/usr/bin/env node
// Local CI gate. `npm run ci` runs everything; `npm run ci -- --quick` skips the
// browser stage and is what the pre-push hook uses.
//
// The stage worth having here is the PACK SMOKE: unit tests import from src/,
// so they cannot tell you whether the thing you'd actually install works. This
// packs the tarball, installs it into a throwaway project, scaffolds a board,
// boots the server and exercises the API — the check that catches a file left
// out of `files`, a missing runtime dep, or a broken bin shebang.
//
// What this canNOT do: tell you the code works anywhere but this machine. The
// `ps` check in `todomd stop` was macOS-only and would pass here forever; so
// would the Chrome lookup in test/browser.js. That needs a clean Linux runner
// (see the workflow note in README) — local CI is the "did I break it" gate,
// not the "does it work elsewhere" one.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const results = [];
let failed = false;

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

async function stage(name, fn, { fatal = true } = {}) {
  if (failed) { results.push({ name, status: 'skipped' }); return; }
  const t0 = Date.now();
  process.stdout.write(`${c.bold('▶')} ${name} `);
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name, status: 'pass', ms });
    console.log(c.green(`ok`) + c.dim(` (${(ms / 1000).toFixed(1)}s)`));
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ name, status: fatal ? 'fail' : 'warn', ms, error: e.message });
    console.log((fatal ? c.red('FAILED') : c.yellow('warn')) + c.dim(` (${(ms / 1000).toFixed(1)}s)`));
    console.log(`  ${e.message.split('\n').slice(0, 12).join('\n  ')}`);
    if (fatal) failed = true;
  }
}

// Keeps the streams SEPARATE and resolves stdout only. Merging them looks
// harmless until a caller parses the result: `npm pack --json` prints its JSON
// to stdout while npm's lifecycle banner ("> todomd@0.1.0 prepare") goes to
// stderr, so a merged buffer is invalid JSON depending on npm's loglevel.
function run(cmd, args, opts = {}) {
  const r = spawn(cmd, args, { cwd: ROOT, ...opts });
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    r.stdout?.setEncoding('utf8');
    r.stderr?.setEncoding('utf8');
    r.stdout?.on('data', (d) => { out += d; });
    r.stderr?.on('data', (d) => { err += d; });
    r.on('error', reject);
    r.on('close', (code) => (code === 0 ? resolve(out)
      : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${tail(err || out)}`))));
  });
}
const tail = (s, n = 25) => s.trim().split('\n').slice(-n).join('\n');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* ── stages ── */

const unit = () => run('node', ['--test', ...fs.readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f))]);

const ui = () => run('node', ['--test', 'test/ui/ui-smoke.test.js']);

// Non-fatal in --quick: a new upstream advisory shouldn't block a push that
// has nothing to do with it. Fatal in a full run, where you're asking.
async function audit() {
  const out = await run('npm', ['audit', '--audit-level=high', '--json']).catch((e) => { throw new Error(tail(e.message, 6)); });
  const n = JSON.parse(out).metadata?.vulnerabilities || {};
  if ((n.high || 0) + (n.critical || 0) > 0) throw new Error(`high/critical advisories: ${JSON.stringify(n)}`);
}

async function packSmoke() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'todomd-ci-'));
  const home = path.join(work, 'home');
  const proj = path.join(work, 'proj');
  const repo = path.join(work, 'repo');
  let server;
  try {
    for (const d of [home, proj, repo]) fs.mkdirSync(d, { recursive: true });

    // 1. pack exactly what an install would get
    // --silent as well as separated streams: `pack` runs the `prepare` script,
    // and its banner would otherwise land in whatever we parse
    const packed = JSON.parse(await run('npm', ['pack', '--json', '--silent', '--pack-destination', work]));
    const tarball = path.join(work, packed[0].filename);

    // 2. install it into a throwaway project (offline-first so a warm cache works)
    execFileSync('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
    await run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', tarball], { cwd: proj });
    const bin = path.join(proj, 'node_modules', '.bin', 'todomd');
    if (!fs.existsSync(bin)) throw new Error('the installed package has no todomd bin');

    // 3. scaffold a board in a fresh git repo
    execFileSync('git', ['init', '-q', '.'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'ci@todomd.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'todomd-ci'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ci-fixture","type":"module"}\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    await run(bin, ['init'], { cwd: repo, env: { ...process.env, TODOMD_HOME: home } });

    // the shipped defaults must stay confined — these are security regressions
    // that a unit test on src/ would not notice in the INSTALLED artifact
    const cfg = fs.readFileSync(path.join(repo, '.todomd/config.yml'), 'utf8');
    if (!cfg.includes('Edit(.todomd/tasks/**)')) throw new Error("shipped config lost Plan's scoped Edit");
    if (/^\s+- "Bash\(node/m.test(cfg)) throw new Error('shipped config re-introduced a broad Bash(node:*) rule');
    if (!fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split('\n').some((l) => l.trim() === '.todomd/local/'))
      throw new Error('init did not gitignore .todomd/local/ (local prompts would be committable)');

    // 4. boot the installed server and exercise the API
    const port = await freePort();
    server = spawn(bin, ['serve', '--no-open', '--port', String(port)],
      { cwd: repo, env: { ...process.env, TODOMD_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });
    const deadline = Date.now() + 60_000;
    while (!log.includes('todomd board:') && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}\n${tail(log)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!log.includes('todomd board:')) throw new Error(`server never came up\n${tail(log)}`);

    const tok = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();
    const viewer = fs.readFileSync(path.join(home, '.todomd', 'token-viewer'), 'utf8').trim();
    const base = `http://127.0.0.1:${port}`;
    const code = async (p, headers) => (await fetch(base + p, { headers })).status;
    const expect = (got, want, what) => { if (got !== want) throw new Error(`${what}: expected ${want}, got ${got}`); };

    expect(await code('/api/board?project=repo', { 'x-todomd-token': tok }), 200, 'board with a full token');
    expect(await code('/api/board?project=repo'), 401, 'board with no token');
    expect(await code('/api/board?project=repo', { 'x-todomd-token': viewer }), 200, 'viewer can read the board');
    // today's fix: an authenticated-but-limited viewer is 403, never 401
    expect(await code('/api/cards/task-0001/runlog?project=repo', { 'x-todomd-token': viewer }), 403, 'viewer runlog');
    expect(await code('/api/models?project=repo&agent=claude', { 'x-todomd-token': viewer }), 403, 'viewer models');
    // the prompt editor must expose both halves in the installed build
    const parts = await (await fetch(`${base}/api/commands/todomd-plan?project=repo`, { headers: { 'x-todomd-token': tok } })).json();
    if (!('local' in parts) || !('custom' in parts)) throw new Error('installed build is missing a prompt half');

    // the UI itself has to be IN the package — `files` dropping public/ would
    // leave every API green and the board blank, which is the whole reason this
    // stage exists (no unit test can see the installed artifact)
    const page = await fetch(`${base}/?token=${tok}`);
    expect(page.status, 200, 'board page');
    const html = await page.text();
    for (const asset of ['/app.js', '/style.css']) {
      if (!html.includes(asset)) throw new Error(`board page does not reference ${asset}`);
      expect(await code(asset), 200, `asset ${asset}`);
    }

    // 5. it stops cleanly through its own CLI
    await run(bin, ['stop'], { env: { ...process.env, TODOMD_HOME: home } });
    const gone = Date.now() + 15_000;
    while (server.exitCode === null && Date.now() < gone) await new Promise((r) => setTimeout(r, 200));
    if (server.exitCode === null) throw new Error('`todomd stop` did not stop the server it started');
    server = null;
  } finally {
    try { server?.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/* ── run ── */

console.log(c.bold(`todomd local CI`) + c.dim(QUICK ? ' (quick: no browser stage)' : '') +
  c.dim(` · node ${process.version} · load ${os.loadavg()[0].toFixed(1)}\n`));

await stage('unit + integration tests', unit);
if (!QUICK) await stage('browser smoke test', ui);
await stage('npm audit (high+)', audit, { fatal: !QUICK });
await stage('pack → install → init → serve → stop', packSmoke);

const total = results.reduce((s, r) => s + (r.ms || 0), 0);
console.log('');
for (const r of results) {
  const tag = { pass: c.green('pass'), fail: c.red('FAIL'), warn: c.yellow('warn'), skipped: c.dim('skip') }[r.status];
  console.log(`  ${tag}  ${r.name}${r.ms ? c.dim(` ${(r.ms / 1000).toFixed(1)}s`) : ''}`);
}
console.log(c.dim(`\n  ${(total / 1000).toFixed(1)}s total`));
if (failed) {
  console.log(c.red('\nCI failed.') + c.dim(' To push anyway: git push --no-verify\n'));
  process.exit(1);
}
console.log(c.green('\nCI passed.\n'));
