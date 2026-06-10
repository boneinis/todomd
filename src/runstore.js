import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// resolved lazily so a TODOMD_HOME override (and tests) take effect
const dir = () => path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd');
const RUNS_FILE = () => path.join(dir(), 'runs.json');
const LEDGER_FILE = () => path.join(dir(), 'ledger.json');

// key `${project}:${cardId}` → { project, card, stage, pid, sessionId,
//   startedAt, prevStatus, attempt }
export const runs = new Map();

export function runKey(project, cardId) {
  return `${project}:${cardId}`;
}

// atomic write so a crash mid-write can't truncate runs.json (which would
// silently disable orphan-kill on the next boot)
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function persistRuns() {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    writeAtomic(RUNS_FILE(), JSON.stringify([...runs.values()], null, 2) + '\n');
  } catch { /* mirror only — never fatal */ }
}

// Runs left in the mirror by a previous server process (for orphan-kill on boot).
export function readPriorRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE(), 'utf8'));
  } catch {
    return [];
  }
}

export function addCost(usd) {
  if (!usd || !(usd > 0)) return;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    let ledger = {};
    try { ledger = JSON.parse(fs.readFileSync(LEDGER_FILE(), 'utf8')); } catch {}
    const month = new Date().toISOString().slice(0, 7);
    ledger[month] = Math.round(((ledger[month] || 0) + usd) * 10000) / 10000;
    writeAtomic(LEDGER_FILE(), JSON.stringify(ledger, null, 2) + '\n');
  } catch { /* best effort */ }
}

export function monthCost() {
  try {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE(), 'utf8'));
    return ledger[new Date().toISOString().slice(0, 7)] || 0;
  } catch {
    return 0;
  }
}
