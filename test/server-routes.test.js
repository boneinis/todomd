import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { isolateHome, makeRepo, writeCard, useFakeAgent, clearFakeAgent, until, tmp, BUDGET } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';
import { readCard, readRunLog } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';
import { recordUsage } from '../src/runstore.js';

// The epic-delete test drives a build that hangs until it's signalled. A live
// agent child is a ref'd handle — one left behind (cancel path missed, an early
// assertion failure) keeps this process alive forever, stalling the suite with
// no failing test to point at. Sweep at the end.
after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const deviceToken = (name) => fs.readFileSync(path.join(process.env.TODOMD_HOME, '.todomd', name), 'utf8').trim();
// a budget board so /move doesn't spawn an agent (the server just manages it)
function budgetRepo() {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  return repo;
}
async function boot() {
  const repo = budgetRepo();
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${srv.port}`;
  return { repo, name, base, srv, q: `?project=${encodeURIComponent(name)}` };
}

test('API auth gauntlet: token tiers, origin check, viewer is read-only', async () => {
  isolateHome();
  const { name, base, srv, q } = await boot();
  const full = srv.token, viewer = deviceToken('token-viewer'), mobile = deviceToken('token-mobile');
  const J = (tok, origin) => ({ 'x-todomd-token': tok, 'content-type': 'application/json', ...(origin ? { origin } : {}) });
  try {
    // no token → 401
    assert.equal((await fetch(`${base}/api/board${q}`)).status, 401);
    // viewer reads the board (access: viewer)
    let r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 200);
    const viewerBoard = await r.json();
    assert.equal(viewerBoard.access, 'viewer');
    assert.equal(viewerBoard.primary, false);
    // viewer cannot mutate → 403 read-only
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: J(viewer, base), body: '{"title":"x"}' });
    assert.equal(r.status, 403);
    // full token reads as 'full', and the board carries the skill picker options
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': full } });
    const fullBoard = await r.json();
    assert.equal(fullBoard.access, 'full');
    assert.equal(fullBoard.primary, true);
    assert.ok(Array.isArray(fullBoard.skills) && fullBoard.skills.includes('todomd-plan'), 'board lists available skills');
    // full POST with a FOREIGN origin → 403 (CSRF/DNS-rebind defense)
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: J(full, 'http://evil.com'), body: '{"title":"x"}' });
    assert.equal(r.status, 403);
    // full POST same-origin → 200, creates a card
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: J(full, base), body: '{"title":"First card"}' });
    assert.equal(r.status, 200);
    assert.match((await r.json()).id, /^task-\d+$/);
    // the mobile token also has full access
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: J(mobile, base), body: '{"title":"Second"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': mobile } });
    const mobileBoard = await r.json();
    assert.equal(mobileBoard.access, 'full');
    assert.equal(mobileBoard.primary, false, 'mobile control is full access but cannot start desktop-only voice');
    // commands list requires full access → viewer 403
    assert.equal((await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': viewer } })).status, 403);
    // unknown project → 404
    assert.equal((await fetch(`${base}/api/board?project=nope`, { headers: { 'x-todomd-token': full } })).status, 404);
  } finally { srv.close(); }
});

test('delivery preview uses existing read permissions and cannot mutate or dispatch', async () => {
  isolateHome();
  const { repo, name, base, srv, q } = await boot();
  try {
    writeCard(repo, 'task-0001', { status: 'Done' });
    const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
    const before = fs.readFileSync(file, 'utf8');
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    const beforeHead = head(), beforeLog = readRunLog(repo, 'task-0001');
    const viewer = deviceToken('token-viewer');
    const endpoint = `${base}/api/delivery/preview${q}`;
    assert.equal((await fetch(endpoint)).status, 401);
    for (const token of [viewer, srv.token]) {
      const response = await fetch(endpoint, { headers: { 'x-todomd-token': token } });
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.read_only, true);
      assert.equal(report.execution_enabled, false);
      assert.equal(report.cards[0].deployment, 'unknown');
      assert.equal(report.cards[0].proposed_state, null);
    }
    assert.equal((await fetch(endpoint, { headers: { 'x-todomd-token': deviceToken('token-board-agent') } })).status, 403);
    assert.equal((await fetch(`${base}/api/delivery/preview?project=absent`, { headers: { 'x-todomd-token': viewer } })).status, 404);
    for (const [token, status] of [[viewer, 403], [srv.token, 405]]) {
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'x-todomd-token': token, origin: base } })).status, status);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(head(), beforeHead);
    assert.deepEqual(readRunLog(repo, 'task-0001'), beforeLog);
    assert.equal(pipeline.hasLiveRun(name, 'task-0001'), false);
    assert.equal(readCard(repo, 'task-0001').data.status, 'Done');
  } finally { srv.close(); }
});

test('API usage separates subscription tokens, unavailable gateway runs, and legacy estimated cost', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  try {
    recordUsage({ run_id: 'api-codex', provider: 'codex', model: 'gpt-5.6-sol', execution_type: 'subscription_cli',
      usage: { available: true, input_tokens: 500, cached_input_tokens: 400, output_tokens: 25 } });
    recordUsage({ run_id: 'api-gemini', provider: 'gemini', model: 'gemini-3.6-flash-low', execution_type: 'gateway',
      usage: { available: false } });
    const r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } });
    const usage = (await r.json()).usage;
    assert.equal(usage.model_runs, 2);
    assert.equal(usage.tokens.input_tokens, 500);
    assert.equal(usage.by_provider.codex.tokens.cached_input_tokens, 400);
    assert.equal(usage.by_provider.gemini.unavailable_usage_runs, 1);
    assert.equal(typeof usage.month_cost_usd, 'number', 'legacy API field remains compatible');
  } finally { srv.close(); }
});

test('API card prompt is full-access only and streams an advisory chat turn without moving the card', async () => {
  isolateHome();
  useFakeAgent({ other_message: 'Review the latest verifier evidence before merging.' });
  const { repo, name, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned', body: 'A preserved implementation is ready for review.' });
    const viewer = deviceToken('token-viewer');
    let r = await fetch(`${base}/api/cards/task-0001/prompt${q}`, {
      method: 'POST',
      headers: { 'x-todomd-token': viewer, 'content-type': 'application/json', origin: base },
      body: '{"prompt":"What next?"}',
    });
    assert.equal(r.status, 403, 'viewer links cannot start agent turns');

    r = await fetch(`${base}/api/cards/task-0001/prompt${q}`, {
      method: 'POST', headers: h, body: '{"prompt":"What next?"}',
    });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { ok: true, queued: true });
    await until(() => !pipeline.hasLiveRun(name, 'task-0001'), {
      timeout: BUDGET.stage, label: 'API-started card prompt completed',
    });
    assert.equal(readCard(repo, 'task-0001').data.status, 'Planned');
    assert.ok(readRunLog(repo, 'task-0001').events.some((event) =>
      JSON.stringify(event).includes('Review the latest verifier evidence')));

    writeCard(repo, 'task-0002', {
      status: 'Needs Human',
      body: 'A product choice is required before work can continue.',
      extra: 'needs_human_reason: needs_answer\nquestion: Which behavior should win?\n',
    });
    r = await fetch(`${base}/api/cards/task-0002/recover${q}`, {
      method: 'POST', headers: { 'x-todomd-token': viewer, origin: base },
    });
    assert.equal(r.status, 403, 'viewer links cannot authorize a recovery agent action');
    r = await fetch(`${base}/api/cards/task-0002/recover${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { ok: true, queued: true });
    await until(() => !pipeline.hasLiveRun(name, 'task-0002'), {
      timeout: BUDGET.stage, label: 'API-started recovery review completed',
    });
    assert.equal(readCard(repo, 'task-0002').data.status, 'Needs Human',
      'a recovery review holds when the agent selects a human decision');
    assert.match(readCard(repo, 'task-0002').raw, /Recovery.*hold_for_human/);

    r = await fetch(`${base}/api/cards/task-0001/summaries${q}`, {
      method: 'POST',
      headers: { 'x-todomd-token': viewer, origin: base },
    });
    assert.equal(r.status, 403, 'viewer links cannot spend an agent turn generating summaries');
    r = await fetch(`${base}/api/cards/task-0001/summaries${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 200);
    const summaries = await r.json();
    assert.match(summaries.description_tldr, /semantic description summary/);
    assert.match(summaries.last_run_tldr, /completed.*next action/);
  } finally {
    srv.close();
    clearFakeAgent();
  }
});

test('API card lifecycle: create → set → move → read → cancel', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: '{"title":"Lifecycle"}' });
    const { id } = await r.json();
    assert.match(id, /^task-\d+$/);

    // set routing fields (sanitized + validated)
    r = await fetch(`${base}/api/cards/${id}/set${q}`, { method: 'POST', headers: h, body: '{"assignee":"alice","agent":"codex","build_profile":"long"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/cards/${id}${q}`, { headers: { 'x-todomd-token': srv.token } });
    const card = await r.json();
    assert.equal(card.data.assignee, 'alice');
    assert.equal(card.data.agent, 'codex');
    assert.equal(card.data.build_profile, 'long');
    assert.deepEqual(card.recovery, {
      resume_build: false,
      restart_build: false,
      retry_verification: false,
      return_to_build: false,
      reset_attempts: false,
      build_profile: 'long',
      build_limits: { max_slices: 6, budget_minutes: 120 },
    });

    // invalid agent → 400
    r = await fetch(`${base}/api/cards/${id}/set${q}`, { method: 'POST', headers: h, body: '{"agent":"bogus"}' });
    assert.equal(r.status, 400);

    // legal human move Review→Plan (budget: no agent spawned)
    r = await fetch(`${base}/api/cards/${id}/move${q}`, { method: 'POST', headers: h, body: '{"status":"Plan"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/cards/${id}${q}`, { headers: { 'x-todomd-token': srv.token } });
    assert.equal((await r.json()).data.status, 'Plan');

    // illegal move into an orchestrator-only column → 400
    r = await fetch(`${base}/api/cards/${id}/move${q}`, { method: 'POST', headers: h, body: '{"status":"Done"}' });
    assert.equal(r.status, 400);

    // cancel with no live run → 400
    r = await fetch(`${base}/api/cards/${id}/cancel${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 400);

    // recovery endpoints exist but reject ineligible cards without moving them
    r = await fetch(`${base}/api/cards/${id}/resume-build${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/cards/${id}/restart-build${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/cards/${id}/instruction${q}`, {
      method: 'POST', headers: h, body: '{"instruction":"Preserve the public API while repairing the implementation."}',
    });
    assert.equal(r.status, 200, 'a handoff can be saved independently of a status change');
    assert.match(fs.readFileSync(path.join(repo, '.todomd', 'local', 'card-instructions', `${id}.md`), 'utf8'),
      /Preserve the public API/);
    r = await fetch(`${base}/api/cards/${id}/return-build${q}`, {
      method: 'POST', headers: h, body: '{"instruction":"repair it"}',
    });
    assert.equal(r.status, 400, 'the guarded return endpoint refuses an ineligible card');

    // GET a missing card → 404
    assert.equal((await fetch(`${base}/api/cards/task-9999${q}`, { headers: { 'x-todomd-token': srv.token } })).status, 404);

    // model picker pulls suggestions for the chosen vendor (CLI --help + fallback)
    r = await fetch(`${base}/api/models${q}&agent=claude`, { headers: { 'x-todomd-token': srv.token } });
    const { models } = await r.json();
    assert.ok(Array.isArray(models) && models.includes('sonnet'), 'models list returned for the vendor');
  } finally { srv.close(); }
});

test('API reorder persists same-column priority and rejects cross-column targets', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    writeCard(repo, 'task-0001', { status: 'Planned' });
    writeCard(repo, 'task-0002', { status: 'Planned' });
    writeCard(repo, 'task-0003', { status: 'Planned' });
    writeCard(repo, 'task-0004', { status: 'Review' });

    let r = await fetch(`${base}/api/cards/task-0003/reorder${q}`, {
      method: 'POST', headers: h, body: '{"beforeId":"task-0001"}',
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).order, ['task-0003', 'task-0001', 'task-0002']);
    assert.equal(readCard(repo, 'task-0003').data.board_order, 1);
    assert.equal(readCard(repo, 'task-0001').data.board_order, 2);
    assert.equal(readCard(repo, 'task-0002').data.board_order, 3);

    r = await fetch(`${base}/api/cards/task-0003/reorder${q}`, {
      method: 'POST', headers: h, body: '{"beforeId":"task-0004"}',
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /same column/);

    r = await fetch(`${base}/api/cards/task-0003/reorder${q}`, {
      method: 'POST', headers: h, body: '{"beforeId":{"bad":true}}',
    });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

test('API attachments + /api/file containment, projects, commands, queue controls', async () => {
  isolateHome();
  const { repo, base, srv, q, name } = await boot();
  const tok = srv.token;
  const h = { 'x-todomd-token': tok, origin: base };
  try {
    // a card to attach to
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"title":"Attach me"}' });
    const { id } = await r.json();

    // upload an attachment
    r = await fetch(`${base}/api/cards/${id}/attach${q}`, { method: 'POST', headers: { ...h, 'x-filename': 'note.txt' }, body: 'hello attachment' });
    assert.equal(r.status, 200);
    const att = await r.json();
    assert.ok(att.path.startsWith('.todomd/attachments/'), 'stored under attachments/');

    // fetch it back via /api/file (?p=<relpath>)
    r = await fetch(`${base}/api/file${q}&p=${encodeURIComponent(att.path)}`, { headers: { 'x-todomd-token': tok } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello attachment');

    // path traversal is contained → 404
    r = await fetch(`${base}/api/file${q}&p=${encodeURIComponent('../../../../etc/passwd')}`, { headers: { 'x-todomd-token': tok } });
    assert.equal(r.status, 404);
    // a sibling-prefix outside attachments → 404
    r = await fetch(`${base}/api/file${q}&p=${encodeURIComponent('.todomd/config.yml')}`, { headers: { 'x-todomd-token': tok } });
    assert.equal(r.status, 404);

    // projects: list includes ours, add another by path
    r = await fetch(`${base}/api/projects`, { headers: { 'x-todomd-token': tok } });
    assert.ok((await r.json()).projects.includes(name));
    const repo2 = makeRepo();
    // paste artifacts are forgiven: wrapping quotes + surrounding whitespace
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ path: `  "${repo2}"  ` }) });
    assert.equal(r.status, 200);
    // add with a missing path → 400 with the clearer message
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"path":""}' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"path":"/no/such/folder/xyz123"}' });
    assert.match((await r.json()).error, /couldn't find that folder/);

    // commands: list, read the locked core + editable region, write ONLY the custom region
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    assert.ok(Array.isArray((await r.json()).commands));
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { headers: { 'x-todomd-token': tok } });
    const before = await r.json();
    assert.equal(r.status, 200);
    assert.ok(before.locked.includes('stub'), 'returns the locked core');
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"custom":"follow our naming conventions"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { headers: { 'x-todomd-token': tok } });
    const after = await r.json();
    assert.match(after.custom, /naming conventions/, 'the custom region persisted');
    assert.ok(after.locked.includes('stub'), 'the locked core is preserved');
    // a bad command name (not [\w-]) is not routed → 404
    assert.equal((await fetch(`${base}/api/commands/todomd..evil${q}`, { headers: { 'x-todomd-token': tok } })).status, 404);

    // project queue pause is persistent local state exposed on the board;
    // resume clears it without touching cards or worktrees
    r = await fetch(`${base}/api/queue/pause${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).queue_paused, true);
    r = await fetch(`${base}/api/queue/kick${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 400, 'an explicit queue run respects the project pause');
    assert.match((await r.json()).error, /queue is paused/);
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': tok } });
    assert.equal((await r.json()).usage.queue_paused, true);
    assert.equal(fs.existsSync(path.join(repo, '.todomd/local/queue-paused')), true);

    r = await fetch(`${base}/api/queue/resume${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).queue_paused, false);
    r = await fetch(`${base}/api/queue/kick${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /budget-mode work/, 'the endpoint cannot bypass dispatcher mode');
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': tok } });
    assert.equal((await r.json()).usage.queue_paused, false);

    // legacy quota-resume action remains compatible (no-op when unpaused)
    r = await fetch(`${base}/api/resume-queues${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});

test('API per-column routing: /api/commands carries stage routing; /api/stages saves it', async () => {
  isolateHome();
  const { name, base, srv, q } = await boot();
  const tok = srv.token, viewer = deviceToken('token-viewer');
  const h = { 'x-todomd-token': tok, 'content-type': 'application/json', origin: base };
  try {
    // the commands list flags stage columns (with agent/model) vs triage/dispatch,
    // and exposes the board defaults for the "inherits" hint
    let r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    let body = await r.json();
    assert.equal(body.defaultAgent, 'claude');
    const build = body.commands.find((c) => c.column === 'Build');
    assert.equal(build.stage, true);
    assert.equal(build.agent, ''); // no column override yet → inherits
    assert.equal(body.commands.find((c) => c.column === 'Triage (auto)').stage, false);

    // set Build → codex / gpt-5-codex
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'codex', model: 'gpt-5-codex' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    body = await r.json();
    const build2 = body.commands.find((c) => c.column === 'Build');
    assert.equal(build2.agent, 'codex');
    assert.equal(build2.model, 'gpt-5-codex');

    // clearing the agent falls back to inherit
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: '' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    assert.equal((await r.json()).commands.find((c) => c.column === 'Build').agent, '');

    // Gemini is a first-class Agent Gateway choice and its alias normalizes.
    // Kimi stays fail-closed until its installed CLI adapter is compatible.
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'gemini' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'agy' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    assert.equal((await r.json()).commands.find((c) => c.column === 'Build').agent, 'gemini');
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Nope', agent: 'codex' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'unknown-agent' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'kimi' }) });
    assert.equal(r.status, 400);

    // viewer cannot write routing → 403
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: { 'x-todomd-token': viewer, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ column: 'Build', agent: 'codex' }) });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('API /api/open: opens a referenced repo file via the OS opener, with containment + type guards', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const tok = srv.token, viewer = deviceToken('token-viewer');
  const h = { 'x-todomd-token': tok, 'content-type': 'application/json', origin: base };
  // point the opener at a harmless script that records the file it was handed
  const home = process.env.TODOMD_HOME;
  const marker = path.join(home, 'opened.txt');
  const opener = path.join(home, 'opener.sh');
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${marker}"\n`, { mode: 0o755 });
  process.env.TODOMD_OPENER = opener;
  try {
    // an existing repo file → 200, and the opener was invoked on the resolved path
    let r = await fetch(`${base}/api/open${q}`, { method: 'POST', headers: h, body: JSON.stringify({ path: 'src/calc.js' }) });
    assert.equal(r.status, 200);
    for (let i = 0; i < 25 && !fs.existsSync(marker); i++) await new Promise((res) => setTimeout(res, 40));
    assert.match(fs.readFileSync(marker, 'utf8'), /src\/calc\.js\s*$/m);

    // path traversal is refused (stays inside the repo)
    r = await fetch(`${base}/api/open${q}`, { method: 'POST', headers: h, body: JSON.stringify({ path: '../../../../etc/hosts' }) });
    assert.equal(r.status, 400);
    // a nonexistent file → 400
    r = await fetch(`${base}/api/open${q}`, { method: 'POST', headers: h, body: JSON.stringify({ path: 'nope/missing.js' }) });
    assert.equal(r.status, 400);
    // an execution-capable type is refused even though it exists
    fs.writeFileSync(path.join(repo, 'danger.command'), '#!/bin/sh\necho hi\n');
    r = await fetch(`${base}/api/open${q}`, { method: 'POST', headers: h, body: JSON.stringify({ path: 'danger.command' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /executable/);
    // viewer cannot open files → 403
    r = await fetch(`${base}/api/open${q}`, { method: 'POST', headers: { 'x-todomd-token': viewer, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ path: 'src/calc.js' }) });
    assert.equal(r.status, 403);
  } finally { delete process.env.TODOMD_OPENER; srv.close(); }
});

test('API archive hides/restores a card; DELETE removes it; viewer cannot', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const tok = srv.token, viewer = deviceToken('token-viewer');
  const h = { 'x-todomd-token': tok, 'content-type': 'application/json', origin: base };
  const ids = async (extra = '') => (await (await fetch(`${base}/api/board${q}${extra}`, { headers: { 'x-todomd-token': tok } })).json()).cards.map((c) => c.id);
  const mk = async (t) => (await (await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: JSON.stringify({ title: t }) })).json()).id;
  try {
    const a = await mk('archive me');
    const d = await mk('delete me');

    // archive → hidden from the default board, visible with ?archived=1
    let r = await fetch(`${base}/api/cards/${a}/archive${q}`, { method: 'POST', headers: h, body: '{"archived":true}' });
    assert.equal(r.status, 200);
    assert.ok(!(await ids()).includes(a), 'archived card hidden from the board');
    assert.ok((await ids('&archived=1')).includes(a), 'archived card shown with ?archived=1');

    // restore
    r = await fetch(`${base}/api/cards/${a}/archive${q}`, { method: 'POST', headers: h, body: '{"archived":false}' });
    assert.equal(r.status, 200);
    assert.ok((await ids()).includes(a), 'restored to the board');

    // viewer cannot delete (read-only) → 403
    r = await fetch(`${base}/api/cards/${d}${q}`, { method: 'DELETE', headers: { 'x-todomd-token': viewer, origin: base } });
    assert.equal(r.status, 403);

    // full token deletes → 200, then gone (404)
    r = await fetch(`${base}/api/cards/${d}${q}`, { method: 'DELETE', headers: { 'x-todomd-token': tok, origin: base } });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${base}/api/cards/${d}${q}`, { headers: { 'x-todomd-token': tok } })).status, 404);
    assert.ok(!(await ids('&archived=1')).includes(d), 'deleted card gone even from the archived view');
  } finally { srv.close(); }
});

test('API guards: oversized JSON body → 413; malformed card id → 400', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    // a >1 MB JSON body is refused before parsing
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'x'.repeat(1024 * 1024) }) });
    assert.equal(r.status, 413);
    // a normal body still works
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: '{"title":"fine"}' });
    assert.equal(r.status, 200);
    // ids that don't match the generator's format (task-NNNN) are 400 before any fs use
    for (const bad of ['bogus', '..x', 'task', 'task-', 'task-0001.md']) {
      r = await fetch(`${base}/api/cards/${bad}${q}`, { headers: { 'x-todomd-token': srv.token } });
      assert.equal(r.status, 400, `id ${bad}`);
    }
    // a well-formed but missing id is still a 404
    r = await fetch(`${base}/api/cards/task-9999${q}`, { headers: { 'x-todomd-token': srv.token } });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});

test('API DELETE epic with a building child returns 400', async () => {
  isolateHome();
  const marker = path.join(tmp('del-epic'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  const repo = makeRepo(); // launcher mode
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${srv.port}`;
  const q = `?project=${encodeURIComponent(name)}`;
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  const p = { name, path: repo };

  writeCard(repo, 'task-0001', { status: 'Queue', extra: 'epic: true\nchildren: [task-0002]\n' });
  writeCard(repo, 'task-0002', { status: 'Planned', extra: 'parent: task-0001\n' });

  try {
    // start the child build (hangs until SIGTERM)
    await pipeline.humanMove(p, 'task-0002', 'Queue');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });

    // DELETE on the epic should be refused while a child is building
    const r = await fetch(`${base}/api/cards/task-0001${q}`, { method: 'DELETE', headers: h });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /child card is building/);

    // cancel the hanging build to clean up
    await pipeline.humanMove(p, 'task-0002', 'Review');
  } finally {
    srv.close();
    clearFakeAgent();
  }
});

test('WebSocket: a governor-deferred admission broadcasts run-state deferred + reason to a real connected client', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  // An impossible-to-satisfy defer threshold guarantees a real sample always
  // breaches it, so the deferral (and the broadcast it drives) is
  // deterministic rather than depending on this machine's actual load.
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('resources:\n  enabled: false\n',
    'resources:\n  enabled: true\n  cpu:\n    defer: 0.001\n    resume: 0.0005\n    critical: 100\n'));
  addProject(repo);
  const name = path.basename(repo);
  const srv = await startServer({ port: await freePort() });
  const p = { name, path: repo };
  writeCard(repo, 'task-0001', { status: 'Planned' });

  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const messages = [];
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch { /* ignore non-JSON frames */ } });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(
      () => messages.some((m) => m.type === 'run-state' && m.card === 'task-0001' && m.state === 'deferred'),
      { timeout: BUDGET.chain },
    );
    const deferred = messages.find((m) => m.type === 'run-state' && m.card === 'task-0001' && m.state === 'deferred');
    assert.equal(deferred.project, name);
    assert.match(deferred.reason, /cpu/, 'the real WS broadcast carries the deferral reason, not just an in-process callback');
    assert.equal(readCard(repo, 'task-0001').data.status, 'Queue', 'no child was ever spawned while deferred');
  } finally {
    ws.close();
    srv.close();
    clearFakeAgent();
  }
});

