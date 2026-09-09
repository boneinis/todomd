// Optional reviewed adapter protocol. Human-readable output is never used to
// infer approval, job completion, or a candidate failure.
export function remoteCiStatus(output, head) {
  const lines = String(output || '').split('\n').filter(line => line.startsWith('TODOMD_CI_STATUS '));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0].slice('TODOMD_CI_STATUS '.length));
    if (value.head !== head || !/^[a-f0-9]{40,64}$/.test(head)) return null;
    if (!['running', 'passed', 'failed', 'blocked', 'unknown'].includes(value.state)) return null;
    if (value.run_id != null && (typeof value.run_id !== 'string' || !/^[\w.-]{1,160}$/.test(value.run_id))) return null;
    if (['running', 'passed', 'failed'].includes(value.state) && !value.run_id) return null;
    const reasons = ['approval_required', 'approval_stale', 'admission_contention', 'remote_state_unknown'];
    if (value.state === 'blocked' && !reasons.includes(value.reason)) return null;
    return { state: value.state, reason: value.reason && reasons.includes(value.reason) ? value.reason : '',
      run_id: value.run_id || '', head };
  } catch { return null; }
}
