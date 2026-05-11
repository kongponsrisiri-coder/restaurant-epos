const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siamepos', {
  platform: process.platform,
  isElectron: true,
  onUpdateReady: (cb) => {
    ipcRenderer.on('siamepos:update-ready', () => cb && cb());
  },
});
