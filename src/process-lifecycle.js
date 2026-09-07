import { execFile } from 'node:child_process';

// Every runner/CI child is detached into its own local process group. This
// never signals accepted remote jobs, which are outside that local group.
export function signalChild(child, signal, { processGroup = true } = {}) {
  if (processGroup && child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* try leader */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

async function alive(child, processGroup) {
  if (!child.pid) return false;
  if (!processGroup || process.platform === 'win32') {
    try { process.kill(child.pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
  }
  try { process.kill(-child.pid, 0); } catch (err) { return err.code !== 'ESRCH'; }
  // A killed orphan may remain a zombie until the host init reaps it (notably
  // containers). Zombies cannot execute or write. Do not mistake them for a
  // live writer; if process inspection fails, fail closed instead.
  return new Promise((resolve) => execFile('ps', ['-eo', 'pgid=,stat='], (err, stdout) => {
    if (err) return resolve(true);
    resolve(stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && !state?.startsWith('Z');
    }));
  }));
}

export function stopChild(child, { graceMs = Number(process.env.TODOMD_KILL_GRACE_MS) || 10000, processGroup = true } = {}) {
  if (child.todomdStop) return child.todomdStop;
  // Install the barrier synchronously, before a close callback can finalize a
  // stage. Never clear escalation merely because the leader closes its pipes.
  child.todomdStop = (async () => {
    signalChild(child, 'SIGTERM', { processGroup });
    const started = Date.now();
    let escalated = false;
    while (await alive(child, processGroup)) {
      if (Date.now() - started >= graceMs) {
        if (!escalated) {
          escalated = true;
          signalChild(child, 'SIGKILL', { processGroup });
        } else if (Date.now() - started >= graceMs + 5000) {
          return { ok: false, error: `could not confirm process group ${child.pid} stopped; cancellation is incomplete` };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Node's close handler must also reap the leader before cancellation is
    // acknowledged. exitCode/signalCode are set on exit, before close.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('close', resolve));
    }
    return { ok: true };
  })();
  return child.todomdStop;
}

export async function awaitChildStop(child) {
  if (!child.todomdStop) return;
  const result = await child.todomdStop;
  if (!result.ok) throw new Error(result.error);
}
