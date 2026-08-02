// Small pieces of request-handling logic shared between the HTTP API
// (src/server.js) and the MCP server (src/mcp-server.js), so the two
// front-ends enforce identical sanitization/path rules instead of drifting.
import fs from 'node:fs';
import path from 'node:path';

// Human-editable assignee field: free text, but stripped of anything that
// could break frontmatter YAML when patched back onto a card.
export function sanitizeAssignee(v) {
  return String(v || '').replace(/[^\w.@ -]/g, '').trim();
}

// Resolve an attachment path the same way the /api/file HTTP route does:
// STRICTLY confined to .todomd/attachments/ (realpath both sides so a
// symlink inside attachments/ can't read repo secrets) — a viewer-token
// holder must never be able to reach arbitrary repo files this way.
export function resolveAttachmentFile(projectPath, rel) {
  const attDir = path.join(projectPath, '.todomd', 'attachments');
  const abs = path.resolve(projectPath, String(rel || ''));
  if (!abs.startsWith(attDir + path.sep)) return { ok: false, error: 'not found' };
  let root, real;
  try { root = fs.realpathSync(attDir); real = fs.realpathSync(abs); } catch { return { ok: false, error: 'not found' }; }
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) {
    return { ok: false, error: 'not found' };
  }
  return { ok: true, real, ext: path.extname(real).toLowerCase() };
}
