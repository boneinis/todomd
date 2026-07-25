import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateHome } from './helpers.js';
import { addProject, listProjects } from '../src/registry.js';

// a board-bearing dir at an arbitrary path
function boardDir(p) {
  fs.mkdirSync(path.join(p, '.todomd/tasks'), { recursive: true });
  return p;
}

test('addProject dedupes by absolute path', () => {
  isolateHome();
  const a = boardDir(path.join(os.tmpdir(), `reg-${process.pid}-a`));
  addProject(a);
  addProject(a);
  assert.equal(listProjects().filter((p) => p.path === a).length, 1);
});

test('same-basename repos in different parents get unique names', () => {
  isolateHome();
  const p1 = boardDir(path.join(os.tmpdir(), `reg-${process.pid}-x/api`));
  const p2 = boardDir(path.join(os.tmpdir(), `reg-${process.pid}-y/api`));
  addProject(p1);
  addProject(p2);
  const names = listProjects().map((p) => p.name).filter((n) => n.startsWith('api'));
  assert.deepEqual(names.sort(), ['api', 'api-2']);
});

test('listProjects skips registered dirs that no longer have a board', () => {
  isolateHome();
  const gone = path.join(os.tmpdir(), `reg-${process.pid}-gone`);
  boardDir(gone);
  addProject(gone);
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(listProjects().some((p) => p.path === gone), false);
});

// projects.json is a plain file a user can edit (or another tool can clobber).
// Every caller does reg.projects.filter/some — a shape that isn't {projects:[]}
// used to throw out of listProjects, which 500s every board request.
test('a malformed projects.json degrades to an empty registry instead of throwing', () => {
  const home = isolateHome();
  const file = path.join(home, '.todomd', 'projects.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ['[]', '{}', 'null', '{"projects":"nope"}', 'not json at all']) {
    fs.writeFileSync(file, bad);
    assert.deepEqual(listProjects(), [], `shape: ${bad}`);
  }
  // entries that aren't {name, path} are dropped; the good one survives
  const ok = boardDir(path.join(os.tmpdir(), `reg-${process.pid}-mixed`));
  fs.writeFileSync(file, JSON.stringify({ projects: [null, 'x', { name: 'n' }, { name: 'ok', path: ok }] }));
  assert.deepEqual(listProjects().map((p) => p.name), ['ok']);
  // and a later write repairs the file rather than compounding the damage
  addProject(boardDir(path.join(os.tmpdir(), `reg-${process.pid}-repair`)));
  assert.equal(listProjects().length, 2);
});

test('removeProject unregisters by name without touching board files', async () => {
  isolateHome();
  const a = boardDir(path.join(os.tmpdir(), `reg-${process.pid}-rm`));
  addProject(a);
  assert.equal(listProjects().some((p) => p.path === a), true);
  const { removeProject } = await import('../src/registry.js');
  const n = removeProject(path.basename(a));
  assert.equal(n, 1);
  assert.equal(listProjects().some((p) => p.path === a), false);
  assert.ok(fs.existsSync(path.join(a, '.todomd/tasks')), 'board files remain on disk');
});
