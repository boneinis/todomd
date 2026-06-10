import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { installLauncher } from '../src/launcher.js';

test('macOS: creates a valid .app on the Desktop with resolved paths', () => {
  const home = tmp('home');
  const r = installLauncher({ nodeBin: '/usr/bin/node', todomdBin: '/opt/todomd/bin/todomd.js', port: 7337, home, platform: 'darwin' });
  const app = path.join(home, 'Desktop', 'todomd.app');
  assert.equal(r.path, app);
  const exe = fs.readFileSync(path.join(app, 'Contents/MacOS/todomd'), 'utf8');
  assert.match(exe, /\/usr\/bin\/node/);
  assert.match(exe, /\/opt\/todomd\/bin\/todomd\.js/);
  assert.match(exe, /serve --no-open --port/);
  assert.match(exe, /open "http:\/\/127\.0\.0\.1/); // opens the board
  assert.ok(fs.statSync(path.join(app, 'Contents/MacOS/todomd')).mode & 0o111, 'executable bit set');
  assert.match(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'), /CFBundleExecutable/);
});

test('Linux: writes a .desktop entry and a launch script', () => {
  const home = tmp('home');
  installLauncher({ nodeBin: '/usr/bin/node', todomdBin: '/x/bin.js', home, platform: 'linux' });
  assert.ok(fs.existsSync(path.join(home, '.todomd/launch.sh')));
  const desktop = fs.readFileSync(path.join(home, '.local/share/applications/todomd.desktop'), 'utf8');
  assert.match(desktop, /Type=Application/);
  assert.match(desktop, /Exec=.*\.todomd\/launch\.sh/);
});

test('Windows: writes a .bat on the Desktop', () => {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const r = installLauncher({ nodeBin: 'C:\\node.exe', todomdBin: 'C:\\todomd\\bin.js', home, platform: 'win32' });
  const bat = fs.readFileSync(r.path, 'utf8');
  assert.match(bat, /node\.exe/);
  assert.match(bat, /serve --port/);
});
