import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { commitCard, commitPaths } from './git.js';
import { withFileLock } from './lockfile.js';

const DEFAULT_COLUMNS = ['Review', 'Plan', 'Planned', 'Queue', 'Build', 'Verify', 'Needs Human', 'Done'];

// gray-matter (v4) caches parse results keyed by the input string — AND caches
// an empty result even after the first parse THREW. So once loadBoard hits a
// card with malformed frontmatter (throws, caught → "(unparseable)"), a later
// matter() on that same string returns {data:{}, content:<entire raw>} without
// throwing — silently losing the card's id/status. Detect that poisoned shape
// (a frontmatter block that wasn't consumed and yielded no keys) and re-throw,
// so every read path treats the bad card consistently as a parse failure.
function parseCard(raw) {
  const parsed = matter(raw);
  if (/^---\r?\n/.test(raw) && parsed.content === raw && Object.keys(parsed.data).length === 0) {
    throw new Error('frontmatter failed to parse');
  }
  return parsed;
}

// Columns the pipeline hard-requires — if a config edit drops one, its cards
// would become invisible/stuck, so union it back in (user order preserved).
const REQUIRED_COLUMNS = ['Queue', 'Build', 'Verify', 'Needs Human', 'Done'];

// Shared by loadConfig (working tree) and the pipeline's execConfig (the
// committed copy) so the column invariants hold for both, and neither has to
// borrow the other's values to get them.
export function normalizeConfig(cfg) {
  const out = { columns: DEFAULT_COLUMNS, ...(cfg || {}) };
  out.columns = Array.isArray(out.columns) && out.columns.length ? [...out.columns] : [...DEFAULT_COLUMNS];
  for (const col of REQUIRED_COLUMNS) if (!out.columns.includes(col)) out.columns.push(col);
  return out;
}

export function loadConfig(repoPath) {
  try {
    const raw = fs.readFileSync(path.join(repoPath, '.todomd', 'config.yml'), 'utf8');
    return normalizeConfig(yaml.load(raw) || {});
  } catch {
    return normalizeConfig({});
  }
}

// Per-column agent/model override — the "column" tier of card → column → board.
// A comment-preserving, block-format line patch of .todomd/config.yml's
// `stages.<col>` map: sets the agent/model line, or removes it when the value is
// empty (so the column falls back to the board default). js-yaml.dump would
// strip the file's comments, so we patch the lines in place instead.
export function setStageRouting(repoPath, col, updates) {
  return withRepoLock(repoPath, async () => {
    const file = path.join(repoPath, '.todomd', 'config.yml');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { ok: false, error: 'no config.yml' }; }
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);

    // sanitize: agent is an enum-ish slug, model is [\w.-]; '' clears the override
    const clean = {};
    if ('agent' in updates) clean.agent = String(updates.agent || '').replace(/[^\w-]/g, '');
    if ('model' in updates) clean.model = String(updates.model || '').replace(/[^\w.-]/g, '');
    if (!Object.keys(clean).length) return { ok: true, unchanged: true };

    const commit = () => commitPaths(repoPath, [path.join('.todomd', 'config.yml')],
      `chore(todomd): ${col} stage routing`);

    // find the top-level `stages:` key and the extent of its indented block
    const esc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let si = lines.findIndex((l) => /^stages:\s*$/.test(l));
    if (si === -1) {
      const block = [`  ${col}:`];
      for (const [k, v] of Object.entries(clean)) if (v) block.push(`    ${k}: ${v}`);
      if (block.length === 1) return { ok: true, unchanged: true };
      const body = raw.replace(/\s*$/, '') + eol + eol + 'stages:' + eol + block.join(eol) + eol;
      writeFileAtomic(file, body);
      return { ok: true, commit: await commit() };
    }
    let se = lines.length;
    for (let i = si + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;     // blanks stay inside the block
      if (/^\s/.test(lines[i])) continue;       // indented → still inside stages
      se = i; break;                            // first column-0 non-blank ends it
    }
    while (se > si + 1 && lines[se - 1].trim() === '') se--; // ignore trailing blanks

    // locate this column's header line within the block
    const headerRe = new RegExp(`^(\\s+)${esc}:(.*)$`);
    let ci = -1, colIndent = 2, propIndent = '    ';
    for (let i = si + 1; i < se; i++) {
      const m = lines[i].match(headerRe);
      if (!m) continue;
      if (m[2].trim() !== '') {
        return { ok: false, error: `stages.${col} is written inline — convert it to a block to edit routing here` };
      }
      ci = i; colIndent = m[1].length;
      break;
    }

    if (ci === -1) {
      const block = [`  ${col}:`];
      for (const [k, v] of Object.entries(clean)) if (v) block.push(`    ${k}: ${v}`);
      if (block.length === 1) return { ok: true, unchanged: true };
      lines.splice(se, 0, ...block);
      writeFileAtomic(file, lines.join(eol));
      return { ok: true, commit: await commit() };
    }

    // column sub-block extent [ci+1, ce); adopt its existing child indent
    let ce = se;
    for (let i = ci + 1; i < se; i++) {
      if (lines[i].trim() === '') continue;
      if (lines[i].search(/\S/) <= colIndent) { ce = i; break; }
    }
    for (let i = ci + 1; i < ce; i++) {
      if (lines[i].trim() !== '') { propIndent = lines[i].match(/^\s*/)[0]; break; }
    }

    let insertAt = ci + 1;
    for (const [k, v] of Object.entries(clean)) {
      const keyRe = new RegExp(`^\\s+${k}:`);
      let found = -1;
      for (let i = ci + 1; i < ce; i++) {
        if (keyRe.test(lines[i]) && lines[i].search(/\S/) > colIndent) { found = i; break; }
      }
      if (v) {
        const newLine = `${propIndent}${k}: ${v}`;
        if (found >= 0) lines[found] = newLine;
        else { lines.splice(insertAt, 0, newLine); insertAt++; ce++; }
      } else if (found >= 0) {
        lines.splice(found, 1); ce--;
        if (found < insertAt) insertAt--;
      }
    }
    writeFileAtomic(file, lines.join(eol));
    return { ok: true, commit: await commit() };
  });
}