test('WebSocket: a capacity-blocked CI handoff broadcasts queued instead of leaving Build running', async () => {
  isolateHome();
  scheduler.resetState();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('concurrency: 1', 'concurrency: 2')
    + 'scheduler:\n  global: 2\n  columns:\n    CI: 1\n');
  addProject(repo);
  const name = path.basename(repo);
  const p = { name, path: repo };
  const srv = await startServer({ port: await freePort() });
  writeCard(repo, 'task-0001', { status: 'Planned' });

  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const messages = [];
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ } });
  let releaseHolder;
  const holder = scheduler.schedule(p, 'ci-holder', 'CI', () => new Promise((resolve) => {
    releaseHolder = resolve;
  }));

  try {
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Queue')).ok, true);
    await until(() => messages.some((m) => m.type === 'run-state'
      && m.card === 'task-0001' && m.state === 'queued' && m.stage === 'CI'),
    { timeout: BUDGET.chain });
    const states = messages.filter((m) => m.type === 'run-state' && m.card === 'task-0001');
    assert.deepEqual(states.at(-1), {
      type: 'run-state', project: name, card: 'task-0001', state: 'queued', stage: 'CI',
    });

    releaseHolder();
    await holder;
    await until(() => readCard(repo, 'task-0001').data.status === 'Done', { timeout: BUDGET.chain });
  } finally {
    releaseHolder?.();
    ws.close();
    srv.close();
    pipeline.forgetProject(name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('API prompt editor: shared half is committed, local half never is', async () => {
  isolateHome();
  const { repo, base, srv, q } = await boot();
  const viewer = deviceToken('token-viewer');
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  try {
    const before = head();
    // one save carries both halves
    let r = await fetch(`${base}/api/commands/todomd-build${q}`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ custom: 'shared: always run lint', local: 'private: staging host is internal-only' }),
    });
    assert.equal(r.status, 200);

    // both come back for the editor
    r = await fetch(`${base}/api/commands/todomd-build${q}`, { headers: { 'x-todomd-token': srv.token } });
    const parts = await r.json();
    assert.match(parts.custom, /always run lint/);
    assert.match(parts.local, /staging host is internal-only/);

    // the shared half landed in the committed file; the local half did NOT
    const committed = fs.readFileSync(path.join(repo, '.claude/commands/todomd-build.md'), 'utf8');
    assert.match(committed, /always run lint/);
    assert.doesNotMatch(committed, /staging host/, 'private text must never enter a committed file');
    assert.notEqual(head(), before, 'the shared edit was committed');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).includes('.todomd/local'), false,
      'the local file is gitignored, so git never sees it');

    // a viewer can neither read nor write the prompt (local text is private)
    assert.equal((await fetch(`${base}/api/commands/todomd-build${q}`, { headers: { 'x-todomd-token': viewer } })).status, 403);
    assert.equal((await fetch(`${base}/api/commands/todomd-build${q}`, {
      method: 'POST', headers: { 'x-todomd-token': viewer, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ local: 'sneak' }),
    })).status, 403);
  } finally { srv.close(); }
});

