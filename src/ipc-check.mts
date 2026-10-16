import { randomUUID } from 'node:crypto'
import type { Browser, Page } from 'playwright'
import { connectDesktop, desktopPages } from './desktop.mjs'
import { connectIpcInspector } from './ipc-inspector.mjs'
import type { IpcInspector } from './ipc-inspector.mjs'
import { confirmSameWindow, resetIpcAndConfirm } from './ipc-control.mjs'
import type { IpcFault } from './ipc-control.mjs'
import type { IpcSnapshot } from './ipc-probe.cjs'

export interface IpcCheckConfig {
  cdp: string
  inspector: string
  channel: string
  readySelector: string
  readyText: string
  busySelector?: string
  requiredChannels: string[]
  faults: IpcFault[]
  baselineTimeoutMs: number
  retryDelayMs: number
  renderMarginMs: number
}

export type IpcCheckInput = Partial<IpcCheckConfig> &
  Pick<IpcCheckConfig, 'channel' | 'readySelector' | 'readyText'>

interface IpcPhaseResult {
  outcome: 'pass' | 'fail' | 'inconclusive'
  code: string
  snapshot: IpcSnapshot
}

export interface IpcCheckReport {
  schemaVersion: 1
  mode: string
  generatedAt: string
  channel: string
  baseline?: IpcPhaseResult
  baselineReadMs?: number
  deadlineMs?: number
  results: (IpcPhaseResult & { fault: IpcFault })[]
  cleanup?: IpcPhaseResult
  finalReset: 'not-run' | 'healthy' | 'not-verified'
  ok: boolean
  error?: string
  cleanupError?: string
  limitation: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export function validateIpcConfig(input: IpcCheckInput): IpcCheckConfig {
  const c: IpcCheckConfig = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    requiredChannels: [],
    faults: ['rejection'],
    baselineTimeoutMs: 15000,
    retryDelayMs: 1000,
    renderMarginMs: 1000,
    ...input,
  }
  for (const name of ['channel', 'readySelector', 'readyText'] as const)
    if (typeof c[name] !== 'string' || !c[name].trim())
      throw new Error(`${name} is required; use known fixture content`)
  if (
    !Array.isArray(c.requiredChannels) ||
    c.requiredChannels.some(
      (name) => typeof name !== 'string' || !name.trim(),
    ) ||
    c.requiredChannels.includes(c.channel) ||
    new Set(c.requiredChannels).size !== c.requiredChannels.length
  )
    throw new Error(
      'requiredChannels must be unique dependency channels, excluding the target',
    )
  if (
    !Array.isArray(c.faults) ||
    !c.faults.length ||
    new Set(c.faults).size !== c.faults.length ||
    c.faults.some((f) => !['rejection', 'null-result'].includes(f))
  )
    throw new Error('Use unique rejection/null-result faults')
  for (const name of [
    'baselineTimeoutMs',
    'retryDelayMs',
    'renderMarginMs',
  ] as const)
    if (
      !Number.isInteger(c[name]) ||
      c[name] < (name === 'baselineTimeoutMs' ? 200 : 0) ||
      c[name] > 60000
    )
      throw new Error(`Invalid ${name}`)
  return c
}
async function ui(page: Page, config: IpcCheckConfig) {
  const environment = await page.evaluate(() => ({
    visible: document.visibilityState === 'visible',
    online: navigator.onLine,
  }))
  if (!environment.visible || !environment.online)
    return { blocked: true, ready: false }
  const marker = page.locator(config.readySelector)
  const busy = config.busySelector
    ? await page.locator(config.busySelector).all()
    : []
  return {
    blocked: false,
    ready:
      (await marker.count()) === 1 &&
      (await marker.isVisible()) &&
      (await marker.innerText()).includes(config.readyText) &&
      !(await Promise.all(busy.map((item) => item.isVisible()))).some(Boolean),
  }
}
export async function checkIpc(
  input: IpcCheckInput,
  {
    connectControl = connectIpcInspector,
  }: { connectControl?: (endpoint: string) => Promise<IpcInspector> } = {},
): Promise<IpcCheckReport> {
  const config = validateIpcConfig(input)
  const control = await connectControl(config.inspector)
  let browser: Browser | undefined
  let runId: string | undefined
  const report: IpcCheckReport = {
    schemaVersion: 1,
    mode: 'IPC renderer recovery',
    generatedAt: new Date().toISOString(),
    channel: config.channel,
    results: [],
    finalReset: 'not-run',
    ok: false,
    limitation:
      'Tests renderer recovery after a synthetic IPC rejection or null result. Does not simulate HTTP, Rust transport, connection banners, token refresh or general application health.',
  }
  try {
    const identity = await control.call('identify')
    for (const channel of [config.channel, ...config.requiredChannels])
      if (!identity.registered.includes(channel))
        throw new Error(
          'Required channel was not captured at registration: ' + channel,
        )
    browser = await connectDesktop(config.cdp)
    const pages = desktopPages(browser).filter(
      (page) => page.url() === identity.pageUrl,
    )
    if (pages.length !== 1)
      throw new Error(
        'Keep exactly one matching target window open on the intended screen',
      )
    const page = pages[0]
    await confirmSameWindow(page, control)
    await page.bringToFront()
    if ((await ui(page, config)).blocked)
      throw new Error('Target must be visible and online')
    // Validate selectors before arming anything.
    await page.locator(config.readySelector).count()
    if (config.busySelector) await page.locator(config.busySelector).count()
    const phase = async (
      fault: IpcFault | undefined,
      deadlineMs: number,
    ): Promise<IpcPhaseResult> => {
      const phaseId = randomUUID()
      // Record intent before sending: begin may execute even if its reply is lost.
      runId = phaseId
      const started = Date.now()
      try {
        await control.call('begin', {
          id: phaseId,
          channel: config.channel,
          requiredChannels: config.requiredChannels,
          ...(fault ? { fault } : {}),
          ttlMs: Math.min(60000, config.baselineTimeoutMs + deadlineMs),
        })
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: config.baselineTimeoutMs,
        })
        await page.bringToFront()
        while (true) {
          const snapshot = await control.call('snapshot')
          if (snapshot?.id !== runId || snapshot.senderId !== identity.senderId)
            throw new Error('Probe run or target changed')
          if (page.url() !== identity.pageUrl)
            return {
              outcome: 'inconclusive',
              code: 'TARGET_NAVIGATED',
              snapshot,
            }
          const status = await ui(page, config)
          if (status.blocked)
            return {
              outcome: 'inconclusive',
              code: 'ENVIRONMENT_BLOCKED',
              snapshot,
            }
          const target = snapshot.channels[config.channel]
          const dependencies = config.requiredChannels.map(
            (c) => snapshot.channels[c],
          )
          if (dependencies.some((row) => row.errors > 0))
            return {
              outcome: 'inconclusive',
              code: 'DEPENDENCY_FAILED',
              snapshot,
            }
          const dependenciesReady = dependencies.every(
            (row) => row.successes > 0 && row.pending === 0,
          )
          if (!fault && target.calls > 1)
            return {
              outcome: 'inconclusive',
              code: 'BASELINE_AMBIGUOUS',
              snapshot,
            }
          if (fault && target.calls > 2)
            return {
              outcome: 'inconclusive',
              code: 'TRAFFIC_AMBIGUOUS',
              snapshot,
            }
          const success = fault
            ? snapshot.injected === 1 && snapshot.successfulAfterFault > 0
            : target.calls === 1 && target.successes === 1
          if (success && !target.pending && dependenciesReady && status.ready)
            return {
              outcome: 'pass',
              code: fault ? 'RECOVERED' : 'BASELINE_READY',
              snapshot,
            }
          const expired =
            fault && snapshot.injectedAt
              ? Date.now() - snapshot.injectedAt >= deadlineMs
              : Date.now() - started >= config.baselineTimeoutMs
          if (expired) {
            const code = !fault
              ? 'BASELINE_FAILED'
              : snapshot.injected !== 1
                ? 'FAULT_NOT_TRIGGERED'
                : !dependenciesReady
                  ? 'DEPENDENCY_NOT_READY'
                  : target.calls > 2
                    ? 'TRAFFIC_AMBIGUOUS'
                    : 'RECOVERY_NOT_OBSERVED'
            return {
              outcome:
                code === 'RECOVERY_NOT_OBSERVED' ? 'fail' : 'inconclusive',
              code,
              snapshot,
            }
          }
          await sleep(50)
        }
      } finally {
        await resetIpcAndConfirm(control, phaseId)
      }
    }
    try {
      report.baseline = await phase(undefined, config.baselineTimeoutMs)
      if (report.baseline.outcome === 'pass') {
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
        for (const fault of config.faults) {
          const result = await phase(fault, deadlineMs)
          report.results.push({ fault, ...result })
          if (result.outcome === 'inconclusive') break
        }
      }
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      // Only reload after disarm has been independently verified.
      try {
        if (runId) await resetIpcAndConfirm(control, runId)
        report.cleanup = await phase(undefined, config.baselineTimeoutMs)
        report.finalReset =
          report.cleanup.outcome === 'pass' ? 'healthy' : 'not-verified'
      } catch (error) {
        report.finalReset = 'not-verified'
        report.cleanupError = (error as Error).message
      }
    }
    report.ok =
      !report.error &&
      report.baseline?.outcome === 'pass' &&
      report.results.length === config.faults.length &&
      report.results.every((row) => row.outcome === 'pass') &&
      report.finalReset === 'healthy'
    return report
  } finally {
    try {
      if (runId) await resetIpcAndConfirm(control, runId)
    } catch (error) {
      report.ok = false
      report.finalReset = 'not-verified'
      report.cleanupError = (error as Error).message
    } finally {
      control.close()
      if (browser) await browser.close()
    }
  }
}
