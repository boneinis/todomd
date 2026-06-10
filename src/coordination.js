import os from 'node:os';
import path from 'node:path';
import { git, commitPaths } from './git.js';

// A committed manifest of in-flight work so multiple developers on one repo
// don't step on each other. todomd writes a claim when a card starts building
// and removes it when the card finishes; with sync on, it fetches others'
// claims and pushes its own.
const ACTIVE_REL = path.join('.todomd', 'ACTIVE.md');

const HEADER = `# Active work

<!-- todomd maintains this file automatically: a claim is added when a card
     starts building and removed when it finishes. It exists so multiple
     developers on this repo can see what's actively being worked on. -->
`;

export function workerName(config) {
  const c = config.coordination || {};
  if (c.worker) return String(c.worker);
  let user = 'someone';
  try { user = os.userInfo().username; } catch {}
  return `${user}@${os.hostname()}`;
}

// Extract file paths the plan says it will touch (backtick-quoted, with an
// extension or a slash) from the card's ## Implementation Plan section.
export function planFiles(cardBody = '') {
  const section = cardBody.split(/^## /m).find((s) => s.startsWith('Implementation Plan'));
  if (!section) return [];
  const files = new Set();
  for (const m of section.matchAll(/`([\w./-]+\.[a-zA-Z0-9]+|[\w./-]+\/[\w./-]+)`/g)) {
    const f = m[1].replace(/^\.\//, '');
    if (!f.startsWith('http') && f.length < 200) files.add(f);
  }
  return [...files];
}

export function parseActive(text = '') {
  const claims = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^- \*\*(task-[\w-]+)\*\* — (.*?) — `branch: (.*?)` — worker `(.*?)` — started (.*)$/);
    if (head) {
      cur = { card: head[1], title: head[2], branch: head[3], worker: head[4], started: head[5], files: [] };
      claims.push(cur);
    } else {
      const files = line.match(/^\s+- files: (.*)$/);
      if (files && cur) cur.files = files[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return claims;
}

function renderActive(claims) {
  if (!claims.length) return HEADER + '\n_No active work._\n';
  const body = claims.map((c) =>
    `- **${c.card}** — ${c.title} — \`branch: ${c.branch}\` — worker \`${c.worker}\` — started ${c.started}` +
    (c.files?.length ? `\n  - files: ${c.files.join(', ')}` : '')
  ).join('\n');
  return `${HEADER}\n${body}\n`;
}

async function readLocal(repoPath) {
  const res = await git(repoPath, ['show', `HEAD:${ACTIVE_REL}`]);
  // fall back to the working-tree copy if not yet committed
  if (res.ok) return parseActive(res.stdout);
  try {
    const fs = await import('node:fs');
    return parseActive(fs.readFileSync(path.join(repoPath, ACTIVE_REL), 'utf8'));
  } catch { return []; }
}

async function currentBranch(repoPath) {
  const res = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.ok ? res.stdout : 'HEAD';
}

// Claims from OTHER workers, read from local + (if sync) the fetched remote copy.
export async function readAllClaims(repoPath, { sync } = {}) {
  const claims = await readLocal(repoPath);
  if (sync) {
    const branch = await currentBranch(repoPath);
    await git(repoPath, ['fetch', '--quiet', 'origin', branch]); // read-only, best effort
    const remote = await git(repoPath, ['show', `origin/${branch}:${ACTIVE_REL}`]);
    if (remote.ok) {
      const have = new Set(claims.map((c) => `${c.worker}:${c.card}`));
      for (const c of parseActive(remote.stdout)) {
        if (!have.has(`${c.worker}:${c.card}`)) claims.push(c);
      }
    }
  }
  return claims;
}

// Other-worker claims whose files intersect this card's files.
export function findConflicts(claims, { card, worker, files }) {
  const mine = new Set(files);
  return claims.filter((c) =>
    c.worker !== worker && c.card !== card && (c.files || []).some((f) => mine.has(f))
  );
}

async function writeAndCommit(repoPath, claims, message, { sync }) {
  const fs = await import('node:fs');
  fs.writeFileSync(path.join(repoPath, ACTIVE_REL), renderActive(claims));
  const commit = await commitPaths(repoPath, [ACTIVE_REL], message);
  if (sync && commit.committed) {
    const branch = await currentBranch(repoPath);
    await git(repoPath, ['push', '--quiet', 'origin', `HEAD:${branch}`]); // best effort
  }
  return commit;
}

// Add/replace this card's claim. Returns the conflicting other-worker claims.
export async function claim(repoPath, { card, title, branch, worker, files }, { sync } = {}) {
  const all = await readAllClaims(repoPath, { sync });
  const conflicts = findConflicts(all, { card, worker, files });
  const mineOnly = (await readLocal(repoPath)).filter((c) => c.card !== card);
  mineOnly.push({ card, title, branch, worker, started: new Date().toISOString().slice(0, 16) + 'Z', files });
  await writeAndCommit(repoPath, mineOnly, `chore(todomd): ${card} claim active work`, { sync });
  return conflicts;
}

export async function release(repoPath, card, { sync } = {}) {
  const claims = await readLocal(repoPath);
  if (!claims.some((c) => c.card === card)) return; // nothing to release
  const remaining = claims.filter((c) => c.card !== card);
  await writeAndCommit(repoPath, remaining, `chore(todomd): ${card} release active work`, { sync });
}
