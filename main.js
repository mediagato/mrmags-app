/**
 * Mr. Mags — main process.  https://mrmags.org
 *
 * Lives in the menu bar (Mac) / system tray (Win/Linux). Owns the brain.
 *
 *   1. On launch: opens the @mediagato/brain (PGlite) and starts an HTTP
 *      API server on 127.0.0.1:11436 so multiple front doors share one brain
 *      (Claude Desktop's MCP relay, browser extension, future tools).
 *   2. On first launch only: writes Claude Desktop's MCP config to spawn
 *      server/index.js (the MCP→HTTP relay), then shows a welcome dialog.
 *   3. Provides a small tray menu: Open data folder, About, Quit.
 *
 * Single-writer guarantee: only the Electron main process opens PGlite.
 * Everyone else hits the HTTP API. server/index.js no longer touches the
 * brain directly — it's a thin proxy.
 */
const { app, Tray, Menu, dialog, shell, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const brain = require('@mediagato/brain');
const api = require('./api');

// Force Electron's user-data dir to land at "Mr. Mags" instead of the
// package name "mrmags-app". Must happen before any app.getPath('userData')
// call. Keeps display name and on-disk dir consistent across mac/win/linux.
app.setName('Mr. Mags');

let tray = null;

// ── paths ─────────────────────────────────────────────────────────────────

function userDataDir() {
  // Cross-platform user data dir: Mac=~/Library/Application Support/Mr. Mags,
  // Win=%APPDATA%/Mr. Mags, Linux=~/.config/Mr. Mags. Electron's app.getPath
  // does exactly this once app.setName('Mr. Mags') runs (top of this file).
  return app.getPath('userData');
}

function claudeConfigPath() {
  // Claude Desktop's config file. Same shape across platforms.
  return path.join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json');
}

function serverEntryPath() {
  // Where the MCP server lives inside the packaged app.
  if (app.isPackaged) {
    // Inside .app/Contents/Resources/app/ (asar disabled for the server dir
    // since spawning node against an asar path requires extraction)
    return path.join(process.resourcesPath, 'app', 'server', 'index.js');
  }
  return path.join(__dirname, 'server', 'index.js');
}

function trayIconPath() {
  // 16x16 PNG. Placeholder for v0; replace with a designed Template image.
  const candidate = path.join(__dirname, 'icon', 'tray.png');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

const FIRST_RUN_FLAG = path.join(userDataDir(), '.first-run-done');

// ── Claude Desktop config wiring ──────────────────────────────────────────

function ensureClaudeConfig() {
  const cfgPath = claudeConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

  let cfg = { mcpServers: {} };
  let existed = false;
  if (fs.existsSync(cfgPath)) {
    existed = true;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || { mcpServers: {} };
      if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
    } catch (e) {
      // Bad JSON in the user's config? Don't overwrite. Leave alone, surface
      // via the diagnostics flow later.
      console.error('[mrmags] could not parse Claude config:', e.message);
      return { ok: false, reason: 'parse-error', path: cfgPath };
    }
    // One-time backup before our first edit
    const backup = cfgPath + '.before-mrmags';
    if (!fs.existsSync(backup)) {
      try { fs.copyFileSync(cfgPath, backup); } catch {}
    }
  }

  const desired = {
    command: 'node',
    args: [serverEntryPath()],
    env: { MRMAGS_DATA_DIR: userDataDir() },
  };

  // Idempotent — only write if our entry is missing or different
  const current = cfg.mcpServers.mrmags;
  const sameEntry = current
    && current.command === desired.command
    && JSON.stringify(current.args) === JSON.stringify(desired.args)
    && JSON.stringify(current.env || {}) === JSON.stringify(desired.env);
  if (sameEntry) {
    return { ok: true, reason: 'already-configured', path: cfgPath };
  }

  cfg.mcpServers.mrmags = desired;
  const tmp = cfgPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, cfgPath);
  return { ok: true, reason: existed ? 'updated' : 'created', path: cfgPath };
}

// ── first-run welcome ─────────────────────────────────────────────────────

function isFirstRun() {
  return !fs.existsSync(FIRST_RUN_FLAG);
}

function markFirstRunDone() {
  fs.mkdirSync(path.dirname(FIRST_RUN_FLAG), { recursive: true });
  fs.writeFileSync(FIRST_RUN_FLAG, new Date().toISOString(), 'utf8');
}

