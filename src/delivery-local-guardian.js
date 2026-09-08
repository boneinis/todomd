// A second, live member of the supervisor's group. It holds the group identity
// while stopping orphaned writers, so signaling never relies on a saved PID.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localRef, machineIdentity, readRegistration, writeOnce, sealRegistration, cleanupSocket } from './delivery-local-state.js';

let received = false, stopping = false, finished = false, group, directory, graceMs, verified = false;
function stop() {
  if (!verified || stopping || finished) return;
  stopping = true;
  try { writeOnce(path.join(directory, 'closed.json')); } catch { /* closure remains uncertain */ }
  process.kill(-group, 'SIGTERM');
  setTimeout(() => process.kill(-group, 'SIGKILL'), graceMs);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('disconnect', () => { if (!received) process.exit(0); else stop(); });
process.once('message', async input => {
  received = true;
  try {
    const ref = localRef(input.ref, input.ref?.backend);
    directory = input.directory; group = input.group; graceMs = input.graceMs;
    if (!Number.isSafeInteger(group) || group < 2 || !Number.isSafeInteger(graceMs) || graceMs < 10 || graceMs > 10000) throw new Error('Invalid guardian input.');
    // Verify our CURRENT membership. This process never leaves this group; its
    // continued presence prevents group-ID reuse until escalation completes.
    const currentGroup = Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 1000 }).trim());
    if (currentGroup !== group || group === process.pid) throw new Error('Guardian is outside its execution group.');
    verified = true;
    const supervisor = readRegistration(directory, ref), machine = machineIdentity();
    if (supervisor?.pid !== group || supervisor.host !== machine.host || supervisor.boot !== machine.boot) throw new Error('Guardian authority does not match.');
    const nonce = randomUUID(), socketPath = `/tmp/todomd-delivery-${nonce}.sock`;
    const server = net.createServer(socket => {
      let data = '';
      socket.setTimeout(1000, () => socket.destroy()); socket.on('error', () => {});
      socket.on('data', chunk => {
        data += chunk;
        if (data.length > 4096) return socket.destroy();
        if (!data.includes('\n')) return;
        let request;
        try { request = JSON.parse(data.trim()); } catch { return socket.destroy(); }
        if (request.nonce !== nonce || !['status', 'stop'].includes(request.action)) return socket.destroy();
        socket.end(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
        if (request.action === 'stop') stop();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    const stat = fs.lstatSync(socketPath, { bigint: true });
    const registration = sealRegistration({ format: 1, role: 'guardian', ref, ...machine,
      pid: process.pid, group_pid: group, supervisor_checksum: supervisor.checksum, nonce, socket: socketPath,
      socket_ino: stat.ino.toString(), socket_dev: stat.dev.toString() });
    process.on('exit', () => cleanupSocket(registration));
    if (!writeOnce(path.join(directory, 'guardian.json'), registration)) throw new Error('Guardian already registered.');
    process.on('message', message => {
      // Only the owning supervisor's IPC channel can finish a drained group.
      if (message?.type === 'finish' && !stopping) { finished = true; process.exit(0); }
    });
    if (!process.connected || stopping) stop();
    else process.send({ type: 'ready', pid: process.pid }, error => { if (error) stop(); });
  } catch {
    if (verified) stop(); else process.exit(1);
  }
});
