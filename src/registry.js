import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REG_DIR = path.join(os.homedir(), '.todomd');
const REG_FILE = path.join(REG_DIR, 'projects.json');

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
  } catch {
    return { projects: [] };
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(REG_DIR, { recursive: true });
  fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2) + '\n');
}

export function listProjects() {
  const reg = readRegistry();
  return reg.projects.filter((p) =>
    fs.existsSync(path.join(p.path, '.todomd', 'tasks'))
  );
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
