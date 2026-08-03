const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siamepos', {
  platform: process.platform,
  isElectron: true,
  // Used by the first-time setup wizard to persist electron/config.json
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  // SEPOS-RESET-001 — wipe config.json + local DB and relaunch to the wizard
  // (hand this install to a different client). Triggered by the hidden reset.
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  onUpdateReady: (cb) => {
    ipcRenderer.on('siamepos:update-ready', () => cb && cb());
  },
  // SEPOS-PRO-004 — apply the downloaded update now (quit + relaunch).
  restartToUpdate: () => ipcRenderer.invoke('siamepos:restart-to-update'),
  // SEPOS-PRO-005 — Settings → App & Updates card.
  getVersion: () => ipcRenderer.invoke('siamepos:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('siamepos:check-for-updates'),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('siamepos:update-status', (_e, payload) => cb && cb(payload));
  },
  // Printing (SEPOS-025 receipts / SEPOS-026 kitchen tickets).
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printHtml: (payload) => ipcRenderer.invoke('print-html', payload),
  // SEPOS-EXIT-001 — quit the desktop app cleanly from the login screen, so
  // staff stop force-closing / re-opening (which spawned duplicate instances
  // fighting over the same local DB).
  quitApp: () => ipcRenderer.invoke('quit-app'),
});
