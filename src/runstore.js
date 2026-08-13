import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// resolved lazily so a TODOMD_HOME override (and tests) take effect
const dir = () => path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd');
const RUNS_FILE = () => path.join(dir(), 'runs.json');
const LEDGER_FILE = () => path.join(dir(), 'ledger.json');
const USAGE_FILE = () => path.join(dir(), 'usage.jsonl');

// key `${project}:${cardId}` → { project, card, stage, pid, sessionId,
//   startedAt, prevStatus, attempt, vendor, executable }
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

const tokenFields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const cleanNumber = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

// Append-only telemetry avoids the cross-process lost-update race of a shared
// JSON object. Summary reads dedupe by run_id, so retrying a finalization after
// a crash cannot double-count the same provider invocation.
export function recordUsage(record) {
  if (!record?.run_id) return false;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const usage = {};
    for (const field of tokenFields) usage[field] = cleanNumber(record.usage?.[field]);
    usage.available = record.usage?.available === true || tokenFields.some((field) => usage[field] > 0);
    const entry = {
      run_id: String(record.run_id).slice(0, 500),
      recorded_at: new Date().toISOString(),
      project: String(record.project || ''), card: String(record.card || ''),
      stage: String(record.stage || ''), attempt: cleanNumber(record.attempt),
      provider: String(record.provider || 'unknown'), model: String(record.model || ''),
      executable: path.basename(String(record.executable || '')),
      execution_type: String(record.execution_type || 'unknown'),
      estimated_cost_usd: cleanNumber(record.estimated_cost_usd),
      usage,
    };
    fs.appendFileSync(USAGE_FILE(), JSON.stringify(entry) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

function emptyTokens() {
  return Object.fromEntries(tokenFields.map((field) => [field, 0]));
}

export function usageSummary(month = new Date().toISOString().slice(0, 7)) {
  const summary = {
    usage_month: month,
    model_runs: 0,
    unavailable_usage_runs: 0,
    estimated_cost_usd: 0,
    tokens: emptyTokens(),
    by_provider: {},
    by_execution_type: {},
  };
  let lines;
  try { lines = fs.readFileSync(USAGE_FILE(), 'utf8').split('\n'); } catch { return summary; }
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.run_id || seen.has(entry.run_id) || !String(entry.recorded_at || '').startsWith(month)) continue;
    seen.add(entry.run_id);
    summary.model_runs++;
    if (!entry.usage?.available) summary.unavailable_usage_runs++;
    summary.estimated_cost_usd += cleanNumber(entry.estimated_cost_usd);
    for (const field of tokenFields) summary.tokens[field] += cleanNumber(entry.usage?.[field]);
    for (const [group, key] of [['by_provider', entry.provider || 'unknown'], ['by_execution_type', entry.execution_type || 'unknown']]) {
      const bucket = summary[group][key] ||= { runs: 0, unavailable_usage_runs: 0, estimated_cost_usd: 0, tokens: emptyTokens() };
      bucket.runs++;
      if (!entry.usage?.available) bucket.unavailable_usage_runs++;
      bucket.estimated_cost_usd += cleanNumber(entry.estimated_cost_usd);
      for (const field of tokenFields) bucket.tokens[field] += cleanNumber(entry.usage?.[field]);
    }
  }
  const roundCost = (bucket) => { bucket.estimated_cost_usd = Math.round(bucket.estimated_cost_usd * 10000) / 10000; };
  roundCost(summary);
  Object.values(summary.by_provider).forEach(roundCost);
  Object.values(summary.by_execution_type).forEach(roundCost);
  return summary;
}
