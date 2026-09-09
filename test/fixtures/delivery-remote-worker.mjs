import http from 'node:http';
import { createRemoteDeliveryWorker } from '../../src/delivery-remote-worker.js';

// Isolated crash-test host. All configuration arrives over test-owned IPC.
process.once('message', ({ root, authority, job, credential, port }) => {
  const handler = createRemoteDeliveryWorker(root, { enabled: true, expectedAuthority: authority, job,
    authenticate: token => token === credential, authorizeStart: () => true,
    localOptions: { graceMs: 50, closeTimeoutMs: 3000 } });
  const server = http.createServer(handler);
  server.listen(port, '127.0.0.1', () => process.send({ ready: true }));
});
