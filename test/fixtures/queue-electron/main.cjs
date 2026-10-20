const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const { installIpcProbe } = require('../../../dist/ipc-probe.cjs')
let window
const jobs = []
// One shared, multiplexed channel (like an SDK bridge) plus a main-to-renderer push channel.
globalThis.__recoveryProbeIpc = installIpcProbe(ipcMain, {
  enabled: true,
  channels: ['fixture:invoke'],
  sender: () => window?.webContents,
  classify: (_channel, [payload]) => payload?.method,
  pushChannels: ['fixture:emit'],
  classifyPush: (_channel, [payload]) => payload?.event,
})
ipcMain.handle('fixture:invoke', async (_event, payload) => {
  if (payload.method === 'noise') return 1
  if (payload.method === 'start') {
    // An app that drops local content it should keep, for observe --files.
    if (process.env.FIXTURE_CACHE_DIR && payload.id === 'job-b')
      require('node:fs').rmSync(
        path.join(process.env.FIXTURE_CACHE_DIR, 'job-b.cache'),
        { force: true },
      )
    if (!jobs.some((j) => j.id === payload.id))
      jobs.push({
        id: payload.id,
        running: !jobs.some((j) => j.running),
        since: Date.now(),
      })
    window.webContents.send('fixture:emit', { event: 'queueChanged' })
    return { ok: true }
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  return jobs.map((j) => ({
    ...j,
    progress: j.running
      ? Math.min(99, Math.floor((Date.now() - j.since) / 100))
      : 0,
  }))
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
  await window.loadFile(path.join(__dirname, '../queue.html'), {
    query: process.env.FIXTURE_FIXED === 'true' ? { fixed: 'true' } : {},
  })
})
app.on('window-all-closed', () => app.quit())
