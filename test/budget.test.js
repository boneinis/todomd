import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, sleep, tmp, git } from './helpers.js';
import { readCard } from '../src/board.js';
import { addProject } from '../src/registry.js';
import { parseActive } from '../src/coordination.js';
import { initProject, cmdDispatch } from '../src/templates.js';
import { fileURLToPath } from 'node:url';
import * as pipeline from '../src/pipeline.js';

const noop = () => {};
const project = (repo) => ({ name: path.basename(repo), path: repo });
const status = (repo, id) => readCard(repo, id).data.status;
const idle = (name) => Object.keys(pipeline.getRunStates(name)).length === 0;

// a board whose mode is budget (the server only manages it; a /loop dispatcher
// does the work) instead of the makeRepo default of launcher
function budgetRepo(opts) {
  const repo = makeRepo(opts);
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}

// the actual generated dispatch prompt (what a /loop session reads)
function dispatchPrompt() {
  const repo = tmp('disp');
  git(repo, ['init', '-q']);
  initProject(repo);
  return fs.readFileSync(path.join(repo, '.claude/commands/todomd-dispatch.md'), 'utf8');
}

/* ── A. server-side budget-mode contract: manage the board, never drive work ── */

test('budget: Review→Plan does NOT run the plan agent (launcher would auto-plan)', async () => {
  isolateHome();
  useFakeAgent(); // if the server wrongly spawned, the fake would advance the card
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001'); // Review

  const r = await pipeline.humanMove(p, 'task-0001', 'Plan');
  assert.equal(r.ok, true);
  await sleep(400);
  assert.equal(status(repo, 'task-0001'), 'Plan', 'stays at Plan — no plan agent in budget mode');
  assert.ok(idle(p.name), 'no run spawned');
  clearFakeAgent();
});

test('budget: approving Planned→Queue does NOT start a build (launcher would)', async () => {
  isolateHome();
  useFakeAgent();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  const r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, true);
  await sleep(400);
  assert.equal(status(repo, 'task-0001'), 'Queue', 'sits in Queue for the dispatcher to pick up');
  assert.ok(idle(p.name), 'no build spawned');
  clearFakeAgent();
});

test('budget reconcileOnBoot NUDGES (does not orphan-sweep) a stuck Build card', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  addProject(repo); // reconcile iterates listProjects()
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' });
  // age the card file past the 30-min "stuck" threshold
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  const old = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(file, old, old);

  await pipeline.reconcileOnBoot();

  assert.equal(status(repo, 'task-0001'), 'Build', 'NOT swept to Needs Human — the dispatcher owns budget cards');
  const nudge = pipeline.getBanners().find((b) => b.text.includes(p.name) && b.text.includes('Build/Verify'));
  assert.ok(nudge, 'a stuck-card nudge banner is shown so the card is not silently stalled');
});

test('budget reconcileOnBoot does NOT nudge a freshly-active card', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = budgetRepo();
  addProject(repo);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Build' }); // just written → fresh mtime

  await pipeline.reconcileOnBoot();

  assert.equal(status(repo, 'task-0001'), 'Build');
  assert.ok(!pipeline.getBanners().some((b) => b.text.includes(p.name) && b.text.includes('Build/Verify')),
    'no nudge while the card is actively progressing');
});

/* ── B. cross-implementation consistency: the prose prompt vs the code it must
      stay compatible with (the lock owner format and the ACTIVE.md parser) ── */

test('budget: the generated transaction command runs with a compatible lock owner', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  isolateHome();
  const bin = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
  const prompt = cmdDispatch(process.execPath, bin);
  const command = prompt.match(/^.* budget-write \. -- \/bin\/sh \/absolute\/path\/to\/transaction\.sh$/m);
  assert.ok(command, 'the supervised transaction command is present');
  const repo = budgetRepo(), script = path.join(tmp('transaction'), 'write.sh');
  fs.writeFileSync(script, 'set -eu\ncat .todomd/.lock/owner\n');
  const quotedScript = "'" + script.replaceAll("'", "'\\''") + "'";
  const result = JSON.parse(execFileSync('/bin/sh', ['-c', command[0].replace('/absolute/path/to/transaction.sh', quotedScript)], { cwd: repo, encoding: 'utf8' }));
  assert.equal(result.ok, true);
  const fields = fs.readFileSync(result.output_file, 'utf8').trim().split(' ');
  assert.equal(fields.length, 3, 'owner format matches lockfile.js');
  const ts = Number(fields[0]);
  assert.ok(Number.isFinite(ts) && ts > 1_000_000_000 && ts < 10_000_000_000);
  assert.ok(fields[1].includes('@'));
  assert.equal(fs.existsSync(path.join(repo, '.todomd/.lock')), false);
});

test('budget: the prompt\'s ACTIVE.md manifest format parses with coordination.parseActive', () => {
  const prompt = dispatchPrompt();
  // pull the documented claim template out of the prompt and fill the placeholders,
  // then confirm the LAUNCHER's parser reads it — so the two implementations can
  // read each other's claims. If the prompt drifts (em-dash → hyphen, dropped
  // backtick), the filled line won't parse and this fails.
  const hdr = prompt.match(/^- \*\*<id>\*\* — .*started <[^>]*>$/m);
  const filesT = prompt.match(/^\s*- files: <[^>]*>$/m);
  assert.ok(hdr && filesT, 'the manifest template is present in the prompt');

  const header = hdr[0]
    .replace('<branch_prefix><id>', 'todomd/task-0007') // before <id>, which is a substring
    .replace('<id>', 'task-0007')
    .replace('<title>', 'Fix the login redirect')
    .replace('<worker>', 'alice@host')
    .replace(/<UTC[^>]*>/, '2026-06-10T14:30Z');
  const filesLine = filesT[0].trim().replace(/<[^>]*>/, 'src/auth.js, src/login.js');

  const claims = parseActive(`${header}\n  ${filesLine}`);
  assert.equal(claims.length, 1, 'the filled-in template parses as exactly one claim');
  assert.equal(claims[0].card, 'task-0007');
  assert.equal(claims[0].branch, 'todomd/task-0007');
  assert.equal(claims[0].worker, 'alice@host');
  assert.deepEqual(claims[0].files, ['src/auth.js', 'src/login.js']);
});
