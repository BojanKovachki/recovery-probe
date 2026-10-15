const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixtureQueueApi', {
  read: () => ipcRenderer.invoke('fixture:invoke', { method: 'read' }),
  start: id => ipcRenderer.invoke('fixture:invoke', { method: 'start', id }),
  noise: () => ipcRenderer.invoke('fixture:invoke', { method: 'noise' }),
  onQueueChanged: callback => { ipcRenderer.on('fixture:emit', (_event, payload) => { if (payload?.event === 'queueChanged') callback(); }); },
});
