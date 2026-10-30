'use strict';

/**
 * Preload for the Electron shell. Context isolation is on and `nodeIntegration` is off, so the
 * page keeps talking to the HTTP server exactly as it does in a browser; the bridge only exposes
 * read-only desktop facts and one explicit quit, and nothing from `node:*` leaks through.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fieldStation', {
  isDesktop: true,
  platform: process.platform,
  /** { port, url, versions: { electron, chrome, node } } — null url while the server boots. */
  info: () => ipcRenderer.invoke('field-station:info'),
  quit: () => ipcRenderer.invoke('field-station:quit'),
});
