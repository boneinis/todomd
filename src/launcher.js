import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The shell body shared by every platform's launcher: ensure the server is up
// (start it detached if not), then open the board in the browser. Re-launching
// just re-opens the board — the detached server keeps running.
function unixScript(nodeBin, todomdBin, port, openCmd) {
  return `#!/bin/bash
PORT=${port}
mkdir -p "$HOME/.todomd"
if ! curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q todo; then
  nohup "${nodeBin}" "${todomdBin}" serve --no-open --port $PORT >> "$HOME/.todomd/server.log" 2>&1 &
  for i in $(seq 1 20); do
    curl -s "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q todo && break
    sleep 0.5
  done
fi
TOKEN=$(cat "$HOME/.todomd/token" 2>/dev/null)
${openCmd} "http://127.0.0.1:$PORT/?token=$TOKEN"
`;
}

function macApp(nodeBin, todomdBin, port, home) {
  const appDir = path.join(home, 'Desktop', 'todomd.app');
  const macos = path.join(appDir, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  const exe = path.join(macos, 'todomd');
  fs.writeFileSync(exe, unixScript(nodeBin, todomdBin, port, 'open'));
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>todomd</string>
  <key>CFBundleDisplayName</key><string>todomd</string>
  <key>CFBundleIdentifier</key><string>md.todo.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>todomd</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  fs.writeFileSync(path.join(appDir, 'Contents', 'PkgInfo'), 'APPL????');
  return { path: appDir, hint: 'double-click todomd.app on your Desktop (drag it to the Dock to keep it handy)' };
}

function linuxDesktop(nodeBin, todomdBin, port, home) {
  // a launcher script the .desktop entry runs (handles start-or-open)
  const scriptDir = path.join(home, '.todomd');
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, 'launch.sh');
  fs.writeFileSync(script, unixScript(nodeBin, todomdBin, port, 'xdg-open'));
  fs.chmodSync(script, 0o755);
  const desktop = `[Desktop Entry]
Type=Application
Name=todomd
Comment=Markdown kanban that drives coding agents
Exec=${script}
Terminal=false
Categories=Development;
`;
  const targets = [];
  for (const dir of [path.join(home, '.local', 'share', 'applications'), path.join(home, 'Desktop')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'todomd.desktop');
      fs.writeFileSync(f, desktop);
      fs.chmodSync(f, 0o755);
      targets.push(f);
    } catch { /* skip a dir we can't write */ }
  }
  return { path: targets.join(' and '), hint: 'todomd now appears in your app menu and on the Desktop' };
}

function winBat(nodeBin, todomdBin, port, home) {
  const desktop = path.join(home, 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  const bat = path.join(desktop, 'todomd.bat');
  fs.writeFileSync(bat,
    `@echo off\r\n"${nodeBin}" "${todomdBin}" serve --port ${port}\r\n`);
  return { path: bat, hint: 'double-click todomd.bat on your Desktop' };
}

export function installLauncher({ nodeBin, todomdBin, port = 7337, home = os.homedir(), platform = process.platform }) {
  if (platform === 'darwin') return macApp(nodeBin, todomdBin, port, home);
  if (platform === 'win32') return winBat(nodeBin, todomdBin, port, home);
  return linuxDesktop(nodeBin, todomdBin, port, home);
}
