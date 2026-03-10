const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yakk', {
  hostServer: (opts) => ipcRenderer.invoke('host-server', opts),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  decodeCode: (code) => ipcRenderer.invoke('decode-code', code),
  getSavedServers: () => ipcRenderer.invoke('get-saved-servers'),
  saveServer: (entry) => ipcRenderer.invoke('save-server', entry),
  removeServer: (code) => ipcRenderer.invoke('remove-server', code),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
});
