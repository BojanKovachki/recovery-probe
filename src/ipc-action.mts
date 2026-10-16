import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Browser, Page } from 'playwright'
import { connectDesktop, desktopPages } from './desktop.mjs'
import { connectIpcInspector } from './ipc-inspector.mjs'
import type { IpcInspector } from './ipc-inspector.mjs'
import {
  confirmSameWindow,
  resetIpcAndConfirm,
  waitForSettledCalls,
} from './ipc-control.mjs'
import type { IpcFault } from './ipc-control.mjs'
import { readRegion, summarizeRegion } from './ipc-observation.mjs'
import type { RegionSummary } from './ipc-observation.mjs'
import { selectorSpec } from './observation-kit.mjs'
import type { SelectorSpec } from './observation-kit.mjs'
import { locate, observationSteps, runSteps } from './observe-steps.mjs'
import type { ObservationStep, StepResult } from './observe-steps.mjs'
import { prepareVisibility } from './visibility.mjs'
import type { WindowVisibility } from './visibility.mjs'

export interface IpcActionConfig {
  cdp: string
  inspector: string
  /** The IPC channel the action writes through. Every call on it is answered by the hook. */
  channel: string
  /** Steps that bring the screen to the action, run after each reload. */
  setup: ObservationStep[]
  /** The control that sends the request. */
  action: SelectorSpec
  /** Simulated request time for the injected results. */
  latencyMs: number
  observationMs: number
  sampleMs: number
  regionSelector?: string
  restoreWindow: boolean
}

export type ActionRunKind = 'success' | 'failure' | 'double-click'

export interface ActionRun {
  kind: ActionRunKind
  fault: IpcFault
  /** Requests the action sent; the hook answered all of them. */
  requests: number
  /** Requests that reached the app's own handler because the plan ran out. */
  realRequests: number
  before: RegionSummary
  timeline: { elapsedMs: number; ui: RegionSummary }[]
  final: RegionSummary
  /** Hashes of status or alert messages that appeared after the action, such as toasts. */
  announced: string[]
  uncaughtErrors: number
  devErrorOverlay: boolean
  setup: StepResult[]
}

export interface ActionFinding {
  id: string
  classification: string
  kind: 'suspected-defect' | 'decision-needed' | 'observation' | 'inconclusive'
  advice: string
}

export interface IpcActionReport {
  schemaVersion: 1
  mode: 'IPC action check'
  channel: string
  generatedAt: string
  latencyMs: number
  runs: ActionRun[]
  findings: ActionFinding[]
  finalReset: 'healthy' | 'not-verified'
  ok: boolean
  window?: {
    initial: WindowVisibility
    restoration?: Awaited<
      ReturnType<Awaited<ReturnType<typeof prepareVisibility>>['revert']>
    >
  }
  error?: string
  cleanupError?: string
  windowRestoreError?: string
  limitation: string
}

// Recognised development error overlays; they sit above the app and block input.
const DEV_OVERLAYS =
  '#webpack-dev-server-client-overlay, vite-error-overlay, nextjs-portal'
const MAX_REQUESTS = 10

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function actionConfig(input: unknown): IpcActionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Action config must be an object')
  const c: Record<string, unknown> = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    channel: undefined,
    setup: undefined,
    action: undefined,
    latencyMs: 400,
    observationMs: 6000,
    sampleMs: 100,
    regionSelector: undefined,
    restoreWindow: false,
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(c, key)) throw Error(`Unsupported action option: ${key}`)
    c[key] = (input as Record<string, unknown>)[key]
  }
  if (typeof c.channel !== 'string' || !c.channel.trim())
    throw Error(
      'channel is required: the IPC channel the action writes through',
    )
  c.setup = c.setup === undefined ? [] : observationSteps(c.setup)
  c.action = selectorSpec(c.action, 'action')
  for (const [key, low, high] of [
    ['latencyMs', 0, 5000],
    ['observationMs', 1000, 30000],
    ['sampleMs', 50, 1000],
  ] as const) {
    const value = c[key]
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < low ||
      value > high
    )
      throw Error(`${key} must be ${low}–${high}`)
  }
  if (
    c.regionSelector !== undefined &&
    (typeof c.regionSelector !== 'string' || !c.regionSelector.trim())
  )
    throw Error('regionSelector must be a CSS selector')
  if (typeof c.restoreWindow !== 'boolean')
    throw Error('restoreWindow must be boolean')
  return c as unknown as IpcActionConfig
}

const changedFrom = (run: ActionRun, ui: RegionSummary) =>
  ui.fingerprint !== run.before.fingerprint

const finding = (
  id: string,
  classification: string,
  kind: ActionFinding['kind'],
  advice: string,
): ActionFinding => ({ id, classification, kind, advice })

const noRequest = (id: string) =>
  finding(
    id,
    'NO_REQUEST',
    'inconclusive',
    'The action did not call the configured channel. Check the channel, the setup steps and whether input validation stopped the request.',
  )

