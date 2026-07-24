import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createCard, attachCard } from './board.js';

// Credentials live OUTSIDE any repo (never committed): ~/.todomd/intake.json.
// Formats (boards keyed by project name; inboxes keyed by inbox name + routes):
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

function writeRaw(raw) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {} // it holds a password
}

// The per-project board config for the UI — WITHOUT the password (never sent
// to the browser; we report only whether one is saved).
export function publicIntake(projectName) {
  const c = loadIntakeConfig()[projectName] || {};
  return {
    host: c.host || '', port: c.port || 993, secure: c.secure !== false,
    user: c.user || '', folder: c.folder || 'INBOX',
    pollSeconds: c.pollSeconds || 300, assignee: c.assignee || '',
    hasPassword: !!c.pass, configured: !!(c.host && c.user),
  };
}

// Upsert a project's board mailbox config. A blank password keeps the saved one.
export function saveBoardIntake(projectName, fields) {
  const raw = loadRaw();
  // migrate a legacy flat file ({ project: {...} }) into boards{} on first save
  if (!raw.boards && !raw.inboxes) {
    const boards = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k !== 'accounts' && v && typeof v === 'object') { boards[k] = v; delete raw[k]; }
    }
    raw.boards = boards;
  }
  if (!raw.boards) raw.boards = {};
  const cur = raw.boards[projectName] || {};
  const next = { ...cur, ...fields };
  if (!fields.pass) next.pass = cur.pass; // don't clobber a saved password with a blank
  if (!next.host && !next.user) { delete raw.boards[projectName]; } // empty → remove
  else raw.boards[projectName] = next;
  writeRaw(raw);
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
      if (!v) continue;
      for (const x of (Array.isArray(v) ? v : [v])) {
        // a structured address header is { value: [{address}], text }; without a
        // .text field, String(x) would yield "[object Object]" and never match
        if (x && typeof x === 'object' && Array.isArray(x.value)) {
          for (const a of x.value) if (a.address) out.push(a.address.toLowerCase());
        } else {
          out.push(String(x?.text ?? x).toLowerCase());
        }
      }
    }
  }
  return out;
}

// The route whose toMatches matches one of the message's recipient addresses.
export function matchRoute(routes, parsed) {
  const addrs = recipientAddresses(parsed);
  for (const r of routes || []) {
    // toMatches may be a string or a list of addresses
    const needles = [].concat(r.toMatches || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
    if (needles.some((n) => addrs.some((a) => a.includes(n)))) return r;
  }
  return null;
}

// Pick the target project for a routed inbox message (or the default / null).
export function routeProject(routes, fallback, parsed) {
  return matchRoute(routes, parsed)?.project || fallback || null;
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
    const conf = merge(b);
    sources.push({ kind: 'board', label: name, conf, resolve: () => name, assigneeOf: () => conf.assignee || null });
  }
  for (const [name, inbox] of Object.entries(raw.inboxes || {})) {
    const conf = merge(inbox);
    sources.push({
      kind: 'inbox', label: name, conf,
      routes: inbox.routes || [],
      resolve: (parsed) => routeProject(inbox.routes, inbox.default, parsed),
      // per-route assignee, else the inbox default — assign incoming work to a developer
      assigneeOf: (parsed) => matchRoute(inbox.routes, parsed)?.assignee || inbox.assignee || null,
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

// per-source set of Message-IDs handled this run: a second idempotency key so a
// failed \Seen write (or markSeen:false) can't re-create a card we already made
const seenMessageIds = new Map(); // label → Set

async function pollSource(source, getProject) {
  const { conf, resolve, assigneeOf, label } = source;
  if (!conf.host || !conf.user || !conf.pass) { log(`intake: "${label}" missing host/user/pass`); return; }
  if (!seenMessageIds.has(label)) seenMessageIds.set(label, new Set());
  const handled = seenMessageIds.get(label);
  const maxPerPoll = conf.maxPerPoll ?? 50; // bound disk/cost from a flood of unseen mail

  const client = new ImapFlow({
    host: conf.host,
    port: conf.port || 993,
    secure: conf.secure !== false,
    auth: { user: conf.user, pass: conf.pass },
    logger: false,
  });
  // ImapFlow is an EventEmitter: errors raised outside awaited calls (socket
  // drops mid-idle) surface as 'error' events — without a listener they become
  // unhandled and crash the process. Log and let the awaited calls reject.
  client.on('error', (e) => log(`intake: "${label}" connection error: ${e.message}`));
  let lock;
  let created = 0;
  let processed = 0;
  try {
    await client.connect();
    lock = await client.getMailboxLock(conf.folder || 'INBOX');
    // only unseen messages; \Seen (default) is the primary idempotency key
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      if (processed >= maxPerPoll) { log(`intake: "${label}" hit maxPerPoll (${maxPerPoll}); remaining mail next tick`); break; }
      processed++;
      try {
        const parsed = await simpleParser(msg.source);
        const mid = parsed.messageId;
        if (mid && handled.has(mid)) {            // already made a card for this message this run
          if (conf.markSeen !== false) await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          continue;
        }
        const targetName = resolve(parsed);          // board → fixed; inbox → by recipient
        const project = targetName && getProject(targetName);
        if (!project) {
          log(`intake: "${label}" skipped a message — ${targetName
            ? `project "${targetName}" not registered`
            : `no route matched (to: ${recipientAddresses(parsed).join(', ') || 'none'})`}`);
        } else {
          const assignee = assigneeOf ? assigneeOf(parsed) : null; // auto-assign incoming work
          const card = await createCard(project.path, { ...emailToCardFields(parsed), assignee });
          if (card.ok) {
            created++;
            if (mid) { handled.add(mid); if (handled.size > 5000) handled.delete(handled.values().next().value); }
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
    lock?.release();
    await client.logout().catch(() => {});
  }
  if (created) log(`intake: "${label}" created ${created} card(s) from email`);
}

// Start a poll loop per source (board or routed inbox). Returns stop().
let lastOpts = null;
let stopCurrent = () => {};
// labels currently mid-poll — module-scoped (not per-closure) so a restart()
// can't begin an overlapping poll of the same source while the old one runs,
// which would race two createCard()s past the seenMessageIds dedup window
const inFlight = new Set();

function _startIntake({ getProject, onCard: onCardCb = () => {}, log: logFn = () => {} }) {
  onCard = onCardCb;
  log = logFn;
  const timers = [];
  for (const source of intakeSources()) {
    const tick = async () => {
      if (inFlight.has(source.label)) return; // previous poll (this run or a pre-restart one) still going
      inFlight.add(source.label);
      try { await pollSource(source, getProject); }
      catch (e) { log(`intake: "${source.label}" poll error: ${e.message}`); }
      finally { inFlight.delete(source.label); }
    };
    tick(); // poll immediately on boot
    const t = setInterval(tick, Math.max(30, source.conf.pollSeconds || 300) * 1000);
    t.unref();
    timers.push(t);
  }
  if (timers.length) log(`intake: polling ${timers.length} mailbox(es)`);
  return () => timers.forEach(clearInterval);
}

export function startIntake(opts) {
  lastOpts = opts;
  stopCurrent = _startIntake(opts);
  return () => stopCurrent();
}

// Re-read intake.json and restart the poll loops (after a UI config change).
export function restartIntake() {
  if (!lastOpts) return;
  stopCurrent();
  stopCurrent = _startIntake(lastOpts);
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
  client.on('error', () => {}); // out-of-call errors are non-fatal; awaited calls reject on their own
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
