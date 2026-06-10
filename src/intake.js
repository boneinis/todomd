import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createCard, attachCard } from './board.js';

// Credentials live OUTSIDE any repo (never committed): ~/.todomd/intake.json.
// Two formats, both keyed by project name:
//
//  (1) inline — one self-contained mailbox per project:
//      { "<project>": { host, port, secure, user, pass, folder, pollSeconds, markSeen } }
//
//  (2) shared accounts — define credentials once, route by folder per project
//      (best when several boards share one inbox):
//      { "accounts": { "work": { host, port, secure, user, pass } },
//        "boards":   { "repo-a": { account: "work", folder: "todomd-a" },
//                      "repo-b": { account: "work", folder: "todomd-b" } } }
//  (3) shared inbox — ONE folder that receives forwarded mail for several
//      projects (e.g. project addresses all forward to one todomd@ inbox).
//      Route each message to a board by the address it was sent to:
//      { "accounts": { "hub": {…} },
//        "inboxes": { "main": { account: "hub", folder: "INBOX",
//          routes: [ { project: "repo-a", toMatches: "repo-a@you.com" },
//                    { project: "repo-b", toMatches: "you+repo-b@gmail.com" } ],
//          default: "triage" } } }   // default optional: unmatched → this board
const configFile = () => path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'intake.json');

function loadRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

// Every recipient-ish address on a message, lowercased. Forwarding via aliases
// preserves the original recipient in To/Cc; Gmail/server forwarding adds it in
// Delivered-To / X-Forwarded-To / X-Original-To / Envelope-To.
export function recipientAddresses(parsed) {
  const out = [];
  for (const field of ['to', 'cc', 'bcc']) {
    for (const a of parsed?.[field]?.value || []) if (a.address) out.push(a.address.toLowerCase());
  }
  const headers = parsed?.headers;
  if (headers && typeof headers.get === 'function') {
    for (const h of ['delivered-to', 'x-forwarded-to', 'x-original-to', 'envelope-to', 'x-forwarded-for', 'x-rcpt-to']) {
      const v = headers.get(h);
      if (v) (Array.isArray(v) ? v : [v]).forEach((x) => out.push(String(x?.text ?? x).toLowerCase()));
    }
  }
  return out;
}

// Pick the target project for a routed inbox message (or the default / null).
export function routeProject(routes, fallback, parsed) {
  const addrs = recipientAddresses(parsed);
  for (const r of routes || []) {
    const needle = String(r.toMatches || '').toLowerCase().trim();
    if (needle && addrs.some((a) => a.includes(needle))) return r.project;
  }
  return fallback || null;
}

// Normalize the config into poll sources. A `board` maps 1 folder → 1 project;
// an `inbox` maps 1 folder → many projects via address routing.
export function intakeSources() {
  const raw = loadRaw();
  const accounts = raw.accounts || {};
  const merge = (o) => ({ ...(o && o.account ? accounts[o.account] || {} : {}), ...o });
  const structured = raw.boards || raw.inboxes || raw.accounts;
  const sources = [];
  const boards = structured ? (raw.boards || {}) : raw; // legacy flat = boards
  for (const [name, b] of Object.entries(boards)) {
    sources.push({ kind: 'board', label: name, conf: merge(b), resolve: () => name });
  }
  for (const [name, inbox] of Object.entries(raw.inboxes || {})) {
    const conf = merge(inbox);
    sources.push({
      kind: 'inbox', label: name, conf,
      routes: inbox.routes || [],
      resolve: (parsed) => routeProject(inbox.routes, inbox.default, parsed),
    });
  }
  return sources;
}

// Back-compat flat board map (used by testIntake + callers that expect 1:1).
export function loadIntakeConfig() {
  const out = {};
  for (const s of intakeSources()) if (s.kind === 'board') out[s.label] = s.conf;
  return out;
}

// Pure, testable: a parsed email → card fields. Untrusted content; createCard
// sanitizes the title and the body is escaped on render.
export function emailToCardFields(parsed) {
  const subject = String(parsed.subject || '(no subject)').replace(/\s+/g, ' ').trim();
  const from = parsed.from?.text || 'unknown sender';
  const body = String(parsed.text || '').trim()
    || (parsed.html ? '(HTML-only email — open the original to see formatting)' : '(empty body)');
  return {
    title: subject.slice(0, 140) || '(no subject)',
    type: 'improvement',
    priority: 'medium',
    labels: ['email'],
    source: 'email',
    description: `**From:** ${from}\n\n${body}`.slice(0, 8000),
  };
}

let onCard = () => {};   // set by start(): (project, id) => void  (e.g. trigger triage)
let log = () => {};

async function pollSource(source, getProject) {
  const { conf, resolve, label } = source;
  if (!conf.host || !conf.user || !conf.pass) { log(`intake: "${label}" missing host/user/pass`); return; }

  const client = new ImapFlow({
    host: conf.host,
    port: conf.port || 993,
    secure: conf.secure !== false,
    auth: { user: conf.user, pass: conf.pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(conf.folder || 'INBOX');
  let created = 0;
  try {
    // only unseen messages; marking them seen (default) is the idempotency key
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const targetName = resolve(parsed);          // board → fixed; inbox → by recipient
        const project = targetName && getProject(targetName);
        if (!project) {
          log(`intake: "${label}" skipped a message — ${targetName
            ? `project "${targetName}" not registered`
            : `no route matched (to: ${recipientAddresses(parsed).join(', ') || 'none'})`}`);
        } else {
          const card = await createCard(project.path, emailToCardFields(parsed));
          if (card.ok) {
            created++;
            for (const att of (parsed.attachments || []).slice(0, conf.maxAttachments ?? 5)) {
              if (att?.content && att?.filename) {
                try { await attachCard(project.path, card.id, att.filename, att.content); } catch {}
              }
            }
            onCard(project, card.id);
            log(`intake: "${label}" → ${project.name}: ${card.id}`);
          }
        }
        if (conf.markSeen !== false) await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      } catch (e) {
        log(`intake: "${label}" failed on a message: ${e.message}`);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  if (created) log(`intake: "${label}" created ${created} card(s) from email`);
}

// Start a poll loop per source (board or routed inbox). Returns stop().
export function startIntake({ getProject, onCard: onCardCb = () => {}, log: logFn = () => {} }) {
  onCard = onCardCb;
  log = logFn;
  const timers = [];
  for (const source of intakeSources()) {
    const tick = () => pollSource(source, getProject).catch((e) => log(`intake: "${source.label}" poll error: ${e.message}`));
    tick(); // poll immediately on boot
    const t = setInterval(tick, Math.max(30, source.conf.pollSeconds || 300) * 1000);
    t.unref();
    timers.push(t);
  }
  if (timers.length) log(`intake: polling ${timers.length} mailbox(es)`);
  return () => timers.forEach(clearInterval);
}

// One-shot connection test (for `todomd intake-test`): no card creation.
export async function testIntake(name) {
  const source = intakeSources().find((s) => s.label === name);
  if (!source) return { ok: false, error: `no intake source "${name}" in ~/.todomd/intake.json` };
  const conf = source.conf;
  const client = new ImapFlow({
    host: conf.host, port: conf.port || 993, secure: conf.secure !== false,
    auth: { user: conf.user, pass: conf.pass }, logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(conf.folder || 'INBOX');
    let unseen = 0;
    try { for await (const _ of client.fetch({ seen: false }, { uid: true })) unseen++; }
    finally { lock.release(); }
    await client.logout().catch(() => {});
    return { ok: true, kind: source.kind, folder: conf.folder || 'INBOX', unseen, routes: source.routes?.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
