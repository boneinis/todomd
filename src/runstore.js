import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.todomd');
const RUNS_FILE = path.join(DIR, 'runs.json');
const LEDGER_FILE = path.join(DIR, 'ledger.json');

// key `${project}:${cardId}` → { project, card, stage, pid, sessionId,
//   startedAt, prevStatus, attempt }
export const runs = new Map();

export function runKey(project, cardId) {
  return `${project}:${cardId}`;
}

export function persistRuns() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(RUNS_FILE, JSON.stringify([...runs.values()], null, 2) + '\n');
  } catch { /* mirror only — never fatal */ }
}

export function addCost(usd) {
  if (!usd || !(usd > 0)) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    let ledger = {};
    try { ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch {}
    const month = new Date().toISOString().slice(0, 7);
    ledger[month] = Math.round(((ledger[month] || 0) + usd) * 10000) / 10000;
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
  } catch { /* best effort */ }
}

export function monthCost() {
  try {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return ledger[new Date().toISOString().slice(0, 7)] || 0;
  } catch {
    return 0;
  }
}
