// Private child-process entry point. A detached supervisor stays the process
// group leader until every contained descendant has stopped. Recovery sends a
// nonce-authenticated request to this supervisor; it never signals a saved PID.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localRef, machineIdentity, privateDirectory, regularFile, writeOnce, groupAlive, pause, sealRegistration, cleanupSocket } from './delivery-local-state.js';

let received = false;
process.on('disconnect', () => { if (!received) process.exit(0); });
const send = type => { if (process.connected) process.send({ type }, () => {}); };
process.once('message', async input => {
  received = true;
  let server, socketPath, directory, stopping = false, killTimer, finished = false;
  function stop() {
    if (stopping || finished) return;
    stopping = true;
    try { writeOnce(path.join(directory, 'closed.json')); } catch { /* keep the group held if publication failed */ }
    // This process is the actual group leader. No recovered/recycled PID is
    // trusted for signaling, and the signal handler prevents recursive TERM.
    process.kill(-process.pid, 'SIGTERM');
    killTimer = setTimeout(() => process.kill(-process.pid, 'SIGKILL'), input.graceMs);
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    const ref = localRef(input.ref, input.ref?.backend);
    directory = input.directory; privateDirectory(directory);
    const machine = machineIdentity(), nonce = randomUUID();
    socketPath = `/tmp/todomd-delivery-${nonce}.sock`;
    server = net.createServer(socket => {
      let data = '';
      socket.setTimeout(1000, () => socket.destroy());
      socket.on('error', () => {});
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
    const socketStat = fs.lstatSync(socketPath, { bigint: true });
    const registration = sealRegistration({ format: 1, ref, ...machine, pid: process.pid, nonce, socket: socketPath,
      socket_ino: socketStat.ino.toString(), socket_dev: socketStat.dev.toString() });
    process.on('exit', () => cleanupSocket(registration));
    // This publication MUST precede the closed-barrier check and every spawn.
    // Close either sees this live group or wins the barrier before we can start.
    if (!writeOnce(path.join(directory, 'supervisor.json'), registration)) throw new Error('Supervisor already registered.');
    if (stopping || regularFile(path.join(directory, 'closed.json'))) {
      send('closed');
    } else {
      const log = fs.openSync(path.join(directory, 'output.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      let child;
      try {
        if (!fs.fstatSync(log).isFile()) throw new Error('Invalid execution output file.');
        child = spawn(input.job.command, input.job.args, { cwd: input.job.cwd,
          env: { ...process.env, ...input.job.env }, detached: false, stdio: ['ignore', log, log] });
      } finally { fs.closeSync(log); }
      const outcome = await new Promise(resolve => {
        child.once('spawn', () => send('started'));
        child.once('error', () => resolve({ spawn_failed: true }));
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      // Leader exit alone is insufficient: background descendants retain this
      // supervisor and ownership until they leave the process group or stop.
      while (true) {
        try { if (!await groupAlive(process.pid, true)) break; } catch { /* uncertain, retain ownership */ }
        await pause(50);
      }
      writeOnce(path.join(directory, 'result.json'), outcome);
    }
    writeOnce(path.join(directory, 'closed.json'));
    finished = true; clearTimeout(killTimer);
    server.close();
    // Exit, rather than waiting for stale control sockets to drain indefinitely.
    process.exit(0);
  } catch {
    // If startup or persistence fails after registration, preserve uncertainty
    // and stop our own group. Do not publish a false completion receipt.
    if (directory) {
      try { writeOnce(path.join(directory, 'closed.json')); } catch { /* inspection fails closed */ }
    }
    process.kill(-process.pid, 'SIGKILL');
  }
});