function tasksDir(repoPath) {
  return path.join(repoPath, '.todomd', 'tasks');
}

// Crash-safe card write: tmp file in the SAME dir (rename is atomic within a
// filesystem), then rename over the target — a crash mid-write leaves a .tmp
// behind instead of a truncated card. Same pattern as registry/runstore.
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// exact id match only: task-0001 must not resolve task-00010-*.md
// `.md` only: writeFileAtomic stages `<card>.md.tmp` in this same directory, and
// `task-0001-x.md.tmp` starts with `task-0001-` too. Normally the real file
// sorts first and wins, but a crash mid-createCard leaves ONLY the .tmp — and
// then every readCard for that id returns a half-written card that loadBoard
// (which filters on .md) never shows. A mutation would also write back through
// card.file, landing on the .tmp instead of the card.
function findCardFile(dir, id) {
  return fs.readdirSync(dir).sort()
    .find((f) => f.endsWith('.md') && (f === `${id}.md` || f.startsWith(`${id}-`)));
}

function criteriaProgress(body) {
  const section = body.split(/^## /m).find((s) => /^Acceptance Criteria\s*(\r?\n|$)/.test(s));
  if (!section) return null;
  const done = (section.match(/^- \[x\]/gim) || []).length;
  const total = done + (section.match(/^- \[ \]/gm) || []).length;
  return total ? { done, total } : null;
}

// Parse the Plan agent's optional `## Chunks` breakdown — a single fenced yaml
// block listing ordered, independently-buildable sub-tasks. The orchestrator
// turns each into a child card. Returns a validated array of
// { title, plan, criteria, type?, needs? }, or [] if the section is absent or malformed
// (caller decides the >=2 threshold for an actual split).
export function parseChunks(body = '') {
  let fenced = false;
  const sections = [''];
  for (const ln of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(ln)) fenced = !fenced;
    if (!fenced && /^## /.test(ln)) sections.push(ln.slice(3) + '\n');
    else sections[sections.length - 1] += ln + '\n';
  }
  const section = sections.find((s) => /^Chunks\s*(\r?\n|$)/.test(s));
  if (!section) return [];
  const fence = section.match(/```(?:ya?ml)?\r?\n([\s\S]*?)\r?\n```/);
  if (!fence) return [];
  let parsed;
  try { parsed = yaml.load(fence[1]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const chunks = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const title = String(item.title ?? '').trim();
    const plan = String(item.plan ?? '').trim();
    const criteria = Array.isArray(item.criteria)
      ? item.criteria.map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (!title || !plan || !criteria.length) continue;
    const chunk = { title, plan, criteria };
    if (item.type) chunk.type = String(item.type).trim();
    if (Array.isArray(item.needs)) {
      const needs = item.needs.map((n) => String(n).trim()).filter(Boolean);
      if (item.needs.length === 0 || needs.length) chunk.needs = needs;
    }
    chunks.push(chunk);
  }
  return chunks;
}

// A card's list fields come from YAML a human hand-edits or an agent writes, so
// any of them can arrive as a scalar, a mapping, or missing. Every reader then
// does `(card.dependencies || []).filter(...)` — which throws on a scalar and
// takes down whatever was iterating: advanceEpicChildren strands an epic, and
// the board payload blanked the entire UI. Normalize once, here, so no reader
// has to remember. (readCard returns raw frontmatter by design — callers that
// hand it straight to a client normalize on their own side.)
const asArray = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
const CARD_LIST_FIELDS = ['labels', 'dependencies', 'children'];
function listFields(data) {
  const out = {};
  for (const f of CARD_LIST_FIELDS) if (f in data) out[f] = asArray(data[f]).map(String);
  return out;
}

export function loadBoard(repoPath, { includeArchived = false } = {}) {
  const config = loadConfig(repoPath);
  const dir = tasksDir(repoPath);
  const cards = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      try {
        const parsed = parseCard(fs.readFileSync(path.join(dir, file), 'utf8'));
        // archived cards are hidden from the board (and skipped by the pipeline)
        // unless explicitly requested — the "show archived" view passes the flag
        if (!includeArchived && parsed.data.archived) continue;
        cards.push({
          file,
          ...parsed.data,
          ...listFields(parsed.data),
          criteria: criteriaProgress(parsed.content),
        });
      } catch {
        cards.push({ file, id: file.replace(/\.md$/, ''), title: `(unparseable) ${file}`, status: 'Review', unparseable: true });
      }
    }
  }
  return { config, cards };
}

