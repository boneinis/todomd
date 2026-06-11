import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// shipped icon assets (built from public/icon.svg)
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
function copyIfPresent(src, dest) {
  try { fs.copyFileSync(src, dest); return true; } catch { return false; }
}

// The shell body shared by every platform's launcher: ensure the server is up
// (start it detached if not), then open the board in the browser. Re-launching
// just re-opens the board — the detached server keeps running.
function unixScript(nodeBin, todomdBin, root, port, openCmd) {
  // port check uses bash's /dev/tcp (no curl dependency); server.log is created
  // 0600 since `serve` prints the token in its URL line. Auto-restart: if any
  // source file is newer than the running server (a git pull / code change), the
  // detached server is stale — stop and relaunch it so the new code takes effect.
  return `#!/bin/bash
PORT=${port}
NODE="${nodeBin}"
BIN="${todomdBin}"
ROOT="${root}"
PIDFILE="$HOME/.todomd/server.pid"
# a GUI launch (the .app) gets a minimal PATH, so the detached server can't find
# agent CLIs installed in user-local dirs — add the common ones so claude/codex
# (and the install-time PATH) resolve. ~/.local/bin = claude native installer;
# ~/.npm-global|.npm-packages/bin = npm globals; homebrew dirs too.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.npm-packages/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}:$PATH"
mkdir -p "$HOME/.todomd"
up() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
start() {
  touch "$HOME/.todomd/server.log"; chmod 600 "$HOME/.todomd/server.log"
  nohup "$NODE" "$BIN" serve --no-open --port $PORT >> "$HOME/.todomd/server.log" 2>&1 &
  for i in $(seq 1 20); do up && break; sleep 0.5; done
}
if up; then
  if [ -f "$PIDFILE" ] && [ -n "$(find "$ROOT/src" "$ROOT/bin" "$ROOT/public" -type f -newer "$PIDFILE" -print -quit 2>/dev/null)" ]; then
    "$NODE" "$BIN" stop >/dev/null 2>&1
    for i in $(seq 1 20); do up || break; sleep 0.3; done
    start
  fi
else
  start
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
  const root = path.dirname(path.dirname(todomdBin)); // <checkout>/bin/todomd.js → <checkout>
  fs.writeFileSync(exe, unixScript(nodeBin, todomdBin, root, port, 'open'));
  fs.chmodSync(exe, 0o755);
  // ship the prebuilt .icns so the .app shows the todomd icon (no rasterizer
  // needed on the user's machine) — only declare CFBundleIconFile if it copied
  const resources = path.join(appDir, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const hasIcon = copyIfPresent(path.join(ASSETS, 'icon.icns'), path.join(resources, 'todomd.icns'));
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>todomd</string>
  <key>CFBundleDisplayName</key><string>todomd</string>
  <key>CFBundleIdentifier</key><string>md.todo.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>todomd</string>${hasIcon ? '\n  <key>CFBundleIconFile</key><string>todomd</string>' : ''}
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
  const root = path.dirname(path.dirname(todomdBin));
  fs.writeFileSync(script, unixScript(nodeBin, todomdBin, root, port, 'xdg-open'));
  fs.chmodSync(script, 0o755);
  // ship the SVG into ~/.todomd and point the entry at it (.desktop supports SVG)
  const iconPath = path.join(scriptDir, 'icon.svg');
  const iconLine = copyIfPresent(path.join(ASSETS, 'icon.svg'), iconPath) ? `Icon=${iconPath}\n` : '';
  const desktop = `[Desktop Entry]
Type=Application
Name=todomd
Comment=Markdown kanban that drives coding agents
Exec=${script}
${iconLine}Terminal=false
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