test('API runlog + models require full access: an authed viewer gets 403, never 401', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const viewer = deviceToken('token-viewer');
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: '{"title":"runlog gate"}' });
    const { id } = await r.json();
    // The raw run stream can carry command output — viewer denied, full 200.
    // It must be 403: the UI turns ANY 401 into "session expired — restart
    // todomd", so a 401 here nags every viewer on the default QR link each
    // time they open a card drawer. 401 is reserved for a bad/absent token.
    r = await fetch(`${base}/api/cards/${id}/runlog${q}`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 403, 'authenticated-but-not-permitted is 403, not 401');
    r = await fetch(`${base}/api/cards/${id}/runlog${q}`, { headers: { 'x-todomd-token': srv.token } });
    assert.equal(r.status, 200);
    // /api/models spawns blocking CLI probes — viewers can't reach it
    r = await fetch(`${base}/api/models${q}&agent=claude`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 403);
    // a genuinely bad token still gets 401 (that IS the session-expired signal)
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': 'deadbeef'.repeat(4) } });
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('API attachment uploads are capped: the 5th concurrent upload gets a 429', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, origin: base, 'x-filename': 'f.txt' };
  try {
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"title":"cap me"}' });
    const { id } = await r.json();
    // 4 uploads whose bodies stay open until released → all upload slots held
    const controllers = [];
    const pending = [];
    for (let i = 0; i < 4; i++) {
      const body = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('x')); controllers.push(c); },
      });
      pending.push(fetch(`${base}/api/cards/${id}/attach${q}`, { method: 'POST', headers: h, body, duplex: 'half' }));
    }
    await new Promise((res) => setTimeout(res, 500)); // let the four register in-flight
    const fifth = await fetch(`${base}/api/cards/${id}/attach${q}`, { method: 'POST', headers: h, body: 'x' });
    assert.equal(fifth.status, 429);
    assert.match((await fifth.json()).error, /too many concurrent uploads/);
    // release the four; slots free up and a fresh upload is accepted again
    for (const c of controllers) c.close();
    await Promise.all(pending);
    r = await fetch(`${base}/api/cards/${id}/attach${q}`, { method: 'POST', headers: h, body: 'after' });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});