// What the user saw after the failed request, compared with the simulated success.
function classifyFailure(
  failure: ActionRun,
  success: ActionRun | undefined,
): ActionFinding {
  const id = 'failure-feedback'
  if (!failure.requests) return noRequest(id)
  // A message the success run also announced says nothing about the failure.
  const announcedOnFailure = failure.announced.filter(
    (hash) => !success?.announced.includes(hash),
  )
  const endedAsSuccess =
    success !== undefined &&
    success.requests > 0 &&
    changedFrom(success, success.final) &&
    failure.final.fingerprint === success.final.fingerprint
  const announcedSuccess =
    failure.announced.length > 0 && !announcedOnFailure.length
  if (endedAsSuccess || announcedSuccess)
    return finding(
      id,
      'FALSE_SUCCESS',
      'suspected-defect',
      'The request failed, but the user was shown what a success shows. Show success only once the request succeeds.',
    )
  const errorShown = failure.timeline.some(
    ({ ui }) =>
      (ui.error && !failure.before.error) ||
      (ui.retry && !failure.before.retry),
  )
  if (errorShown || announcedOnFailure.length)
    return finding(
      id,
      'FEEDBACK_SHOWN',
      'observation',
      'An error, or a message other than the success one, was shown after the failed request.',
    )
  if (!changedFrom(failure, failure.final))
    return finding(
      id,
      'SILENT_FAILURE',
      'suspected-defect',
      'The request failed and the screen ended as it was before the action. Show an error the user can act on and keep their input for a retry.',
    )
  return finding(
    id,
    'UNCLEAR_FEEDBACK',
    'decision-needed',
    'The screen changed after the failed request but showed no recognisable error. Review whether the user can tell that it failed.',
  )
}

function classifyDoubleClick(double: ActionRun): ActionFinding {
  const id = 'double-click'
  if (!double.requests) return noRequest(id)
  return double.requests > 1
    ? finding(
        id,
        'DUPLICATE_SUBMIT',
        'suspected-defect',
        `A double-click sent ${double.requests} requests. Disable the action while its request is in flight.`,
      )
    : finding(
        id,
        'SINGLE_SUBMIT',
        'observation',
        'A double-click sent one request.',
      )
}

/** Classifies what the user saw in each run. Exported for tests. */
export function classifyActionRuns(runs: ActionRun[]): ActionFinding[] {
  const run = (kind: ActionRunKind) => runs.find((r) => r.kind === kind)
  const success = run('success')
  const failure = run('failure')
  const double = run('double-click')
  const findings: ActionFinding[] = []
  if (success && !success.requests) findings.push(noRequest('success'))
  if (failure) findings.push(classifyFailure(failure, success))
  const uncaught = runs.filter((r) => r.uncaughtErrors > 0 || r.devErrorOverlay)
  if (uncaught.length)
    findings.push(
      finding(
        'uncaught-error',
        'UNCAUGHT_ERROR',
        'suspected-defect',
        `The ${uncaught.map((r) => r.kind).join(', ')} run raised an uncaught error or rejection. Handle the result where the request is made.`,
      ),
    )
  if (double) findings.push(classifyDoubleClick(double))
  const escaped = runs.filter((r) => r.realRequests > 0)
  if (escaped.length)
    findings.push(
      finding(
        'real-requests',
        'REAL_REQUEST_SENT',
        'inconclusive',
        `More than ${MAX_REQUESTS} requests in the ${escaped.map((r) => r.kind).join(', ')} run; the later ones reached the app's own handler.`,
      ),
    )
  return findings
}

