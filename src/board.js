import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { commitCard, commitPaths } from './git.js';

const DEFAULT_COLUMNS = ['Review', 'Plan', 'Planned', 'Assigned', 'Build', 'Verify', 'Needs Human', 'Done'];

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

export function loadBoard(repoPath) {
  const config = loadConfig(repoPath);
  const dir = tasksDir(repoPath);
  const cards = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      try {
        const parsed = matter(fs.readFileSync(path.join(dir, file), 'utf8'));
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

export function readCard(repoPath, id) {
  const dir = tasksDir(repoPath);
  if (!fs.existsSync(dir)) return null;
  const file = findCardFile(dir, id);
  if (!file) return null;
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    const parsed = matter(raw);
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
function withRepoLock(repoPath, fn) {
  const prev = repoLocks.get(repoPath) || Promise.resolve();
  const next = prev.then(fn, fn);
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
    const heading = raw.indexOf('## Run Log');
    if (heading < 0) {
      raw = raw.replace(/\n*$/, '') + `\n\n## Run Log\n\n${line}\n`;
    } else {
      const afterHeading = heading + '## Run Log'.length;
      const next = raw.indexOf('\n## ', afterHeading);
      const insertAt = next < 0 ? raw.length : next;
      const before = raw.slice(0, insertAt).replace(/\n*$/, '') + '\n';
      // keep the blank line before a following heading (slice from `next`, not next+1)
      raw = `${before}${line}\n` + (next < 0 ? '' : raw.slice(next));
    }
    fs.writeFileSync(path.join(repoPath, '.todomd', 'tasks', card.file), raw);
    return { ok: true };
  });
}
