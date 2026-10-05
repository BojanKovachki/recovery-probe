const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('recoveryProbeFixture', { kind: 'electron-preload' });