export async function checkAction(
  input: unknown,
  {
    connectControl = connectIpcInspector,
  }: { connectControl?: (endpoint: string) => Promise<IpcInspector> } = {},
): Promise<IpcActionReport> {
  const config = actionConfig(input)
  const report: IpcActionReport = {
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: config.channel,
    generatedAt: new Date().toISOString(),
    latencyMs: config.latencyMs,
    runs: [],
    findings: [],
    finalReset: 'not-verified',
    ok: false,
    limitation:
      'One scripted action on the current screen. The hook answers every request on the channel, so nothing is written: a simulated success (null result) and a simulated failure (rejection), each after the configured latency. Findings compare structural fingerprints and recognised error language; they are leads to review, not proven defects. UI text is compared transiently; only hashes, structural shapes and counts are saved.',
  }
  const control = await connectControl(config.inspector)
  let browser: Browser | undefined
  let watchedPage: Page | undefined
  let runId: string | undefined
  let visibility: Awaited<ReturnType<typeof prepareVisibility>> | undefined
  let errorCount = 0
  const onError = () => {
    errorCount++
  }
  try {
    const identity = await control.call('identify')
    if (!identity.capabilities?.faultDelay)
      throw new Error(
        'Restart the app with the 0.5.0-preview.8 or newer hook; it lacks simulated latency',
      )
    if (!identity.registered.includes(config.channel))
      throw new Error('Channel not captured: ' + config.channel)
    browser = await connectDesktop(config.cdp)
    const pages = desktopPages(browser).filter(
      (p) => p.url() === identity.pageUrl,
    )
    if (pages.length !== 1)
      throw new Error('Keep one matching target window open')
    const page = pages[0]
    await confirmSameWindow(page, control)
    visibility = await prepareVisibility(page, {
      restoreWindow: config.restoreWindow,
      control,
    })
    report.window = { initial: visibility.initial }
    page.on('pageerror', onError)
    watchedPage = page

    // Development overlays are recorded as uncaught errors, then removed so they
    // don't count as the app's own response.
    const read = async () => {
      const overlay = await page.evaluate((selector) => {
        const found = [...document.querySelectorAll(selector)]
        for (const element of found) element.remove()
        return found.length > 0
      }, DEV_OVERLAYS)
      const ui = summarizeRegion(
        await page.evaluate(readRegion, config.regionSelector),
      )
      if (!ui.visible) throw new Error('ENVIRONMENT_BLOCKED: window hidden')
      // Status and alert messages, such as toasts; only their hashes leave the page.
      const announcements = await page.evaluate(() => {
        const hash = (text: string) => {
          let h = 0x811c9dc5
          for (let i = 0; i < text.length; i++)
            h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
          return (h >>> 0).toString(16)
        }
        return [
          ...document.querySelectorAll(
            '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]',
          ),
        ]
          .filter(
            (e) =>
              e.getClientRects().length > 0 &&
              getComputedStyle(e).visibility !== 'hidden',
          )
          .map((e) =>
            ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
          )
          .filter(Boolean)
          .map(hash)
      })
      return { ui, overlay, announcements }
    }

    const perform = async (kind: ActionRunKind): Promise<ActionRun> => {
      const fault: IpcFault = kind === 'success' ? 'null-result' : 'rejection'
      await waitForSettledCalls(control, config.observationMs)
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      const started = performance.now()
      const setup = await runSteps(page, config.setup, {
        mark: async () => null,
        signal: new AbortController().signal,
        elapsed: () => Math.round(performance.now() - started),
      })
      await sleep(300)
      const initial = await read()
      const before = initial.ui
      const shownBefore = new Set(initial.announcements)
      const target = locate(page, config.action).filter({ visible: true })
      const count = await target.count()
      if (count !== 1)
        throw new Error(
          `ACTION_TARGET_NOT_UNIQUE: expected exactly one visible match, found ${count}`,
        )
      // Arm right before the action, so slow setup can't outlive the plan.
      const id = randomUUID()
      runId = id
      try {
        await control.call('begin', {
          id,
          channel: config.channel,
          fault,
          times: MAX_REQUESTS,
          delayMs: config.latencyMs,
          ttlMs: config.observationMs + config.latencyMs + 10000,
        })
        const errorsBefore = errorCount
        const clicked = performance.now()
        if (kind === 'double-click') await target.dblclick()
        else await target.click()
        const timeline: ActionRun['timeline'] = []
        let previous = JSON.stringify(before)
        let final = before
        let devErrorOverlay = false
        const announced = new Set<string>()
        while (performance.now() - clicked < config.observationMs) {
          await sleep(config.sampleMs)
          const sample = await read()
          devErrorOverlay ||= sample.overlay
          for (const hash of sample.announcements)
            if (!shownBefore.has(hash)) announced.add(hash)
          final = sample.ui
          const signature = JSON.stringify(sample.ui)
          if (signature !== previous && timeline.length < 100) {
            timeline.push({
              elapsedMs: Math.round(performance.now() - clicked),
              ui: sample.ui,
            })
            previous = signature
          }
        }
        const snapshot = await control.call('snapshot')
        if (snapshot?.id !== id || snapshot.senderId !== identity.senderId)
          throw new Error('Probe run or target changed')
        return {
          kind,
          fault,
          requests: snapshot.injected,
          realRequests: snapshot.channels[config.channel].realCalls,
          before,
          timeline,
          final,
          announced: [...announced],
          uncaughtErrors: errorCount - errorsBefore,
          devErrorOverlay,
          setup,
        }
      } finally {
        await resetIpcAndConfirm(control, id)
      }
    }

    try {
      for (const kind of ['success', 'failure', 'double-click'] as const)
        report.runs.push(await perform(kind))
      report.findings = classifyActionRuns(report.runs)
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      try {
        if (runId) await resetIpcAndConfirm(control, runId)
        await waitForSettledCalls(control, config.observationMs)
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        report.finalReset = 'healthy'
      } catch (error) {
        report.cleanupError = (error as Error).message
      }
    }
  } catch (error) {
    report.error = (error as Error).message
  } finally {
    try {
      if (runId) await resetIpcAndConfirm(control, runId)
    } catch (error) {
      report.finalReset = 'not-verified'
      report.cleanupError = (error as Error).message
    }
    try {
      if (visibility) report.window!.restoration = await visibility.revert()
    } catch (error) {
      report.windowRestoreError = (error as Error).message
    }
    watchedPage?.off('pageerror', onError)
    control.close()
    if (browser) await browser.close()
  }
  report.ok =
    !report.error &&
    !report.windowRestoreError &&
    report.finalReset === 'healthy' &&
    report.findings.every((f) => f.kind === 'observation')
  return report
}
