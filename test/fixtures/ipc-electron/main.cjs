const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const { installIpcProbe } = require('../../../dist/ipc-probe.cjs')
let window
globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, {
  enabled: true,
  channels: ['fixture:read', 'fixture:versions', 'fixture:write'],
  sender: () => window?.webContents,
})
ipcMain.handle('fixture:read', async () => {
  await new Promise((r) => setTimeout(r, 10))
  return { name: 'rp-fixture-cube.fbx' }
})
// Action checks answer every write in the hook; reaching this handler means one escaped.
ipcMain.handle('fixture:write', async () => null)
ipcMain.handle('fixture:versions', async () => {
  if (window.webContents.getURL().includes('dependency-failure'))
    throw new Error('fixture dependency failed')
  return [1]
})
app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  await window.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