// The most recent run's streamed events, for back-filling the drawer's live log
// when you open a card mid-run (or to review a finished run). Reads the newest
// .todomd/runs/<id>/<stage>-<n>.jsonl. Returns the raw stream-json events.
export function readRunLog(repoPath, id, { maxEvents = 800 } = {}) {
  const dir = path.join(repoPath, '.todomd', 'runs', id);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return { stage: null, events: [] }; }
  if (!files.length) return { stage: null, events: [] };
  const latest = files
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].f;
  const events = [];
  for (const line of fs.readFileSync(path.join(dir, latest), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a garbled line */ }
  }
  return { stage: latest.replace(/-\d+\.jsonl$/, ''), events: events.slice(-maxEvents) };
}

// The repo's invocable commands (.claude/commands/*.md) — the values a card's
// `skill:` can take (a card can also use a user/plugin skill not listed here).
export function listSkills(repoPath) {
  try {
    return fs.readdirSync(path.join(repoPath, '.claude', 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch { return []; }
}

export function readCard(repoPath, id) {
  const dir = tasksDir(repoPath);
  if (!fs.existsSync(dir)) return null;
  const file = findCardFile(dir, id);
  if (!file) return null;
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    const parsed = parseCard(raw);
    return { file, raw, data: parsed.data, body: parsed.content };
  } catch (e) {
    return { file, raw, data: {}, body: raw, parseError: String(e.message || e) };
  }
}

// Rewrite (or insert) the status key strictly inside the frontmatter block,
// leaving the body and all other frontmatter formatting untouched.
function setStatusInFrontmatter(raw, newStatus) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];
  const newFm = /^status:.*$/m.test(fm)
    ? fm.replace(/^status:.*$/m, () => `status: ${newStatus}`)
    : `${fm}\nstatus: ${newStatus}`;
  return `---\n${newFm}\n---` + raw.slice(m[0].length);
}

