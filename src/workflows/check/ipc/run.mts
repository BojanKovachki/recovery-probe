import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, Page } from 'playwright'
import type { IpcIdentity } from '../../../ipc-probe.cjs'
import { connectDesktop } from '../../../targets/cdp.mjs'
import { attachIpcWindow } from '../../../targets/ipc-window.mjs'
import {
  prepareVisibility,
  type PreparedVisibility,
  type WindowReport,
} from '../../../targets/visibility.mjs'
import {
  resetIpcAndConfirm,
  runSnapshot,
  type IpcFault,
} from '../../../transports/ipc/control.mjs'
import { connectIpcInspector } from '../../../transports/ipc/inspector.mjs'
import type { IpcInspector } from '../../../transports/ipc/inspector.mjs'
import { readyProblem, screenLines, screenQuote } from '../screen.mjs'
import {
  validateIpcConfig,
  type IpcCheckConfig,
  type IpcCheckInput,
} from './config.mjs'
import { phaseVerdict, type IpcPhaseResult } from './verdict.mjs'

export interface IpcCheckReport {
  schemaVersion: 1
  mode: string
  generatedAt: string
  channel: string
  baseline?: IpcPhaseResult
  baselineReadMs?: number
  deadlineMs?: number
  results: (IpcPhaseResult & {
    fault: IpcFault
    /** Text the screen showed under the fault that the healthy screen didn't. */
    screenText?: string
  })[]
  cleanup?: IpcPhaseResult
  finalReset: 'not-run' | 'healthy' | 'not-verified'
  ok: boolean
  error?: string
  cleanupError?: string
  window?: WindowReport
  windowRestoreError?: string
  limitation: string
}

export async function checkIpc(
  input: IpcCheckInput,
  {
    connectControl = connectIpcInspector,
  }: { connectControl?: (endpoint: string) => Promise<IpcInspector> } = {},
): Promise<IpcCheckReport> {
  const config = validateIpcConfig(input)
  const check = new IpcCheck(config, await connectControl(config.inspector))
  try {
    return await check.run()
  } finally {
    await check.close()
  }
}

/** A baseline, each fault, and a final reload, each a phase armed and disarmed in the hook. */
class IpcCheck {
  readonly #report: IpcCheckReport
  readonly #config: IpcCheckConfig
  readonly #control: IpcInspector
  #browser: Browser | undefined
  #page!: Page
  #identity!: IpcIdentity
  #runId: string | undefined
  #visibility: PreparedVisibility | undefined

  constructor(config: IpcCheckConfig, control: IpcInspector) {
    this.#config = config
    this.#control = control
    this.#report = initialReport(config)
  }

  async run() {
    await this.#attach()
    await this.#experiments()
    await this.#reset()
    const report = this.#report
    const config = this.#config
    report.ok =
      !report.error &&
      report.baseline?.outcome === 'pass' &&
      report.results.length === config.faults.length &&
      report.results.every((row) => row.outcome === 'pass') &&
      report.finalReset === 'healthy'
    return report
  }

