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
const configFile = () => path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'intake.json');

// Returns a flat map: project name → resolved mailbox config (account creds merged in).
export function loadIntakeConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  if (raw.boards && typeof raw.boards === 'object') {
    const accounts = raw.accounts || {};
    const out = {};
    for (const [name, board] of Object.entries(raw.boards)) {
      const acct = board && board.account ? accounts[board.account] : null;
      out[name] = { ...(acct || {}), ...board }; // board keys (folder, etc.) win over account
    }
    return out;
  }
  return raw; // legacy: top-level keys are project names with inline creds
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

async function pollOne(name, conf, getProject) {
  const project = getProject(name);
  if (!project) { log(`intake: project "${name}" not registered — skipping`); return; }
  if (!conf.host || !conf.user || !conf.pass) { log(`intake: "${name}" missing host/user/pass`); return; }

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
        const fields = emailToCardFields(parsed);
        const card = await createCard(project.path, fields);
        if (card.ok) {
          created++;
          for (const att of (parsed.attachments || []).slice(0, conf.maxAttachments ?? 5)) {
            if (att?.content && att?.filename) {
              try { await attachCard(project.path, card.id, att.filename, att.content); } catch {}
            }
          }
          onCard(project, card.id);
        }
        if (conf.markSeen !== false) await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      } catch (e) {
        log(`intake: "${name}" failed on a message: ${e.message}`);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  if (created) log(`intake: "${name}" created ${created} card(s) from email`);
}

// Start a poll loop per configured project. Returns a stop() to clear timers.
export function startIntake({ getProject, onCard: onCardCb = () => {}, log: logFn = () => {} }) {
  onCard = onCardCb;
  log = logFn;
  const cfg = loadIntakeConfig();
  const timers = [];
  for (const [name, conf] of Object.entries(cfg)) {
    const tick = () => pollOne(name, conf, getProject).catch((e) => log(`intake: "${name}" poll error: ${e.message}`));
    tick(); // poll immediately on boot
    const t = setInterval(tick, Math.max(30, conf.pollSeconds || 300) * 1000);
    t.unref();
    timers.push(t);
  }
  if (timers.length) log(`intake: polling ${timers.length} mailbox(es)`);
  return () => timers.forEach(clearInterval);
}

// One-shot connection test (for `todomd intake-test`): no card creation.
export async function testIntake(name) {
  const conf = loadIntakeConfig()[name];
  if (!conf) return { ok: false, error: `no intake config for "${name}" in ~/.todomd/intake.json` };
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
    return { ok: true, folder: conf.folder || 'INBOX', unseen };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
