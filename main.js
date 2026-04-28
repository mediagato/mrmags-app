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
const { app, Tray, Menu, dialog, shell, nativeImage, BrowserWindow, ipcMain, screen } = require('electron');
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
let mainWindow = null;
let widgetWindow = null;

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
  // Mac wants a Template image (monochrome, auto-tints for light/dark menu bar).
  // Win/Linux use the colored chalkboard tile so it reads on any taskbar.
  const dir = path.join(__dirname, 'icon');
  const want = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const p = path.join(dir, want);
  if (fs.existsSync(p)) return p;
  // Fall back to anything available
  const fallback = path.join(dir, 'tray.png');
  return fs.existsSync(fallback) ? fallback : null;
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

  // Self-contained: spawn our own Electron binary in Node mode. Electron
  // ships with Node bundled, so the user doesn't need Node installed
  // separately. process.execPath is the path to the Mr. Mags executable
  // inside the .app/.exe. ELECTRON_RUN_AS_NODE=1 turns it into a Node
  // interpreter that runs the server script.
  const desired = {
    command: process.execPath,
    args: [serverEntryPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      MRMAGS_DATA_DIR: userDataDir(),
    },
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
      'Your data lives on this machine and never leaves it. I sit in the menu bar (Mac) or ' +
      'system tray (Windows) — click me anytime to see status or open your data folder.\n\n' +
      'If Claude Desktop is already open, please quit and reopen it once so it picks up the ' +
      'new memory tool.\n\n' +
      'For a one-page guide: https://mrmags.org/start',
    buttons: ['Got it', 'Open the guide'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response === 1) {
    shell.openExternal('https://mrmags.org/start');
  }
  return result.response;
}

// ── windows ───────────────────────────────────────────────────────────────

function rendererPath(file) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'renderer', file);
  }
  return path.join(__dirname, 'renderer', file);
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: 'Mr. Mags',
    backgroundColor: '#fafaf7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Hide window menu bar on Windows/Linux. Mac uses the native app menu.
  if (process.platform !== 'darwin') mainWindow.setMenu(null);

  mainWindow.loadFile(rendererPath('window.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Don't destroy on close — just hide. Re-opens fast next click.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.show();
    return;
  }
  // Restore last position if saved
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  let x = sw - 320;
  let y = sh - 220;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'widget-pos.json'), 'utf8'));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x;
      y = saved.y;
    }
  } catch {}

  widgetWindow = new BrowserWindow({
    width: 280,
    height: 180,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    title: 'Mr. Mags',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  widgetWindow.loadFile(rendererPath('widget.html'));

  // Persist position when user drags it
  const savePos = () => {
    try {
      const [wx, wy] = widgetWindow.getPosition();
      fs.writeFileSync(
        path.join(userDataDir(), 'widget-pos.json'),
        JSON.stringify({ x: wx, y: wy }),
        'utf8'
      );
    } catch {}
  };
  widgetWindow.on('moved', savePos);
  widgetWindow.on('closed', () => { widgetWindow = null; });
}

function hideWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    widgetWindow = null;
  }
}

async function applyWidgetPreference() {
  try {
    const row = await brain.getState('widget_enabled');
    if (row && (row.value === 'true' || row.value === true)) {
      showWidget();
    }
  } catch {}
}

// ── IPC handlers (called from renderer via preload) ──────────────────────

function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:data-path', () => userDataDir());
  ipcMain.handle('app:open-data-folder', () => shell.openPath(userDataDir()));
  ipcMain.handle('app:open-claude-config', () => shell.showItemInFolder(claudeConfigPath()));
  ipcMain.handle('widget:toggle', async (_, on) => {
    if (on) showWidget(); else hideWidget();
    try { await brain.setState?.('widget_enabled', String(!!on)); } catch {}
    return { ok: true };
  });
  ipcMain.handle('widget:hide', async () => {
    hideWidget();
    try { await brain.setState?.('widget_enabled', 'false'); } catch {}
    return { ok: true };
  });
  ipcMain.handle('app:get-autostart', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('app:set-autostart', (_, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { ok: true };
  });
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
      label: 'Open Mr. Mags…',
      click: () => showMainWindow(),
    },
    {
      label: 'Show desktop widget',
      type: 'checkbox',
      checked: !!(widgetWindow && !widgetWindow.isDestroyed()),
      click: async (item) => {
        if (item.checked) showWidget(); else hideWidget();
        try { await brain.setState?.('widget_enabled', String(!!item.checked)); } catch {}
      },
    },
    { type: 'separator' },
    {
      label: 'Open data folder',
      click: () => shell.openPath(userDataDir()),
    },
    {
      label: 'How to talk to Claude (cheat sheet)',
      click: () => shell.openExternal('https://mrmags.org/start'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); },
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

  // Wire IPC for the renderer
  registerIpc();

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

  // Click on the tray icon (left-click on Win/Linux, single-click on Mac):
  // open the main window. Right-click still shows the context menu.
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());

  // Restore widget if user had it on
  applyWidgetPreference();

  // First-run welcome dialog → main window
  if (isFirstRun()) {
    await showWelcomeDialog();
    markFirstRunDone();
    showMainWindow();
  }
});

// Quit on all-windows-closed is the default; we don't open windows so this
// block runs only via the Quit menu.
app.on('window-all-closed', (e) => {
  // Prevent quit on window close — we live in the tray.
  e.preventDefault();
});

app.on('before-quit', async (e) => {
  app.isQuitting = true;
  if (tray) { tray.destroy(); tray = null; }
  if (widgetWindow && !widgetWindow.isDestroyed()) { widgetWindow.close(); widgetWindow = null; }
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.destroy(); mainWindow = null; }
  // Best-effort: close the API server and brain. Don't block quit > 2s.
  try { await Promise.race([api.stop(), new Promise(r => setTimeout(r, 1500))]); } catch {}
  try { await Promise.race([brain.close(), new Promise(r => setTimeout(r, 500))]); } catch {}
});
