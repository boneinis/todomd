import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolateHome, makeRepo } from './helpers.js';
import { addProject } from '../src/registry.js';
import { startServer } from '../src/server.js';

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
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ path: repo2 }) });
    assert.equal(r.status, 200);
    // add with a missing path → 400
    r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"path":""}' });
    assert.equal(r.status, 400);

    // commands: list, read, write a column prompt
    r = await fetch(`${base}/api/commands${q}`, { headers: { 'x-todomd-token': tok } });
    assert.ok(Array.isArray((await r.json()).commands));
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { headers: { 'x-todomd-token': tok } });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"content":"---\\n---\\ncustom plan body\\n"}' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/commands/todomd-plan${q}`, { headers: { 'x-todomd-token': tok } });
    assert.match((await r.json()).content, /custom plan body/, 'the edited prompt persisted');
    // a bad command name (not [\w-]) is not routed → 404
    assert.equal((await fetch(`${base}/api/commands/todomd..evil${q}`, { headers: { 'x-todomd-token': tok } })).status, 404);

    // resume-queues (no-op when nothing paused) → 200
    r = await fetch(`${base}/api/resume-queues${q}`, { method: 'POST', headers: h });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
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
