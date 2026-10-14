const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixtureCacheApi', { read: (identity, fail) => ipcRenderer.invoke('fixture:cache-read', identity, fail) });