/* ── email push API (task-0025): same screen as mailbox polling ── */

const rawEmail = (lines) => lines.join('\r\n');
const RAW_PUSH_NEWSLETTER = rawEmail([
  'From: Shop News <news@shop.example.com>',
  'To: intake@example.com',
  'Subject: Summer sale is on',
  'Message-ID: <push-newsletter-1@shop.example.com>',
  'List-Unsubscribe: <mailto:leave@shop.example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Big savings this week on everything in the store. Come take a look.',
  '',
]);
const RAW_PUSH_HTML_ONLY = rawEmail([
  'From: Web Form <forms@example.com>',
  'To: intake@example.com',
  'Subject: New website update',
  'Message-ID: <push-html-only-1@example.com>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>This message has enough visible content to look actionable after HTML-to-text conversion.</p>',
  '',
]);
const RAW_PUSH_BUG_REPORT = rawEmail([
  'From: Jane Doe <jane@example.com>',
  'To: intake@example.com',
  'Subject: Export button 500s on filtered reports',
  'Message-ID: <push-real-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Repro: open /reports, filter by month, click Export. Server returns a 500.',
  '',
]);

const RAW_PUSH_BINARY_ATTACHMENT = Buffer.concat([
  Buffer.from(rawEmail([
    'From: Jane Doe <jane@example.com>',
    'To: intake@example.com',
    'Subject: Binary attachment remains intact',
    'Message-ID: <push-binary-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="raw-boundary"',
    '',
    '--raw-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please inspect the attached binary reproduction file for this issue.',
    '--raw-boundary',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="blob.bin"',
    'Content-Transfer-Encoding: binary',
    '',
    '',
  ]), 'ascii'),
  Buffer.from([0, 127, 128, 255, 65]),
  Buffer.from('\r\n--raw-boundary--\r\n', 'ascii'),
]);