// One write at a time per repo: a human drag and (in phase 2) an agent-run
// transition must never interleave read-modify-write on the same files.
const repoLocks = new Map();
// exported so coordination's ACTIVE.md read-modify-write-commit serializes with
// board writes/commits on the same repo (no git-index race, no lost update).
// Two layers: an in-process promise chain (cheap, serializes this process's
// writers) wrapping the on-disk `.todomd/.lock` (serializes against OTHER
// processes — a second server, or a budget-mode dispatch session committing via
// its own shell git). The dispatch command grabs the same on-disk lock.
export function withRepoLock(repoPath, fn) {
  const guarded = () => withFileLock(repoPath, fn);
  const prev = repoLocks.get(repoPath) || Promise.resolve();
  const next = prev.then(guarded, guarded);
  repoLocks.set(repoPath, next.then(() => {}, () => {}));
  return next;
}

export function moveCard(repoPath, id, newStatus, { reason } = {}) {
  return withRepoLock(repoPath, async () => {
    const config = loadConfig(repoPath);
    if (!config.columns.includes(newStatus)) {
      return { ok: false, error: `unknown status: ${newStatus}` };
    }
    const card = readCard(repoPath, id);
    if (!card) return { ok: false, error: `card not found: ${id}` };
    const oldStatus = card.data.status;
    if (oldStatus === newStatus) return { ok: true, unchanged: true };

    const updated = setStatusInFrontmatter(card.raw, newStatus);
    if (updated === null) {
      return { ok: false, error: `${id} has no frontmatter block; fix the file manually` };
    }
    const relFile = path.join('.todomd', 'tasks', card.file);
    writeFileAtomic(path.join(repoPath, relFile), updated);

    // chore(todomd): passes Conventional Commits gates (husky/commitlint)
    const msg = `chore(todomd): ${id} ${oldStatus ?? '(none)'} -> ${newStatus}${reason ? ` (${reason})` : ''}`;
    const commit = await commitCard(repoPath, relFile, msg);
    const result = { ok: true, oldStatus, newStatus, commit };
    if (!commit.committed) result.warning = `moved, but not committed: ${commit.reason}`;
    return result;
  });
}

// Hide a card from the board (reversible) — set or clear the `archived`
// frontmatter flag and commit. Archived cards are skipped by loadBoard (and so
// by the whole pipeline) unless explicitly included.
export function setArchived(repoPath, id, on) {
  return withRepoLock(repoPath, async () => {
    const card = readCard(repoPath, id);
    if (!card) return { ok: false, error: `card not found: ${id}` };
    const m = card.raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { ok: false, error: `${id} has no frontmatter block; fix the file manually` };
    let fm = m[1];
    if (on) {
      // quote the date so YAML keeps it a string (an unquoted date parses to a Date object)
      const line = `archived: "${new Date().toISOString().slice(0, 10)}"`;
      fm = /^archived:.*$/m.test(fm) ? fm.replace(/^archived:.*$/m, () => line) : `${fm}\n${line}`;
    } else {
      fm = fm.replace(/^archived:.*\r?\n?/m, ''); // drop the flag to restore
    }
    const updated = `---\n${fm}\n---` + card.raw.slice(m[0].length);
    const relFile = path.join('.todomd', 'tasks', card.file);
    writeFileAtomic(path.join(repoPath, relFile), updated);
    const commit = await commitCard(repoPath, relFile, `chore(todomd): ${id} ${on ? 'archived' : 'unarchived'}`);
    return { ok: true, archived: !!on, commit };
  });
}

// Permanently remove a card — its task file and any attachments — in one
// path-scoped commit. git history still has it, so it's recoverable.
export function deleteCard(repoPath, id) {
  return withRepoLock(repoPath, async () => {
    const dir = tasksDir(repoPath);
    const file = findCardFile(dir, id);
    if (!file) return { ok: false, error: `card not found: ${id}` };
    const relFile = path.join('.todomd', 'tasks', file);
    const relAtt = path.join('.todomd', 'attachments', id);
    fs.rmSync(path.join(repoPath, relFile), { force: true });
    const hadAtt = fs.existsSync(path.join(repoPath, relAtt));
    if (hadAtt) fs.rmSync(path.join(repoPath, relAtt), { recursive: true, force: true });
    const paths = hadAtt ? [relFile, relAtt] : [relFile];
    const commit = await commitPaths(repoPath, paths, `chore(todomd): ${id} deleted`);
    return { ok: true, commit };
  });
}

function flowScalar(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  if (/^[\w./@+-]+$/.test(s)) return s;
  // delegate to js-yaml for anything else: it escapes control chars, quotes,
  // colons, newlines — so a hostile value can't wedge the card or inject a key
  return yaml.dump(s, { flowLevel: 0, lineWidth: -1 }).trim();
}

