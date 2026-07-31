import fs from 'node:fs';
import path from 'node:path';
import { withRepoLock, ensureGitignored } from './board.js';

// Deterministic header/body heuristics that classify an inbound email BEFORE
// any card exists. Runs inside pollSource() on the parsed message mailparser
// already built — no LLM call, no network, pure function.
//
// Signals split strong/weak so a single ambiguous match doesn't silently drop
// real work: any strong match, or 2+ weak matches, is spam; a lone weak match
// is held as unclear instead (see the verdict logic below).
const ESP_HEADERS = [
  'list-id', 'x-campaign-id', 'x-campaignid', 'x-mailgun-sid', 'x-sg-eid', 'x-sg-id',
  'x-ses-outgoing', 'x-mc-user', 'x-mandrill-user', 'x-mailchimp-id', 'x-klaviyo-message-id',
];
const OOO_RE = /\b(out[- ]of[- ]office|automatic reply|auto[- ]?reply|away from (my |the )?(office|email|desk))\b/i;
const BOUNCE_ADDR_RE = /\b(mailer-daemon|postmaster)\b/i;
const BOUNCE_SUBJECT_RE = /\b(undeliverable|delivery status notification|returned to sender|delivery failure|mail delivery failed)\b/i;
const FOOTER_RE = /unsubscribe|view (this|it) (email|message)? ?in (your )?browser|manage your (email )?preferences/i;
const MIN_BODY_LEN = 20; // shorter than this and there's rarely enough to act on

const SIGNAL_LABELS = {
  'list-unsubscribe': 'has a List-Unsubscribe header',
  'precedence-bulk': 'Precedence header is bulk/list/junk',
  'auto-submitted-bulk': 'Auto-Submitted header marks it automated',
  'esp-header': 'carries a bulk-mail service header',
  'noreply-sender': 'sent from a no-reply address',
  'unsubscribe-footer': 'body has an unsubscribe/view-in-browser footer',
  'html-only': 'HTML-only body with no text part',
  'empty-body': 'body is empty',
  'short-body': 'body is very short',
  'no-subject': 'no meaningful subject',
  'auto-reply': 'looks like an out-of-office/auto-reply',
  'bounce': 'looks like a bounce/mailer-daemon notice',
};

function describe(signals) {
  return signals.map((s) => SIGNAL_LABELS[s] || s).join('; ');
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

function headerText(headers, name) {
  if (!headers || typeof headers.get !== 'function') return '';
  const v = headers.get(name);
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String(x.text ?? x.value ?? x) : String(x))).join(' ');
  if (typeof v === 'object') return String(v.text ?? v.value ?? '');
  return String(v);
}

function hasHeader(headers, name) {
  return !!(headers && typeof headers.has === 'function' && headers.has(name));
}

// Pure: a parsed email → { verdict: 'work' | 'spam' | 'unclear', reason, signals }.
export function screenEmail(parsed) {
  const headers = parsed?.headers;
  const fromAddr = String(parsed?.from?.value?.[0]?.address || parsed?.from?.text || '').toLowerCase();
  const subject = String(parsed?.subject || '').trim();
  const text = String(parsed?.text || '').trim();
  const html = parsed?.html;

  const spamStrong = [];
  const spamWeak = [];

  if (hasHeader(headers, 'list-unsubscribe')) spamStrong.push('list-unsubscribe');

  const precedence = headerText(headers, 'precedence').toLowerCase();
  if (/\b(bulk|list|junk)\b/.test(precedence)) spamStrong.push('precedence-bulk');

  const autoSubmitted = headerText(headers, 'auto-submitted').toLowerCase();
  // 'auto-replied' is an out-of-office style reply — surfaced below as unclear,
  // not folded into the bulk-mail signal here.
  if (autoSubmitted && autoSubmitted !== 'no' && autoSubmitted !== 'auto-replied') {
    spamStrong.push('auto-submitted-bulk');
  }

  if (ESP_HEADERS.some((h) => hasHeader(headers, h))) spamStrong.push('esp-header');

  if (/no-?reply@/i.test(fromAddr)) spamWeak.push('noreply-sender');

  if (FOOTER_RE.test(text || stripHtml(html))) spamWeak.push('unsubscribe-footer');

  if (!text && html) spamWeak.push('html-only');

  const unclear = [];
  if (!text) unclear.push('empty-body');
  else if (text.length < MIN_BODY_LEN) unclear.push('short-body');

  if (!subject || !/[a-z0-9]/i.test(subject)) unclear.push('no-subject');

  if (autoSubmitted === 'auto-replied' || OOO_RE.test(subject)) unclear.push('auto-reply');

  if (BOUNCE_ADDR_RE.test(fromAddr) || BOUNCE_SUBJECT_RE.test(subject)) unclear.push('bounce');

  if (spamStrong.length || spamWeak.length >= 2) {
    const matched = [...spamStrong, ...spamWeak];
    return { verdict: 'spam', reason: `Looks like marketing/automated mail (${describe(matched)})`, signals: matched };
  }

  const held = [...unclear, ...spamWeak]; // a lone weak spam signal reads as ambiguous, not spam
  if (held.length) {
    return { verdict: 'unclear', reason: `Unclear whether this is real work (${describe(held)})`, signals: held };
  }

  return { verdict: 'work', reason: 'No spam or unclear signals matched', signals: [] };
}

const AUDIT_FILE = path.join('.todomd', 'intake-audit.jsonl');
const AUDIT_IGNORE_LINE = '.todomd/intake-audit.jsonl';
const AUDIT_MAX_LINES = 500; // an operational log, not board history — cap so it can't grow unbounded

// One JSON line per screened message: timestamp, source label, from, subject,
// messageId, verdict, reason. Trims to the last AUDIT_MAX_LINES on every write.
export function appendIntakeAudit(repoPath, record) {
  return withRepoLock(repoPath, async () => {
    ensureGitignored(repoPath, AUDIT_IGNORE_LINE);
    const file = path.join(repoPath, AUDIT_FILE);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* first write */ }
    lines.push(JSON.stringify(record));
    if (lines.length > AUDIT_MAX_LINES) lines = lines.slice(-AUDIT_MAX_LINES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return { ok: true };
  });
}
