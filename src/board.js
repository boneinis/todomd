import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { commitCard, commitPaths } from './git.js';
import { withFileLock } from './lockfile.js';

const DEFAULT_COLUMNS = ['Review', 'Plan', 'Planned', 'Assigned', 'Build', 'Verify', 'Needs Human', 'Done'];

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

export function loadConfig(repoPath) {
  try {
    const raw = fs.readFileSync(path.join(repoPath, '.todomd', 'config.yml'), 'utf8');
    const cfg = yaml.load(raw) || {};
    if (!Array.isArray(cfg.columns) || !cfg.columns.length) cfg.columns = DEFAULT_COLUMNS;
    return { columns: DEFAULT_COLUMNS, ...cfg };
  } catch {
    return { columns: DEFAULT_COLUMNS };
  }
}

function tasksDir(repoPath) {
  return path.join(repoPath, '.todomd', 'tasks');
}

// exact id match only: task-0001 must not resolve task-00010-*.md
function findCardFile(dir, id) {
  return fs.readdirSync(dir).sort().find((f) => f === `${id}.md` || f.startsWith(`${id}-`));
}

function criteriaProgress(body) {
  const section = body.split(/^## /m).find((s) => /^Acceptance Criteria\s*(\r?\n|$)/.test(s));
  if (!section) return null;
  const done = (section.match(/^- \[x\]/gim) || []).length;
  const total = done + (section.match(/^- \[ \]/gm) || []).length;
  return total ? { done, total } : null;
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
          criteria: criteriaProgress(parsed.content),
        });
      } catch {
        cards.push({ file, id: file.replace(/\.md$/, ''), title: `(unparseable) ${file}`, status: 'Review' });
      }
    }
  }
  return { config, cards };
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
    fs.writeFileSync(path.join(repoPath, relFile), updated);

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
    fs.writeFileSync(path.join(repoPath, relFile), updated);
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
    fs.writeFileSync(path.join(repoPath, '.todomd', 'tasks', card.file), updated);
    return { ok: true, file: card.file };
  });
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

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

    const labels = (fields.labels || []).map((l) => String(l).trim()).filter(Boolean);
    const criteria = (fields.criteria || []).map((c) => String(c).trim()).filter(Boolean);
    const content = `---
id: ${id}
title: ${title.replace(/[:#[\]{}]/g, ' ').replace(/\s+/g, ' ')}
status: Review
type: ${fields.type || 'improvement'}
priority: ${fields.priority || 'medium'}
labels: [${labels.join(', ')}]
dependencies: []
created_date: ${new Date().toISOString().slice(0, 10)}
source: ${fields.source || 'ui'}
assignee: ${fields.assignee ? String(fields.assignee).replace(/[^\w.@ -]/g, '').trim() : ''}
agent: ${fields.agent === 'codex' ? 'codex' : 'claude'}${fields.model ? `\nmodel: ${String(fields.model).replace(/[^\w.-]/g, '')}` : ''}${fields.skill ? `\nskill: ${String(fields.skill).replace(/[^\w:-]/g, '')}` : ''}
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

${String(fields.description || title).trim()}

## Acceptance Criteria

${criteria.length ? criteria.map((c) => `- [ ] ${c}`).join('\n') : '- [ ] Implemented and verified'}

## Implementation Plan

## Run Log
`;
    fs.writeFileSync(path.join(dir, file), content);
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
    fs.writeFileSync(path.join(repoPath, '.todomd', 'tasks', card.file), raw);

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
    fs.writeFileSync(path.join(repoPath, '.todomd', 'tasks', card.file), raw);
    return { ok: true };
  });
}
