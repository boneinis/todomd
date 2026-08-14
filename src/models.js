import { execFileSync } from 'node:child_process';

// Model suggestions for the picker. Codex and Agent Gateway expose
// machine-readable inventories; Claude still documents aliases through
// `--help`. A `models:` block in .todomd/config.yml wins for full user control.
const FALLBACK = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  gemini: ['gemini-3.7-flash-high', 'gemini-3.1-pro-high'],
};
export const SUPPORTED_VENDORS = Object.freeze(['claude', 'codex', 'gemini']);
const bin = (vendor) => {
  if (vendor === 'codex') return process.env.TODOMD_CODEX_BIN || vendor;
  if (vendor === 'gemini') return process.env.TODOMD_GEMINI_BIN || 'agy';
  if (vendor === 'kimi') return process.env.TODOMD_KIMI_BIN || vendor;
  return process.env.TODOMD_CLAUDE_BIN || vendor;
};

// `<cli> --help` is a BLOCKING spawn (up to the 4s timeout) on the server's
// event loop. Cache the answer either way — a missing/hanging CLI used to be
// re-probed on every picker open, stalling the whole board each time. A failed
// read is cached briefly so installing the CLI is picked up without a restart.
const cache = new Map();       // vendor → models
const missUntil = new Map();   // vendor → ts after which a failed read is retried
const MISS_TTL_MS = 60_000;

// Pull quoted model tokens out of the `--model` help block only (so we don't
// scrape unrelated quoted examples elsewhere in --help).
export function modelsFromHelp(helpText) {
  const lines = String(helpText || '').split('\n');
  let i = lines.findIndex((l) => /^\s{0,6}--model\b/.test(l));
  if (i < 0) return [];
  let block = lines[i];
  for (i++; i < lines.length; i++) {
    if (/^\s{0,6}-/.test(lines[i]) || !lines[i].trim()) break; // next flag / blank → end of block
    block += ' ' + lines[i].trim();
  }
  return [...new Set([...block.matchAll(/['"]([a-z][\w.-]{1,30})['"]/g)].map((m) => m[1]))];
}

function helpText(vendor) {
  try {
    return execFileSync(bin(vendor), ['--help'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

// Agent Gateway has a real, non-interactive model inventory. Prefer it over
// guesses scraped from --help so a stale config cannot offer aliases that agy
// will reject only after a card has entered a pipeline stage.
export function modelsFromAgy(text) {
  return [...new Set(String(text || '').split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((model) => /^gemini-[\w.-]+$/.test(model)))];
}

export function modelsFromCodexDebug(text) {
  try {
    const catalog = JSON.parse(String(text || ''));
    return [...new Set((Array.isArray(catalog?.models) ? catalog.models : [])
      .filter((model) => model?.visibility === 'list')
      .map((model) => String(model.slug || '').trim())
      .filter((model) => /^(?:gpt-|codex|o\d)/i.test(model)))];
  } catch { return []; }
}

function cliModels(vendor) {
  try {
    if (vendor === 'codex') {
      return modelsFromCodexDebug(execFileSync(bin(vendor), ['debug', 'models'], {
        encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
      }));
    }
    if (vendor === 'gemini') {
      return modelsFromAgy(execFileSync(bin(vendor), ['models'], {
        encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
      }));
    }
    return modelsFromHelp(helpText(vendor));
  } catch { return []; }
}

export function listModels(vendor = 'claude', config = {}) {
  if (!SUPPORTED_VENDORS.includes(vendor)) return [];
  const override = config?.models?.[vendor];
  // Machine-readable provider inventories are authoritative when available.
  // Claude has no dependable inventory, so its curated config remains so.
  if (vendor !== 'gemini' && Array.isArray(override) && override.length) return override.map(String);
  if (cache.has(vendor)) return cache.get(vendor);
  const fallback = FALLBACK[vendor] || FALLBACK.claude;
  const configured = Array.isArray(override) ? override.map(String) : [];
  if (Date.now() < (missUntil.get(vendor) || 0)) return configured.length ? configured : fallback;
  const fromCli = cliModels(vendor);
  const merged = vendor === 'gemini' && fromCli.length
    ? fromCli
    : [...new Set([...fromCli, ...configured, ...fallback])];
  if (fromCli.length) cache.set(vendor, merged);
  else missUntil.set(vendor, Date.now() + MISS_TTL_MS); // back off, don't re-block per request
  return merged;
}

const MODEL_FAMILY = [
  ['claude', /^(?:claude-|sonnet|haiku|opus|fable)/i],
  ['codex', /^(?:gpt-|codex|o\d)/i],
  ['gemini', /^gemini-/i],
  ['kimi', /^(?:kimi|moonshot)/i],
];

export function validateModelRoute(vendor, model, config = {}) {
  vendor = String(vendor || '').toLowerCase();
  model = String(model || '').trim();
  if (!SUPPORTED_VENDORS.includes(vendor)) {
    return { ok: false, error: vendor === 'kimi'
      ? 'Kimi is disabled: its installed CLI adapter is not compatible yet'
      : `agent "${vendor}" is not supported` };
  }
  if (!model) return { ok: true };
  const family = MODEL_FAMILY.find(([, pattern]) => pattern.test(model))?.[0];
  if (family && family !== vendor) {
    return { ok: false, error: `model "${model}" belongs to ${family}, not ${vendor}` };
  }
  if (vendor === 'gemini') {
    const available = listModels(vendor, config);
    if (available.length && !available.includes(model)) {
      return { ok: false, error: `model "${model}" is not available through agy` };
    }
  }
  return { ok: true };
}