async function showWelcomeDialog() {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Welcome to Mr. Mags',
    message: 'Claude now has a memory.',
    detail:
      'I just connected myself to Claude Desktop. From now on, every conversation you have ' +
      'with Claude carries the context of every previous one.\n\n' +
      'Try saying:  "Remember that I teach biology."\n' +
      'Or:          "What do you know about my classes?"\n\n' +
      'Your data lives on this Mac and never leaves it. I sit in the menu bar — click me ' +
      'anytime to see status or open your data folder.\n\n' +
      'If Claude Desktop is already open, quit and reopen it once so it sees the new memory tool.',
    buttons: ['Got it'],
    defaultId: 0,
  });
  return result.response;
}

// ── tray menu ─────────────────────────────────────────────────────────────

function buildTrayMenu(configResult) {
  const claudeOk = configResult && configResult.ok;
  const status = claudeOk
    ? `✓ Connected to Claude Desktop`
    : `! Claude config: ${configResult ? configResult.reason : 'unknown'}`;

  return Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Open data folder',
      click: () => shell.openPath(userDataDir()),
    },
    {
      label: 'Open Claude config',
      click: () => shell.showItemInFolder(claudeConfigPath()),
    },
    { type: 'separator' },
    {
      label: 'About Mr. Mags',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'About Mr. Mags',
          message: `Mr. Mags v${app.getVersion()}`,
          detail:
            'A persistent memory layer for Claude Desktop. Local-first: everything you store ' +
            'lives on this Mac and never goes to a server.\n\n' +
            'Named for a school teacher whose students call him Mr. Mags. ' +
            'He was the first user. We built it for him because his lesson plans, rubrics, and ' +
            'parent emails kept evaporating into one-shot AI chats. Now Claude remembers him.\n\n' +
            `Brain location: ${path.join(userDataDir(), 'brain')}\n` +
            `MCP server: ${serverEntryPath()}\n\n` +
            'Made by MEDiAGATO. Free for teachers, forever. https://mrmags.org',
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);
}

// ── lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Hide the dock icon on Mac — we're a menu-bar-only app.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Open the brain (PGlite). This process holds the only writer.
  try {
    await brain.init(userDataDir());
  } catch (e) {
    dialog.showErrorBox('Mr. Mags — brain failed to open', String(e.stack || e.message));
    app.quit();
    return;
  }

  // Start the localhost HTTP API. Front doors (Claude Desktop's MCP relay,
  // browser extension, future tools) all hit 127.0.0.1:11436 to share state.
  try {
    await api.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Mr. Mags — port 11436 already in use',
        'Another Mr. Mags instance may already be running. Quit it first, then relaunch.'
      );
    } else {
      dialog.showErrorBox('Mr. Mags — API server failed to start', String(e.stack || e.message));
    }
    app.quit();
    return;
  }

  // Wire Claude Desktop config (idempotent on subsequent launches)
  const configResult = ensureClaudeConfig();

  // Create tray
  const iconFile = trayIconPath();
  const trayImage = iconFile ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  // Mac: use template image semantics so it auto-adapts to menu bar appearance
  if (process.platform === 'darwin' && iconFile) {
    trayImage.setTemplateImage(true);
  }
  tray = new Tray(trayImage);
  tray.setToolTip(`Mr. Mags v${app.getVersion()} — Claude memory`);
  tray.setContextMenu(buildTrayMenu(configResult));

  // Mac without icon: show as text title in the menu bar
  if (process.platform === 'darwin' && !iconFile) {
    tray.setTitle('Mr. Mags');
  }

  // First-run welcome dialog
  if (isFirstRun()) {
    await showWelcomeDialog();
    markFirstRunDone();
  }
});

// Quit on all-windows-closed is the default; we don't open windows so this
// block runs only via the Quit menu.
app.on('window-all-closed', (e) => {
  // Prevent quit on window close — we live in the tray.
  e.preventDefault();
});

app.on('before-quit', async (e) => {
  if (tray) { tray.destroy(); tray = null; }
  // Best-effort: close the API server and brain. Don't block quit > 2s.
  try { await Promise.race([api.stop(), new Promise(r => setTimeout(r, 1500))]); } catch {}
  try { await Promise.race([brain.close(), new Promise(r => setTimeout(r, 500))]); } catch {}
});
