import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { freePort } from './ports.mjs'
import { connectDesktop, desktopPages } from '../../dist/desktop.mjs'

const require = createRequire(import.meta.url)

// A host that sets ELECTRON_RUN_AS_NODE (some editors do) would start Electron as plain Node.
/** @param {NodeJS.ProcessEnv} env */
const withoutRunAsNode = ({ ELECTRON_RUN_AS_NODE: _ignored, ...env }) => env

/**
 * Starts the Electron app at `main` with a loopback debugging port, and the Node
 * inspector when `inspect` is set, and waits until both answer.
 */
export async function launchElectron(main, { inspect = false, env = {} } = {}) {
  const cdpPort = await freePort()
  let inspectorPort = inspect ? await freePort() : undefined
  while (inspectorPort === cdpPort) inspectorPort = await freePort()
  const cdp = `http://127.0.0.1:${cdpPort}`
  const inspector = inspect ? `http://127.0.0.1:${inspectorPort}` : undefined
  const app = spawn(
    require('electron'),
    [
      '--no-sandbox',
      ...(inspect ? [`--inspect=127.0.0.1:${inspectorPort}`] : []),
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      main,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...withoutRunAsNode(process.env), ...env },
    },
  )
  let errors = ''
  app.stderr.on('data', (chunk) => {
    errors = (errors + chunk).slice(-10000)
  })
  app.on('error', (error) => {
    errors += error.message
  })
  const electron = {
    app,
    cdp,
    inspector,
    errors: () => errors,
    stop: () => stopElectron(app),
  }
  const answers = async (url) =>
    fetch(url).then(
      (response) => response.ok,
      () => false,
    )
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Electron exited: ${errors}`)
    if (
      (await answers(`${cdp}/json/version`)) &&
      (!inspect || (await answers(`${inspector}/json/list`)))
    )
      return electron
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await electron.stop()
  throw new Error(`Electron's debugging ports did not answer: ${errors}`)
}

// On Windows, ending only the main process can leave renderer processes running.
export async function stopElectron(app) {
  if (app.exitCode !== null || app.signalCode !== null) return
  const exit = once(app, 'exit')
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
  else app.kill()
  await exit
}

/** Attaches to the app and waits for a window whose URL includes `part`. */
export async function attachWindow(cdp, part, timeoutMs = 20000) {
  const browser = await connectDesktop(cdp)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = desktopPages(browser).find((p) => p.url().includes(part))
    if (page) return { browser, page }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await browser.close()
  throw new Error(`No window with ${part} in its URL`)
}
