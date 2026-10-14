const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { installIpcProbe } = require('../../../src/ipc-probe.cjs');
let window;
globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, { enabled: true, channels: ['fixture:cache-read'], sender: () => window?.webContents });
ipcMain.handle('fixture:cache-read', async (_event, identity, fail) => {
  await new Promise(resolve => setTimeout(resolve, 300));
  if (fail) throw Error('synthetic failed read');
  return [`synthetic-${identity}-private-value`];
});
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../cache.html'));
});
app.on('window-all-closed', () => app.quit());