function flowYaml(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${flowYaml(v)}`).join(', ')} }`;
  }
  if (Array.isArray(value)) return `[${value.map(flowYaml).join(', ')}]`;
  return flowScalar(value);
}

// Format-preserving frontmatter patch: replaces (or appends) whole top-level
// key lines inside the frontmatter block only. Orchestrator-owned fields.
export function patchFrontmatter(repoPath, id, updates) {
  return withRepoLock(repoPath, async () => {
    const card = readCard(repoPath, id);
    if (!card) return { ok: false, error: `card not found: ${id}` };
    const m = card.raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { ok: false, error: 'no frontmatter' };
    let fm = m[1];
    for (const [key, value] of Object.entries(updates)) {
      const line = `${key}: ${flowYaml(value)}`.trimEnd();
      const re = new RegExp(`^${key}:.*$`, 'm');
      // function replacer so '$&', '$1', etc. in a value aren't expanded
      fm = re.test(fm) ? fm.replace(re, () => line) : `${fm}\n${line}`;
    }
    const updated = `---\n${fm}\n---` + card.raw.slice(m[0].length);
    writeFileAtomic(path.join(repoPath, '.todomd', 'tasks', card.file), updated);
    return { ok: true, file: card.file };
  });
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

// Frontmatter scalars below are interpolated UNQUOTED — strip newlines and
// YAML-significant chars so a hostile value can't inject keys or break the
// parse. Not only UI input: a chunk card's title/type come from the Plan
// agent's `## Chunks` yaml, so a poisoned plan reaches here.
// Blocking key injection isn't enough — a value that merely fails to PARSE
// writes a card nothing can read (it loads as "(unparseable)"), so the run is
// wasted either way. Two shapes do that on their own:
//   - a leading '-' or '?' ("- x") → parsed as a sequence/complex key, not a
//     scalar: "bad indentation of a mapping entry"
//   - control characters → js-yaml refuses the whole stream as non-printable
const fmScalar = (value, fallback) =>
  String(value || fallback)
    .replace(/[\x00-\x1f\x7f]/g, ' ')            // non-printables kill the parse
    .replace(/[:#\[\]{},&*!|>'"%@`]/g, ' ')      // YAML-significant
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-?\s]+/, '')                     // leading '- ' would start a sequence
    .trim();

export function createCard(repoPath, fields) {
  return withRepoLock(repoPath, async () => {
    const dir = tasksDir(repoPath);
    fs.mkdirSync(dir, { recursive: true });
    const title = String(fields.title || '').trim();
    if (!title) return { ok: false, error: 'title is required' };

    const max = fs.readdirSync(dir)
      .map((f) => f.match(/^task-(\d+)/)?.[1])
      .filter(Boolean)
      .reduce((m, n) => Math.max(m, Number(n)), 0);
    const id = `task-${String(max + 1).padStart(4, '0')}`;
    const file = `${id}-${slugify(title)}.md`;

    // asArray: chunk cards are created from the Plan agent's yaml, where any of
    // these can come back as a bare scalar instead of a list — .map would throw
    // and take the whole Plan stage with it
    const labels = asArray(fields.labels).map((l) => fmScalar(l, '')).filter(Boolean);
    const criteria = asArray(fields.criteria).map((c) => String(c).trim()).filter(Boolean);
    // optional fields for orchestrator-created child cards (chunks of an epic);
    // omitted by the UI/email callers, which keep today's defaults
    const status = String(fields.status || 'Review').replace(/[^\w ]/g, '').trim() || 'Review';
    const deps = asArray(fields.dependencies).map((d) => String(d).replace(/[^\w-]/g, '')).filter(Boolean);
    const parent = fields.parent ? String(fields.parent).replace(/[^\w-]/g, '') : '';
    const triaged = fields.triaged ? String(fields.triaged).replace(/[\r\n:]/g, ' ').trim() : '';
    const plan = fields.plan ? String(fields.plan).trim().replace(/^(#{1,6}) /gm, (_, h) => '\\' + h + ' ') : '';
    const content = `---
id: ${id}
title: ${fmScalar(title, 'untitled')}
status: ${status}
type: ${fmScalar(fields.type, 'improvement')}
priority: ${fmScalar(fields.priority, 'medium')}
labels: [${labels.join(', ')}]
dependencies: [${deps.join(', ')}]${parent ? `\nparent: ${parent}` : ''}
created_date: ${new Date().toISOString().slice(0, 10)}
source: ${fmScalar(fields.source, 'ui')}
assignee: ${fields.assignee ? String(fields.assignee).replace(/[^\w.@ -]/g, '').trim() : ''}
agent: ${fields.agent === 'codex' ? 'codex' : 'claude'}${fields.model ? `\nmodel: ${String(fields.model).replace(/[^\w.-]/g, '')}` : ''}${fields.skill ? `\nskill: ${String(fields.skill).replace(/[^\w:-]/g, '')}` : ''}${triaged ? `\ntriaged: ${triaged}` : ''}
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

${String(fields.description || title).trim()}

## Acceptance Criteria

${criteria.length ? criteria.map((c) => `- [ ] ${c}`).join('\n') : '- [ ] Implemented and verified'}

## Implementation Plan

${plan ? `${plan}\n\n` : ''}## Run Log
`;
    writeFileAtomic(path.join(dir, file), content);
    const relFile = path.join('.todomd', 'tasks', file);
    const commit = await commitCard(repoPath, relFile, `chore(todomd): ${id} created (${fields.source || 'ui'})`);
    return { ok: true, id, file, commit };
  });
}

// Commit a card's file as-is (for flows like triage that annotate the card but
// don't change status, so no moveCard commit folds the changes in).
export function commitCardChanges(repoPath, id, message) {
  return withRepoLock(repoPath, async () => {
    const file = findCardFile(tasksDir(repoPath), id);
    if (!file) return { committed: false, reason: 'card not found' };
    return commitCard(repoPath, path.join('.todomd', 'tasks', file), message);
  });
}

// Read/write a column's prompt = its .claude/commands/<name>.md file. The name
// is constrained to [\w-] so it can never escape the commands dir.
export function readCommandFile(repoPath, name) {
  if (!/^[\w-]+$/.test(name)) return null;
  try { return fs.readFileSync(path.join(repoPath, '.claude', 'commands', `${name}.md`), 'utf8'); }
  catch { return ''; } // not yet created → empty
}

export function writeCommandFile(repoPath, name, content) {
  if (!/^[\w-]+$/.test(name)) return Promise.resolve({ ok: false, error: 'invalid command name' });
  return withRepoLock(repoPath, async () => {
    const dir = path.join(repoPath, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), String(content ?? ''));
    const commit = await commitPaths(repoPath, [path.join('.claude', 'commands', `${name}.md`)],
      `chore(todomd): edit ${name} prompt`);
    return { ok: true, commit };
  });
}

// A prompt is split into a LOCKED core (the protocol that must not change — it's
// what keeps the pipeline working) and an EDITABLE region between markers where
// the user adds project conventions. Editing in the UI only ever touches the
// editable region, so the core can't be broken.
const CUSTOM_OPEN = '<!-- todomd:custom — project conventions (edit in the board UI); treat the lines below as additional instructions -->';
const CUSTOM_CLOSE = '<!-- /todomd:custom -->';
const CUSTOM_RE = /\n*<!-- todomd:custom[^>]*-->\n?([\s\S]*?)\n?<!-- \/todomd:custom -->\n*/;

// Returns { name, locked, custom, hasRegion } — locked is the core with the
// editable region removed (for read-only display), custom is the editable text.
export function readCommandParts(repoPath, name) {
  const content = readCommandFile(repoPath, name);
  if (content === null) return null;
  const m = content.match(CUSTOM_RE);
  if (m) return { name, locked: content.replace(CUSTOM_RE, '\n').replace(/\n{3,}/g, '\n\n').trimEnd(), custom: m[1].trim(), hasRegion: true };
  return { name, locked: content.trimEnd(), custom: '', hasRegion: false };
}

// Replace ONLY the editable region (creating one if absent). The locked core is
// taken verbatim from the current file, so this can never alter it.
export function writeCommandCustom(repoPath, name, custom) {
  const content = readCommandFile(repoPath, name);
  if (content === null) return Promise.resolve({ ok: false, error: 'invalid command name' });
  // strip any markers from the user's text so it can't break out of the region
  const safe = String(custom || '').replace(/<!--\s*\/?todomd:custom[^>]*-->/g, '').trim();
  const region = `${CUSTOM_OPEN}\n${safe}\n${CUSTOM_CLOSE}`;
  const next = CUSTOM_RE.test(content)
    ? content.replace(CUSTOM_RE, `\n\n${region}\n`)
    : `${content.replace(/\n+$/, '')}\n\n${region}\n`;
  return writeCommandFile(repoPath, name, next);
}

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const MAX_ATTACHMENT = 25 * 1024 * 1024; // 25 MB

// Save an uploaded file under .todomd/attachments/<id>/, reference it in the
// card's ## Attachments section, and commit both. Filenames are sanitized to a
// basename so they can never escape the attachments dir.
export function attachCard(repoPath, id, filename, buffer) {
  return withRepoLock(repoPath, async () => {
    if (!buffer || !buffer.length) return { ok: false, error: 'empty file' };
    if (buffer.length > MAX_ATTACHMENT) return { ok: false, error: 'file too large (25 MB max)' };
    const card = readCard(repoPath, id);
    if (!card) return { ok: false, error: `card not found: ${id}` };

    // no spaces/special chars — keep attachment names URL-safe for markdown links
    let safe = path.basename(String(filename || 'file')).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '');
    if (!safe) safe = 'file';
    const relDir = path.join('.todomd', 'attachments', id);
    const absDir = path.join(repoPath, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    // never clobber an existing attachment
    let name = safe;
    for (let n = 1; fs.existsSync(path.join(absDir, name)); n++) {
      const ext = path.extname(safe);
      name = `${path.basename(safe, ext)}-${n}${ext}`;
    }
    fs.writeFileSync(path.join(absDir, name), buffer);

    const relPosix = `${relDir.split(path.sep).join('/')}/${name}`;
    const isImg = IMG_EXT.has(path.extname(name).toLowerCase());
    const ref = isImg ? `![${name}](${relPosix})` : `[${name}](${relPosix})`;

    let raw = card.raw;
    if (/^## Attachments\s*$/m.test(raw)) {
      raw = raw.replace(/^## Attachments[^\n]*\n/m, (m) => `${m}\n${ref}\n`);
    } else {
      raw = raw.replace(/\n*$/, '') + `\n\n## Attachments\n\n${ref}\n`;
    }
    writeFileAtomic(path.join(repoPath, '.todomd', 'tasks', card.file), raw);

    const relCard = path.join('.todomd', 'tasks', card.file);
    const relAtt = path.join(relDir, name);
    const commit = await commitPaths(repoPath, [relCard, relAtt], `chore(todomd): ${id} attach ${name}`);
    return { ok: true, name, path: relPosix, isImg, commit };
  });
}

// Append one orchestrator-written line into the card's ## Run Log section
// (inserted at the end of that section, before any following heading).
export function appendRunLog(repoPath, id, line) {
  return withRepoLock(repoPath, async () => {
    const card = readCard(repoPath, id);
    if (!card) return { ok: false, error: `card not found: ${id}` };
    let raw = card.raw;
    // Anchor to the REAL "## Run Log" heading — not a line-start mention inside a
    // fenced code block (a self-documenting todomd card can quote the heading
    // verbatim in a ``` block). Scan lines tracking fence state; the next "## "
    // heading (also outside fences) bounds the section.
    let inFence = false, pos = 0, headingFound = false, nextNl = -1;
    for (const ln of raw.split('\n')) {
      const isFence = /^\s*(```|~~~)/.test(ln);
      if (isFence) { inFence = !inFence; pos += ln.length + 1; continue; }
      if (!inFence) {
        if (!headingFound && /^## Run Log\b/.test(ln)) headingFound = true;
        else if (headingFound && /^## /.test(ln)) { nextNl = pos - 1; break; }
      }
      pos += ln.length + 1;
    }
    if (!headingFound) {
      raw = raw.replace(/\n*$/, '') + `\n\n## Run Log\n\n${line}\n`;
    } else {
      const insertAt = nextNl < 0 ? raw.length : nextNl;
      const before = raw.slice(0, insertAt).replace(/\n*$/, '') + '\n';
      // keep the blank line before a following heading (slice from the newline)
      raw = `${before}${line}\n` + (nextNl < 0 ? '' : raw.slice(nextNl));
    }
    writeFileAtomic(path.join(repoPath, '.todomd', 'tasks', card.file), raw);
    return { ok: true };
  });
}
