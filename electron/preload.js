const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siamepos', {
  platform: process.platform,
  isElectron: true,
  // Used by the first-time setup wizard to persist electron/config.json
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  onUpdateReady: (cb) => {
    ipcRenderer.on('siamepos:update-ready', () => cb && cb());
  },
  // Printing (SEPOS-025 receipts / SEPOS-026 kitchen tickets).
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printHtml: (payload) => ipcRenderer.invoke('print-html', payload),
});
