import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import { freePort, portOpen } from '../../core/ports.mjs'
import { runCommand, startCommand } from '../process.mjs'
import { copyApproved, type Sides } from './criteria.mjs'
import type { PolicyApp } from './policy.mjs'

const tail = (output: string) => output.trim().split('\n').slice(-5).join(' / ')

export interface StartedApp {
  output(): string
  stop(): Promise<void>
  /** When the readiness limit ends, as Date.now() counts: the app's page must have loaded by then too. */
  readyBy: number
}

/** Refuses an address another process already answers on: it may be another build. */
async function refuseOccupied(app: PolicyApp) {
  for (const address of [app.url, app.ready.url]) {
    const url = new URL(address)
    if (await portOpen(url))
      throw new Error(
        `${url.host} is already in use: stop what runs there, or give the app its own port. Refusing to test what may be another build`,
      )
  }
}

async function untilReady(
  app: PolicyApp,
  process: ReturnType<typeof startCommand>,
  deadline: number,
) {
  while (Date.now() < deadline) {
    if (process.result)
      throw new Error(
        `the app exited before it was ready: ${tail(process.output) || 'no output'}`,
      )
    const answered = await fetch(app.ready.url, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) return
    await sleep(200)
  }
  throw new Error(
    `the app wasn't ready at ${app.ready.url} within ${app.ready.timeoutMs} ms`,
  )
}

/**
 * Launches the app from `checkout`, with the base's approved fixtures and after its setup, and
 * waits until its readiness address answers. The process and everything it starts are the
 * run's: they're stopped with `stop`.
 */
export async function startApp(
  app: PolicyApp,
  checkout: string,
  { sides, setupTimeoutMs }: { sides: Sides; setupTimeoutMs: number },
): Promise<StartedApp> {
  await refuseOccupied(app)
  await copyApproved(sides, app.fixtures, checkout)
  for (const command of app.setup) {
    const result = await runCommand(command, checkout, setupTimeoutMs)
    if (result.code !== 0)
      throw new Error(
        `setup ${command.join(' ')} ${result.timedOut ? 'timed out' : `exited with ${result.code}`}: ${tail(result.output)}`,
      )
  }
  const process = startCommand(app.launch, checkout)
  const readyBy = Date.now() + app.ready.timeoutMs
  try {
    await untilReady(app, process, readyBy)
  } catch (error) {
    await process.stop()
    throw error
  }
  return { output: () => process.output, stop: process.stop, readyBy }
}

export interface AppBrowser {
  /** The debugging address scenarios attach to with --cdp. */
  cdp: string
  /** Opens the app's page again, so each run starts from it. */
  reset(): Promise<void>
  close(): Promise<void>
}

/**
 * A Chromium the run owns, on a free loopback debugging port, showing `url`. The first load
 * gets `firstLoadMs`, since a dev server can build on its first request; later ones get
 * Playwright's default.
 */
export async function openBrowser(
  url: string,
  firstLoadMs: number,
): Promise<AppBrowser> {
  const port = await freePort()
  const browser = await chromium.launch({
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ],
  })
  try {
    const page = await browser.newPage()
    const reset = async () => {
      await page.goto(url)
    }
    await page.goto(url, { timeout: firstLoadMs })
    return {
      cdp: `http://127.0.0.1:${port}`,
      reset,
      close: () => browser.close(),
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}
