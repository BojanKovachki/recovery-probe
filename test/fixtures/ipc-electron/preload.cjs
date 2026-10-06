const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixtureApi', {
  read: () => ipcRenderer.invoke('fixture:read'),
  versions: () => ipcRenderer.invoke('fixture:versions'),
});
