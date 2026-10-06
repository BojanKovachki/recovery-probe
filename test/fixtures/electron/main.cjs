const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  // Xvfb has no window manager; keep animation frames running so real Playwright
  // click stability checks do not stall on the first interaction. Do not force clicks.
  const window = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  await window.loadURL(process.env.RECOVERY_PROBE_FIXTURE_URL);
});
