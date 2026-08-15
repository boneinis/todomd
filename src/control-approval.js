import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CONTROL_MINUTES = 5;
export const MAX_CONTROL_MINUTES = 15;

export function controlApprovalFile() {
  return path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'control-approval.json');
}

export function readControlApproval({ now = Date.now() } = {}) {
  const file = controlApprovalFile();
  let value;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('wrong owner');
    if ((st.mode & 0o077) !== 0) throw new Error('permissions are too broad');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch { return { active: false, file, reason: 'control is disabled' }; }

  const expiresAt = Number(value?.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { active: false, file, reason: 'control approval expired', expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  }
  if (expiresAt - now > MAX_CONTROL_MINUTES * 60_000) {
    return { active: false, file, reason: 'control approval exceeds the maximum lifetime', expiresAt };
  }
  return { active: true, file, expiresAt };
}

export function enableControlApproval({ minutes = DEFAULT_CONTROL_MINUTES, now = Date.now() } = {}) {
  minutes = Number(minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CONTROL_MINUTES) {
    throw new Error(`minutes must be an integer from 1 to ${MAX_CONTROL_MINUTES}`);
  }
  const file = controlApprovalFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const expiresAt = now + minutes * 60_000;
  const tmp = path.join(dir, `.control-approval-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, expiresAt }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return { active: true, file, expiresAt, minutes };
}

export function disableControlApproval() {
  const file = controlApprovalFile();
  try { fs.unlinkSync(file); return { active: false, file, removed: true }; }
  catch { return { active: false, file, removed: false }; }
}