test('email push API: applies the same screen as mailbox polling and reports the verdict', async () => {
  isolateHome();
  const { repo, name, base, srv, q } = await boot();
  const full = { 'x-todomd-token': srv.token, origin: base, 'content-type': 'message/rfc822' };
  const push = (raw) => fetch(`${base}/api/projects/${encodeURIComponent(name)}/email`, { method: 'POST', headers: full, body: raw });
  try {
    const boardBefore = await (await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } })).json();
    const startCount = boardBefore.cards.length;

    // spam — the exact List-Unsubscribe signal pollSource screens on — creates no card
    let r = await push(RAW_PUSH_NEWSLETTER);
    assert.equal(r.status, 200);
    let out = await r.json();
    assert.equal(out.verdict, 'spam');
    assert.equal('id' in out, false, 'a spam verdict reports no card id');
    assert.match(out.reason, /List-Unsubscribe/);
    let board = await (await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } })).json();
    assert.equal(board.cards.length, startCount, 'no card was created for the spam push');

    // webhook retries remain idempotent while still reporting the screen result
    r = await push(RAW_PUSH_NEWSLETTER);
    assert.equal(r.status, 200);
    out = await r.json();
    assert.equal(out.verdict, 'spam', 'a retry preserves the original screen verdict');
    assert.equal(out.duplicate, true);
    assert.equal('id' in out, false);
    board = await (await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } })).json();
    assert.equal(board.cards.length, startCount, 'retrying spam still creates no card');

    // unclear — HTML-only body — held in Needs Human, not dropped
    r = await push(RAW_PUSH_HTML_ONLY);
    assert.equal(r.status, 200);
    out = await r.json();
    assert.equal(out.verdict, 'unclear');
    assert.match(out.id, /^task-\d+$/);
    const held = readCard(repo, out.id);
    assert.equal(held.data.status, 'Needs Human');
    assert.match(held.data.needs_human_reason, /HTML-only/i);

    // work — an ordinary bug report still creates a normal Review card
    r = await push(RAW_PUSH_BUG_REPORT);
    assert.equal(r.status, 200);
    out = await r.json();
    assert.equal(out.verdict, 'work');
    assert.match(out.id, /^task-\d+$/);
    const worked = readCard(repo, out.id);
    assert.equal(worked.data.status, 'Review');
    assert.equal(worked.data.source, 'email');
    const workId = out.id;

    // The raw RFC 5322 endpoint must not decode the request as UTF-8 before
    // mailparser sees it: binary MIME attachments need byte-for-byte fidelity.
    r = await push(RAW_PUSH_BINARY_ATTACHMENT);
    assert.equal(r.status, 200);
    out = await r.json();
    assert.equal(out.verdict, 'work');
    assert.deepEqual(
      [...fs.readFileSync(path.join(repo, '.todomd', 'attachments', out.id, 'blob.bin'))],
      [0, 127, 128, 255, 65],
    );

    r = await push(RAW_PUSH_BUG_REPORT);
    out = await r.json();
    assert.equal(out.verdict, 'work', 'a work retry preserves the original screen verdict');
    assert.equal(out.duplicate, true);
    assert.equal(out.id, workId, 'the retry reports the original card instead of creating another');

    board = await (await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } })).json();
    assert.equal(board.cards.length, startCount + 3, 'exactly the unclear and two work pushes created cards');

    // a viewer token cannot push (mutating, full access only)
    const viewer = deviceToken('token-viewer');
    r = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/email`, {
      method: 'POST', headers: { 'x-todomd-token': viewer, origin: base, 'content-type': 'message/rfc822' }, body: RAW_PUSH_BUG_REPORT,
    });
    assert.equal(r.status, 403);

    // unknown project → 404; malformed body → 400
    r = await fetch(`${base}/api/projects/nope/email`, { method: 'POST', headers: full, body: RAW_PUSH_BUG_REPORT });
    assert.equal(r.status, 404);
    r = await push('');
    assert.equal(r.status, 400);

    // the audit endpoint returns the screened-out records newest first — the
    // accepted bug report is a card on the board, not screened email
    r = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/intake-audit`, { headers: { 'x-todomd-token': srv.token } });
    assert.equal(r.status, 200);
    const { records } = await r.json();
    assert.equal(records.length, 2);
    assert.equal(records[0].subject, 'New website update', 'most recent screened-out push is first');
    assert.equal(records[0].verdict, 'unclear');
    assert.equal(records[1].subject, 'Summer sale is on');
    assert.equal(records[1].verdict, 'spam');
    assert.equal(records.some((rec) => rec.verdict === 'work'), false, 'accepted mail is not listed as screened');
    assert.equal('intakeKey' in records[0], false, 'the internal dedup key is not exposed to the client');

    // a viewer token cannot read the audit log either
    r = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/intake-audit`, { headers: { 'x-todomd-token': viewer } });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

// The audit file logs every verdict, but this endpoint is the Screened email
// view. A board taking real work all day must not push its held mail out of the
// bounded response.
test('intake-audit endpoint: a burst of newer accepted mail cannot hide screened-out messages', async () => {
  isolateHome();
  const { repo, name, base, srv } = await boot();
  try {
    fs.mkdirSync(path.join(repo, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.todomd', 'intake-audit.jsonl'), [
      JSON.stringify({ timestamp: '2026-08-01T08:00:00.000Z', source: 'push', from: 'Shop <news@shop.example.com>', subject: 'Summer sale is on', verdict: 'spam', reason: 'has a List-Unsubscribe header', card: '' }),
      JSON.stringify({ timestamp: '2026-08-01T08:30:00.000Z', source: 'push', from: 'Web Form <forms@example.com>', subject: 'New website update', verdict: 'unclear', reason: 'HTML-only body with no text part', card: '' }),
      // 60 accepted messages, all NEWER than both screened-out records and more
      // numerous than the endpoint's default limit of 50
      ...Array.from({ length: 60 }, (_, i) => JSON.stringify({
        timestamp: `2026-08-01T09:${String(i).padStart(2, '0')}:00.000Z`,
        source: 'push', from: 'Jane Doe <jane@example.com>', subject: `Bug report ${i}`,
        verdict: 'work', reason: 'No spam or unclear signals matched', card: `task-${1000 + i}`,
      })),
    ].join('\n') + '\n');

    const r = await fetch(`${base}/api/projects/${encodeURIComponent(name)}/intake-audit`, { headers: { 'x-todomd-token': srv.token } });
    assert.equal(r.status, 200);
    const { records } = await r.json();
    assert.deepEqual(records.map((rec) => rec.subject), ['New website update', 'Summer sale is on'],
      'both screened-out messages survive the default limit, newest first');
    assert.equal(records.some((rec) => rec.verdict === 'work'), false);
  } finally { srv.close(); }
});

// Handled keys retain 5000 entries while the audit log trims at 500, so a
// pushed message can outlive its own audit line. A webhook retry in that window
// still has to answer with the screen verdict, not "duplicate".
test('email push API: a retry reports the screen verdict after its audit line rotates out', async () => {
  isolateHome();
  const { repo, name, base, srv, q } = await boot();
  const full = { 'x-todomd-token': srv.token, origin: base, 'content-type': 'message/rfc822' };
  const push = (raw) => fetch(`${base}/api/projects/${encodeURIComponent(name)}/email`, { method: 'POST', headers: full, body: raw });
  const auditPath = path.join(repo, '.todomd', 'intake-audit.jsonl');
  const cardCount = async () =>
    (await (await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': srv.token } })).json()).cards.length;
  // drop every audit line, leaving the handled key as the sole surviving record
  const rotateAuditAway = () => fs.writeFileSync(auditPath, '');
  try {
    const startCount = await cardCount();

    let out = await (await push(RAW_PUSH_NEWSLETTER)).json();
    assert.equal(out.verdict, 'spam');
    rotateAuditAway();

    out = await (await push(RAW_PUSH_NEWSLETTER)).json();
    assert.equal(out.verdict, 'spam', 'the spam verdict survives audit rotation');
    assert.equal(out.duplicate, true);
    assert.equal('id' in out, false, 'a spam retry still reports no card id');
    assert.match(out.reason, /List-Unsubscribe/);
    assert.equal(await cardCount(), startCount, 'the retry created no card');

    out = await (await push(RAW_PUSH_BUG_REPORT)).json();
    assert.equal(out.verdict, 'work');
    const workId = out.id;
    rotateAuditAway();

    out = await (await push(RAW_PUSH_BUG_REPORT)).json();
    assert.equal(out.verdict, 'work', 'the work verdict survives audit rotation');
    assert.equal(out.duplicate, true);
    assert.equal(out.id, workId, 'the retry still reports the original card');
    assert.equal(await cardCount(), startCount + 1, 'the retry created no second card');
  } finally { srv.close(); }
});


test('API preserves actionable parse and dependency diagnostics on read, approve and queue kick', async () => {
  isolateHome();
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  addProject(repo);
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001-bad.md'),
    '---\nid: task-0001\ntitle: Bad: title\nstatus: Planned\n---\n');
  writeCard(repo, 'task-0002', { status: 'Queue', deps: ['P1-01'] });
  const server = await startServer({ port: await freePort() });
  const base = `http://127.0.0.1:${server.port}`;
  const q = `?project=${encodeURIComponent(path.basename(repo))}`;
  const headers = { 'x-todomd-token': server.token, 'content-type': 'application/json' };
  try {
    const board = await (await fetch(`${base}/api/board${q}`, { headers })).json();
    assert.equal(board.cards[0].id, 'task-0001');
    assert.equal(board.cards[0].parseErrorDetail.line, 3);
    const read = await (await fetch(`${base}/api/cards/task-0001${q}`, { headers })).json();
    assert.match(read.parseError, /frontmatter parse error at line 3/);
    const move = await fetch(`${base}/api/cards/task-0001/move${q}`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'Queue' }),
    });
    assert.equal(move.status, 400);
    assert.equal((await move.json()).code, 'frontmatter_parse_error');
    const kick = await (await fetch(`${base}/api/queue/kick${q}`, { method: 'POST', headers })).json();
    assert.equal(kick.enqueued, 0);
    assert.equal(kick.cards.find((c) => c.id === 'task-0001').code, 'frontmatter_parse_error');
    assert.equal(kick.cards.find((c) => c.id === 'task-0002').code, 'unknown_dependencies');
  } finally { server.close(); }
});


test('API difficulty routing: /api/stages validates and saves the Build map; /api/commands reads it back', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const tok = srv.token;
  const h = { 'x-todomd-token': tok, 'content-type': 'application/json', origin: base };
  try {
    let r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h,
      body: JSON.stringify({ column: 'Build', route_by_complexity: { low: { agent: 'gemini', model: 'gemini-3.7-flash-high' }, medium: { agent: '' } } }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    const build = (await r.json()).commands.find((c) => c.column === 'Build');
    assert.deepEqual(build.route_by_complexity, { low: { agent: 'gemini', model: 'gemini-3.7-flash-high' } });
    // only Build routes by difficulty; unknown levels and wrong-family models are refused
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Verify', route_by_complexity: { low: { agent: 'gemini' } } }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', route_by_complexity: { huge: { agent: 'gemini' } } }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', route_by_complexity: { low: { agent: 'gemini', model: 'opus' } } }) });
    assert.equal(r.status, 400);
    // clearing
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', route_by_complexity: {} }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    assert.deepEqual((await r.json()).commands.find((c) => c.column === 'Build').route_by_complexity, {});
  } finally { await srv.close(); }
});
