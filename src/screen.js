import fs from 'node:fs';
import path from 'node:path';
import { withRepoLock, ensureGitExcluded } from './board.js';

// Deterministic header/body heuristics that classify an inbound email BEFORE
// any card exists. Runs inside pollSource() on the parsed message mailparser
// already built — no LLM call, no network, pure function.
//
// Signals split strong/weak so a single ambiguous match doesn't silently drop
// real work: any strong match, or 2+ weak matches, is spam; a lone weak match
// is held as unclear instead (see the verdict logic below).
const ESP_HEADERS = [
  'list-id', 'x-campaign', 'x-campaign-id', 'x-campaignid', 'x-mailgun-sid', 'x-sg-eid', 'x-sg-id',
  'x-ses-outgoing', 'x-mc-user', 'x-mandrill-user', 'x-mailchimp-id', 'x-klaviyo-message-id',
];
const AUTO_REPLY_SUBJECT_RE = /^(?:automatic reply|auto[- ]?reply|out[- ]of[- ](?:the[- ])?office)(?:\s*:|\s*$)/i;
const AUTO_REPLY_BODY_RE = /(?:^|\n)\s*(?:this is (?:an? )?automatic reply\b|i(?: am|'m) (?:currently )?(?:out[- ]of[- ](?:the[- ])?office|on vacation|away from (?:my |the )?(?:office|email|desk))\b)/i;
const BOUNCE_ADDR_RE = /\b(mailer-daemon|postmaster)\b/i;
const BOUNCE_SUBJECT_RE = /^(?:undeliverable|delivery status notification|returned to sender|delivery (?:has )?failed(?:\s+to\b[^:]*)?|delivery failure|mail delivery failed)(?:\s*:|\s*$|\s*\()/i;
const FOOTER_RE = /(?:click here to unsubscribe|unsubscribe from (?:this|these|our) emails?|(?:^|\n|\s{2,})unsubscribe|view(?: (?:this|the|your|an?|it))?(?: (?:email|message))? in (?:an? |your )?browser|manage your (?:email )?preferences)[\s.!]*$/i;
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

// Is `name` present on the message? The headers Map alone is NOT enough:
// mailparser folds every List-* header into one structured entry
// (headers.get('list') = { unsubscribe, id, … }) and leaves no
// `list-unsubscribe` / `list-id` key behind — so a Map-only check silently
// misses the two strongest newsletter signals we have. headerLines is the raw
// [{ key, line }] array mailparser always preserves, with lowercased keys, so
// consulting it makes presence work uniformly for every header. The normalized
// `list` object is read too, for callers that hand us headers without lines.
function hasHeader(parsed, name) {
  const headers = parsed?.headers;
  if (headers && typeof headers.has === 'function' && headers.has(name)) return true;

  const lines = parsed?.headerLines;
  if (Array.isArray(lines) && lines.some((h) => String(h?.key || '').toLowerCase() === name)) return true;

  const list = headers && typeof headers.get === 'function' ? headers.get('list') : null;
  if (list && typeof list === 'object') {
    if (name === 'list-unsubscribe') return !!list.unsubscribe;
    if (name === 'list-id') return !!list.id;
  }
  return false;
}

// Pure: a parsed email → { verdict: 'work' | 'spam' | 'unclear', reason, signals }.
export function screenEmail(parsed) {
  const headers = parsed?.headers;
  const fromAddr = String(parsed?.from?.value?.[0]?.address || parsed?.from?.text || '').toLowerCase();
  const subject = String(parsed?.subject || '').trim();
  const text = String(parsed?.text || '').trim();
  const html = parsed?.html;
  const bodyText = [text, stripHtml(html)].filter(Boolean).join('\n');

  const spamStrong = [];
  const spamWeak = [];

  if (hasHeader(parsed, 'list-unsubscribe')) spamStrong.push('list-unsubscribe');

  const precedence = headerText(headers, 'precedence').toLowerCase();
  if (/\b(bulk|list|junk)\b/.test(precedence)) spamStrong.push('precedence-bulk');

  // RFC 3834 allows parameters after the keyword ("auto-replied; owner=x"), so
  // compare only the leading token — an exact match on the whole header value
  // would read `auto-replied; owner=…` as bulk and silently drop an
  // out-of-office that belongs in the unclear bucket below.
  const autoSubmitted = headerText(headers, 'auto-submitted').toLowerCase().split(';')[0].trim();
  if (autoSubmitted && autoSubmitted !== 'no' && autoSubmitted !== 'auto-replied') {
    spamStrong.push('auto-submitted-bulk');
  }

  if (ESP_HEADERS.some((h) => hasHeader(parsed, h))) spamStrong.push('esp-header');

  if (/no-?reply(?:\+[^@]+)?@/i.test(fromAddr)) spamWeak.push('noreply-sender');

  if (FOOTER_RE.test(bodyText)) spamWeak.push('unsubscribe-footer');

  if (!text && html) spamWeak.push('html-only');

  const unclear = [];
  if (!text) unclear.push('empty-body');
  else if (text.length < MIN_BODY_LEN) unclear.push('short-body');

  const subjectCore = subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
  const noSubjectPlaceholder = /^[[(<]?\s*no\s+subject\s*[\])>]?$/i.test(subjectCore);
  if (!subjectCore || noSubjectPlaceholder || !/[a-z0-9]/i.test(subjectCore)) unclear.push('no-subject');

  if (autoSubmitted === 'auto-replied' || AUTO_REPLY_SUBJECT_RE.test(subject) || AUTO_REPLY_BODY_RE.test(bodyText)) {
    unclear.push('auto-reply');
  }

  const contentType = headers && typeof headers.get === 'function' ? headers.get('content-type') : null;
  const deliveryReport = String(contentType?.value || contentType || '').toLowerCase() === 'multipart/report'
    && String(contentType?.params?.['report-type'] || '').toLowerCase() === 'delivery-status';
  if (BOUNCE_ADDR_RE.test(fromAddr) || BOUNCE_SUBJECT_RE.test(subject) || deliveryReport) unclear.push('bounce');

  // A delivery-status notice or explicit auto-reply is automated by design,
  // so Auto-Submitted commonly appears alongside it. Those explicit message
  // types belong in Needs Human; do not let the generic automation signal drop
  // them as spam. Keep every matched signal in the explanation for auditing.
  if (unclear.includes('bounce') || unclear.includes('auto-reply')) {
    const held = [...unclear, ...spamStrong, ...spamWeak];
    return { verdict: 'unclear', reason: `Unclear whether this is real work (${describe(held)})`, signals: held };
  }

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

export function findIntakeAudit(repoPath, intakeKey) {
  if (!intakeKey) return null;
  try {
    const lines = fs.readFileSync(path.join(repoPath, AUDIT_FILE), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(lines[i]);
        if (record.intakeKey === intakeKey) return record;
      } catch { /* ignore a corrupt operational-log line */ }
    }
  } catch { /* no audit yet */ }
  return null;
}

// One JSON line per screened message — timestamp, source label, from, subject,
// messageId, verdict, reason, and the card id when one was created. Every
// verdict is logged, not just the screened-out ones: a `spam` line is the only
// record that a message ever arrived, and the `work`/`unclear` lines are what
// make the file a complete "which email became which card" trace.
// Trims to the last AUDIT_MAX_LINES on every write.
export function appendIntakeAudit(repoPath, record) {
  return withRepoLock(repoPath, async () => {
    ensureGitExcluded(repoPath, AUDIT_IGNORE_LINE);
    const file = path.join(repoPath, AUDIT_FILE);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* first write */ }
    if (record?.intakeKey && lines.some((line) => {
      try { return JSON.parse(line).intakeKey === record.intakeKey; }
      catch { return false; }
    })) return { ok: true, duplicate: true };
    lines.push(JSON.stringify(record));
    if (lines.length > AUDIT_MAX_LINES) lines = lines.slice(-AUDIT_MAX_LINES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return { ok: true };
  });
}
