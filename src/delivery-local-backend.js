import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localRef, refKey, machineIdentity, privateDirectory, regularFile, writeOnce, readRegistration, readGuardian, groupAlive, pause, cleanupSocket } from './delivery-local-state.js';

const worker = fileURLToPath(new URL('./delivery-local-supervisor.js', import.meta.url));
function control(registration, action) {
  return new Promise(resolve => {
    const socket = net.createConnection(registration.socket);
    let data = '';
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(JSON.stringify({ nonce: registration.nonce, action }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 4096) return finish(false);
      if (!data.includes('\n')) return;
      try { const reply = JSON.parse(data.trim()); finish(reply.ok === true && reply.pid === registration.pid); }
      catch { finish(false); }
    });
    socket.on('end', () => finish(false));
  });
}
function validJob(job) {
  return job?.containment === 'local_process_group' && typeof job.command === 'string' && path.isAbsolute(job.command) &&
    Array.isArray(job.args) && job.args.every(a => typeof a === 'string') &&
    typeof job.cwd === 'string' && path.isAbsolute(job.cwd) &&
    (job.env === undefined || job.env && typeof job.env === 'object' && !Array.isArray(job.env) && Object.values(job.env).every(v => typeof v === 'string'));
}

// A concrete POSIX backend, still opt-in and unattached to public dispatch.
// resolveJob/authorizeStart are trusted server capabilities, never card fields.
export function createLocalDeliveryBackend(directory, { enabled = false, name = 'local', resolveJob, authorizeStart,
  graceMs = 1000, closeTimeoutMs = 10000 } = {}) {
  const root = path.resolve(directory);
  if (!Number.isSafeInteger(graceMs) || graceMs < 10 || graceMs > 10000 ||
    !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < graceMs + 1000 || closeTimeoutMs > 30000) {
    throw new Error('Invalid local execution stop deadlines.');
  }
  function locate(value, create = false) {
    if (enabled !== true) throw new Error('Local delivery execution is not enabled.');
    const ref = localRef(value, name), machine = machineIdentity();
    const dir = path.join(root, refKey(ref));
    if (privateDirectory(root, create)) privateDirectory(dir, create);
    return { ref, dir, machine };
  }
  async function inspectAt({ ref, dir, machine }) {
    const closed = regularFile(path.join(dir, 'closed.json'));
    const registration = readRegistration(dir, ref);
    const sameMachine = registration && registration.host === machine.host && registration.boot === machine.boot;
    const guardian = sameMachine || !registration ? readGuardian(dir, ref, registration) : null;
    const absent = sameMachine && !await groupAlive(registration.pid);
    let state = 'unknown';
    // Persisted no-job closure remains terminal even if a delayed, harmless
    // supervisor subsequently registers and exits at the closed barrier.
    if (closed && regularFile(path.join(dir, 'no-job.json'))) state = 'stopped';
    else if (!registration) state = 'unknown';
    else if (sameMachine) {
      if (absent) state = closed ? 'stopped' : 'unknown';
      else if (await control(registration, 'status') || guardian && await control(guardian, 'status')) state = 'running';
    }
    if (state === 'stopped' && absent) {
      cleanupSocket(registration);
      if (guardian) cleanupSocket(guardian);
    }
    return { ...ref, state, closed: closed && state === 'stopped', reference: `local-execution:${refKey(ref)}` };
  }
  return {
    async start(value) {
      const location = locate(value), { ref, dir } = location;
      if (typeof authorizeStart !== 'function' || await authorizeStart(ref) !== true) throw new Error('Local execution admission is not authorized.');
      privateDirectory(root, true); privateDirectory(dir, true);
      if (regularFile(path.join(dir, 'closed.json'))) return { accepted: false, closed: true };
      if (!writeOnce(path.join(dir, 'start.json'), ref)) return { accepted: false, replayed: true };
      const job = await resolveJob?.(ref);
      if (!validJob(job) || await authorizeStart(ref) !== true) throw new Error('Local execution job or admission is invalid.');
      if (regularFile(path.join(dir, 'closed.json'))) return { accepted: false, closed: true };
      // No credentials or commands enter durable registration. They travel only
      // over this parent/child IPC channel; agent output stays in a private log.
      return new Promise((resolve, reject) => {
        const child = fork(worker, [], { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let settled = false;
        const finish = (error, result) => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (child.connected) child.disconnect(); child.unref();
          if (error) reject(new Error('Local supervisor acknowledgement is unavailable.')); else resolve(result);
        };
        const timer = setTimeout(() => finish(true), 10000);
        child.on('error', () => finish(true));
        child.on('exit', () => finish(true));
        child.on('message', message => {
          if (message?.type === 'started') finish(false, { accepted: true });
          else if (message?.type === 'closed') finish(false, { accepted: false, closed: true });
        });
        child.send({ ref, directory: dir, job, graceMs }, error => { if (error) finish(true); });
      });
    },
    async close(value) {
      const location = locate(value, true), { dir, ref } = location;
      // The barrier publishes before lookup. A supervisor not yet registered
      // must observe it after registering and may never start its job.
      writeOnce(path.join(dir, 'closed.json'));
      const registration = readRegistration(dir, ref);
      const sameMachine = registration && registration.host === location.machine.host && registration.boot === location.machine.boot;
      const guardian = sameMachine || !registration ? readGuardian(dir, ref, registration) : null;
      if (!registration) writeOnce(path.join(dir, 'no-job.json'));
      if (sameMachine) {
        await control(registration, 'stop');
        if (guardian) await control(guardian, 'stop');
      }
      const deadline = Date.now() + closeTimeoutMs;
      do {
        // A transient process-table failure is not stop evidence. Keep trying
        // within the existing bound; only a verified observation can close.
        try { if ((await inspectAt(location)).state === 'stopped') return { closed: true }; }
        catch { /* retain uncertainty and retry inspection */ }
        await pause(50);
      } while (Date.now() < deadline);
      throw new Error('Local execution stop is unconfirmed; ownership must remain held.');
    },
    async inspect(value) { return inspectAt(locate(value)); },
  };
}
