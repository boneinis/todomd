import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo, writeCard, useFakeAgent, clearFakeAgent, until, tmp, BUDGET } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';
import * as pipeline from '../src/pipeline.js';

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
    assert.equal((await r.json()).access, 'viewer');
    // viewer cannot mutate → 403 read-only
    r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: J(viewer, base), body: '{"title":"x"}' });
    assert.equal(r.status, 403);
    // full token reads as 'full', and the board carries the skill picker options
    r = await fetch(`${base}/api/board${q}`, { headers: { 'x-todomd-token': full } });
    const fullBoard = await r.json();
    assert.equal(fullBoard.access, 'full');
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
    // commands list requires full access → viewer 403
    assert.equal((await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': viewer } })).status, 403);
    // unknown project → 404
    assert.equal((await fetch(`${base}/api/board?project=nope`, { headers: { 'x-todomd-token': full } })).status, 404);
  } finally { srv.close(); }
});

test('API card lifecycle: create → set → move → read → cancel', async () => {
  isolateHome();
  const { base, srv, q } = await boot();
  const h = { 'x-todomd-token': srv.token, 'content-type': 'application/json', origin: base };
  try {
    let r = await fetch(`${base}/api/cards${q}`, { method: 'POST', headers: h, body: '{"title":"Lifecycle"}' });
    const { id } = await r.json();
    assert.match(id, /^task-\d+$/);

    // set routing fields (sanitized + validated)
    r = await fetch(`${base}/api/cards/${id}/set${q}`, { method: 'POST', headers: h, body: '{"assignee":"alice","agent":"codex"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/cards/${id}${q}`, { headers: { 'x-todomd-token': srv.token } });
    const card = await r.json();
    assert.equal(card.data.assignee, 'alice');
    assert.equal(card.data.agent, 'codex');

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

    // GET a missing card → 404
    assert.equal((await fetch(`${base}/api/cards/task-9999${q}`, { headers: { 'x-todomd-token': srv.token } })).status, 404);

    // model picker pulls suggestions for the chosen vendor (CLI --help + fallback)
    r = await fetch(`${base}/api/models${q}&agent=claude`, { headers: { 'x-todomd-token': srv.token } });
    const { models } = await r.json();
    assert.ok(Array.isArray(models) && models.includes('sonnet'), 'models list returned for the vendor');
  } finally { srv.close(); }
});

test('API attachments + /api/file containment, projects, commands, resume-queues', async () => {
  isolateHome();
  const { base, srv, q, name } = await boot();
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

    // resume-queues (no-op when nothing paused) → 200
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

    // unknown column → 400; bad agent → 400
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Nope', agent: 'codex' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/stages${q}`, { method: 'POST', headers: h, body: JSON.stringify({ column: 'Build', agent: 'gemini' }) });
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
