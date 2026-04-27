/**
 * Mags preload — currently a no-op.
 *
 * The v0 app has no renderer process (tray-only, no BrowserWindow). When we
 * add a settings window in Phase 3, this is where the IPC bridge lives.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mags', {
  version: () => process.env.npm_package_version || 'dev',
});
