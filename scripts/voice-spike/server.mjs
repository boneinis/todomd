import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.TODOMD_VOICE_SPIKE_PORT || 41731);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/local-speech-wake.js', ['local-speech-wake.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const entry = files.get(pathname);
  if (!entry || req.method !== 'GET') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found\n');
  }
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    'content-type': entry[1],
    'permissions-policy': 'microphone=(self)',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  return res.end(fs.readFileSync(path.join(root, entry[0])));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`TODOMD local wake spike: http://127.0.0.1:${port}/`);
  console.log('This harness has no board routes and its browser CSP blocks network connections.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