  /** Disarms the last phase, puts the window back and disconnects, leaving the app open. */
  async close() {
    try {
      if (this.#runId) await resetIpcAndConfirm(this.#control, this.#runId)
    } catch (error) {
      this.#report.ok = false
      this.#report.finalReset = 'not-verified'
      this.#report.cleanupError = (error as Error).message
    } finally {
      await this.#restoreWindow()
      this.#control.close()
      if (this.#browser) await this.#browser.close()
    }
  }

  async #restoreWindow() {
    try {
      // The window state is recorded as soon as visibility is prepared.
      if (this.#visibility)
        this.#report.window!.restoration = await this.#visibility.revert()
    } catch (error) {
      this.#report.ok = false
      this.#report.windowRestoreError = (error as Error).message
    }
  }

  async #attach() {
    const config = this.#config
    this.#browser = await connectDesktop(config.cdp)
    const { page, identity } = await attachIpcWindow(
      this.#browser,
      this.#control,
      [config.channel, ...config.requiredChannels],
    )
    this.#page = page
    this.#identity = identity
    this.#visibility = await prepareVisibility(page, {
      restoreWindow: config.restoreWindow,
      control: this.#control,
    })
    this.#report.window = { initial: this.#visibility.initial }
    await page.bringToFront()
    if ((await ui(page, config)).blocked)
      throw new Error('Target must be visible and online')
    // Validate selectors before arming anything.
    await page.locator(config.readySelector).count()
    if (config.busySelector) await page.locator(config.busySelector).count()
  }

  async #experiments() {
    const report = this.#report
    const config = this.#config
    try {
      report.baseline = await this.#phase(undefined, config.baselineTimeoutMs)
      if (report.baseline.outcome !== 'pass') return
      const baselineReadMs =
        report.baseline.snapshot.channels[config.channel].maxDurationMs
      const deadlineMs =
        config.retryDelayMs + 2 * baselineReadMs + config.renderMarginMs
      if (deadlineMs < 200 || deadlineMs > 60000)
        throw new Error(
          'Computed recovery deadline must be 200–60000ms; adjust the explicit timing assumptions',
        )
      report.baselineReadMs = baselineReadMs
      report.deadlineMs = deadlineMs
      const healthyScreen = await screenLines(this.#page).catch(() => undefined)
      for (const fault of config.faults) {
        const { snapshot, ...verdict } = await this.#phase(fault, deadlineMs)
        const quote =
          verdict.outcome !== 'pass' && snapshot.injected
            ? await this.#quote(healthyScreen)
            : undefined
        report.results.push({
          fault,
          ...verdict,
          ...(quote === undefined ? {} : { screenText: quote }),
          snapshot,
        })
        if (verdict.outcome === 'inconclusive') break
      }
    } catch (error) {
      report.error = (error as Error).message
    }
  }

  /** The text new on the screen since it was healthy; none when either can't be read. */
  async #quote(healthyScreen: string[] | undefined) {
    if (!healthyScreen) return undefined
    const lines = await screenLines(this.#page).catch(() => undefined)
    return lines && screenQuote(lines, healthyScreen)
  }

  // Only reload after disarm has been independently verified.
  async #reset() {
    try {
      if (this.#runId) await resetIpcAndConfirm(this.#control, this.#runId)
      const cleanup = await this.#phase(
        undefined,
        this.#config.baselineTimeoutMs,
      )
      this.#report.cleanup = cleanup
      this.#report.finalReset =
        cleanup.outcome === 'pass' ? 'healthy' : 'not-verified'
    } catch (error) {
      this.#report.finalReset = 'not-verified'
      this.#report.cleanupError = (error as Error).message
    }
  }

  async #phase(
    fault: IpcFault | undefined,
    deadlineMs: number,
  ): Promise<IpcPhaseResult> {
    const id = randomUUID()
    // Record intent before sending: begin may execute even if its reply is lost.
    this.#runId = id
    const started = Date.now()
    try {
      await this.#begin(id, fault, deadlineMs)
      for (;;) {
        const result = await this.#poll(id, fault, started, deadlineMs)
        if (result) return result
        await sleep(50)
      }
    } finally {
      await resetIpcAndConfirm(this.#control, id)
    }
  }

  async #begin(id: string, fault: IpcFault | undefined, deadlineMs: number) {
    const { channel, requiredChannels, baselineTimeoutMs } = this.#config
    await this.#control.call('begin', {
      id,
      channel,
      requiredChannels,
      ...(fault ? { fault } : {}),
      ttlMs: Math.min(60000, baselineTimeoutMs + deadlineMs),
    })
    await this.#page.reload({
      waitUntil: 'domcontentloaded',
      timeout: baselineTimeoutMs,
    })
    await this.#page.bringToFront()
  }

  async #poll(
    id: string,
    fault: IpcFault | undefined,
    started: number,
    deadlineMs: number,
  ): Promise<IpcPhaseResult | undefined> {
    const snapshot = await runSnapshot(
      this.#control,
      id,
      this.#identity.senderId,
    )
    if (this.#page.url() !== this.#identity.pageUrl)
      return { outcome: 'inconclusive', code: 'TARGET_NAVIGATED', snapshot }
    const status = await ui(this.#page, this.#config)
    if (status.blocked)
      return { outcome: 'inconclusive', code: 'ENVIRONMENT_BLOCKED', snapshot }
    const expired =
      fault && snapshot.injectedAt
        ? Date.now() - snapshot.injectedAt >= deadlineMs
        : Date.now() - started >= this.#config.baselineTimeoutMs
    const verdict = phaseVerdict(this.#config, {
      fault,
      snapshot,
      readyProblem: status.readyProblem,
      expired,
    })
    return verdict && { ...verdict, snapshot }
  }
}

const initialReport = (config: IpcCheckConfig): IpcCheckReport => ({
  schemaVersion: 1,
  mode: 'IPC renderer recovery',
  generatedAt: new Date().toISOString(),
  channel: config.channel,
  results: [],
  finalReset: 'not-run',
  ok: false,
  limitation:
    'Tests renderer recovery after a synthetic IPC rejection or null result. Does not simulate HTTP, Rust transport, connection banners, token refresh or general application health.',
})

async function ui(page: Page, config: IpcCheckConfig) {
  const environment = await page.evaluate(() => ({
    visible: document.visibilityState === 'visible',
    online: navigator.onLine,
  }))
  if (!environment.visible || !environment.online)
    return { blocked: true, readyProblem: 'the window is hidden or offline' }
  return { blocked: false, readyProblem: await readyProblem(page, config) }
}
