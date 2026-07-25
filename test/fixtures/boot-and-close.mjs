// Boots a real server against a registered board (so the file watchers and the
// rescan timer are actually live), opens a WebSocket against it, then closes it
// — and must exit on its own. Run as a child process by test/server.test.js:
// whether the process exits IS the assertion (an in-process test can't see a
// leaked handle, and a leaked one hangs the whole suite instead of failing).
import { WebSocket } from 'ws';
import { addProject } from '../../src/registry.js';
import { startServer } from '../../src/server.js';

if (process.env.TODOMD_TEST_REPO) addProject(process.env.TODOMD_TEST_REPO);
const srv = await startServer({ port: 0 });
const port = srv.server.address().port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${srv.token}`);
await new Promise((resolve) => { ws.on('open', resolve); ws.on('error', resolve); });
srv.close();
