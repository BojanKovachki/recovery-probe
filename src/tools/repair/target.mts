import { writeFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser } from 'playwright'
import { connectDesktop, selectDesktopPage } from '../../targets/cdp.mjs'
import { checkWeb } from '../../workflows/web.mjs'
import {
  checkDesktop,
  type DesktopReport,
} from '../../workflows/check/http/run.mjs'
import type { RepairConfig } from './config.mjs'
import { startCommand } from './process.mjs'

async function portOpen(url: URL) {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function waitForPort(
  url: URL,
  app: ReturnType<typeof startCommand>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (app.result)
      throw new Error(
        'Development launch exited; check your launch command and dependencies',
      )
    if (await portOpen(url)) return
    await sleep(100)
  }
  throw new Error(
    'Development target did not open its test port before startupTimeoutMs',
  )
}

async function waitForLogin() {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    await terminal.question(
      'Sign into the launched Electron test app and open the target screen, then press Enter. ',
    )
  } finally {
    terminal.close()
  }
}

async function launchedPage(browser: Browser, config: RepairConfig) {
  const deadline = Date.now() + config.startupTimeoutMs
  while (Date.now() < deadline) {
    try {
      return selectDesktopPage(browser, config.scenario)
    } catch {}
    await sleep(100)
  }
  throw new Error(
    'The launched Electron renderer did not match scenario.pageUrl',
  )
}

/** Only run the target started in this checkout, not an already-running company app. */
export async function observeRepairTarget(
  config: RepairConfig,
  workspace: string,
  { logPath }: { logPath?: string } = {},
): Promise<DesktopReport> {
  const url = new URL(
    (config.target === 'web'
      ? config.scenario.pageUrl
      : config.scenario.cdp) as string,
  )
  if (await portOpen(url))
    throw new Error(
      'Target port is already in use. Stop that app or choose a dedicated test port; refusing to test a possibly unrelated build',
    )
  if (config.manualLogin && !process.stdin.isTTY)
    throw new Error('manualLogin needs an interactive terminal')
  const app = startCommand(config.launch, workspace, {
    RECOVERY_PROBE_USER_DATA_DIR: join(
      dirname(workspace),
      'electron-test-profile',
    ),
  })
  let browser: Browser | undefined
  try {
    await waitForPort(url, app, config.startupTimeoutMs)
    if (config.target === 'web') return await checkWeb(config.scenario)
    if (config.manualLogin) await waitForLogin()
    browser = await connectDesktop(config.scenario.cdp)
    const page = await launchedPage(browser, config)
    return await checkDesktop(page, config.scenario)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await app.stop()
    if (logPath) await writeFile(logPath, app.output, { mode: 0o600 })
  }
}
