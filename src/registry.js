import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// resolved lazily so TODOMD_HOME set after import (and in tests) is honored
const regDir = () => path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd');
const regFile = () => path.join(regDir(), 'projects.json');

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(regFile(), 'utf8'));
  } catch {
    return { projects: [] };
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(regDir(), { recursive: true });
  // atomic write (tmp + rename) so a crash mid-write can't truncate projects.json
  // and drop the whole project list
  const tmp = `${regFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, regFile());
}

export function listProjects() {
  const reg = readRegistry();
  return reg.projects.filter((p) =>
    fs.existsSync(path.join(p.path, '.todomd', 'tasks'))
  );
}

// Unregister a project by name (does NOT delete its board files).
export function removeProject(name) {
  const reg = readRegistry();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.name !== name);
  if (reg.projects.length !== before) writeRegistry(reg);
  return before - reg.projects.length;
}

export function addProject(repoPath) {
  const abs = path.resolve(repoPath);
  const reg = readRegistry();
  if (reg.projects.some((p) => p.path === abs)) return abs;
  // names must be unique — they are the API's project key
  const base = path.basename(abs);
  let name = base;
  for (let i = 2; reg.projects.some((p) => p.name === name); i++) name = `${base}-${i}`;
  reg.projects.push({ name, path: abs });
  writeRegistry(reg);
  return abs;
}
