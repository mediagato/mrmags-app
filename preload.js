/**
 * Mr. Mags preload — IPC bridge for the renderer.
 *
 * The renderer talks to the brain via the local HTTP API (127.0.0.1:11436)
 * directly. Preload only exposes things that *must* live in the main process:
 * external links, OS folder shortcuts, autostart, widget toggle, version.
 */
const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('mrmags', {
  version: () => ipcRenderer.invoke('app:version'),
  dataPath: () => ipcRenderer.invoke('app:data-path'),
  openExternal: (url) => shell.openExternal(url),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  openClaudeConfig: () => ipcRenderer.invoke('app:open-claude-config'),
  toggleWidget: (on) => ipcRenderer.invoke('widget:toggle', on),
  hideWidget: () => ipcRenderer.invoke('widget:hide'),
  getAutostart: () => ipcRenderer.invoke('app:get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('app:set-autostart', on),
});
