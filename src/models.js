import { execFileSync } from 'node:child_process';

// Model suggestions for the picker. There's no headless "list models" command on
// either CLI (`/model` is an interactive TUI), so we do the closest scriptable
// thing: read the model aliases the installed CLI documents in its `--help`, and
// union them with a safe fallback. A `models:` block in .todomd/config.yml wins
// over both, for full user control. No API/network — just `<cli> --help`.
const FALLBACK = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5', 'o3'],
};
const bin = (vendor) =>
  (vendor === 'codex' ? process.env.TODOMD_CODEX_BIN : process.env.TODOMD_CLAUDE_BIN) || vendor;

const cache = new Map();

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

export function listModels(vendor = 'claude', config = {}) {
  const override = config?.models?.[vendor];
  if (Array.isArray(override) && override.length) return override.map(String); // config wins, uncached
  if (cache.has(vendor)) return cache.get(vendor);
  const fallback = FALLBACK[vendor] || FALLBACK.claude;
  const fromCli = modelsFromHelp(helpText(vendor));
  const merged = [...new Set([...fromCli, ...fallback])];
  if (fromCli.length) cache.set(vendor, merged); // only cache a real CLI read
  return merged;
}
