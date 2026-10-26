import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, Page } from 'playwright'
import type { IpcIdentity } from '../../ipc-probe.cjs'
import { connectDesktop } from '../../targets/cdp.mjs'
import { attachIpcWindow } from '../../targets/ipc-window.mjs'
import {
  prepareVisibility,
  type PreparedVisibility,
} from '../../targets/visibility.mjs'
import {
  resetIpcAndConfirm,
  runSnapshot,
  waitForSettledCalls,
  type IpcFault,
} from '../../transports/ipc/control.mjs'
import {
  connectIpcInspector,
  type IpcInspector,
} from '../../transports/ipc/inspector.mjs'
import { locate, runSteps } from '../observe/step-runner.mjs'
import { classifyActionRuns } from './classify.mjs'
import { actionConfig, MAX_REQUESTS, type IpcActionConfig } from './config.mjs'
import { readScreen, watchScreen } from './screen.mjs'
import type { ActionRun, ActionRunKind, IpcActionReport } from './types.mjs'

export async function checkAction(
  input: unknown,
  {
    connectControl = connectIpcInspector,
  }: { connectControl?: (endpoint: string) => Promise<IpcInspector> } = {},
): Promise<IpcActionReport> {
  const config = actionConfig(input)
  const report = initialReport(config)
  const check = new ActionCheck(
    config,
    report,
    await connectControl(config.inspector),
  )
  try {
    await check.run()
  } catch (error) {
    report.error = (error as Error).message
  } finally {
    await check.release()
  }
  report.ok =
    !report.error &&
    !report.windowRestoreError &&
    report.finalReset === 'healthy' &&
    report.findings.every((f) => f.kind === 'observation')
  return report
}

const initialReport = (config: IpcActionConfig): IpcActionReport => ({
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
})

/** A simulated success, a simulated failure and a double-click, each after a reload. */
class ActionCheck {
  readonly #config: IpcActionConfig
  readonly #report: IpcActionReport
  readonly #control: IpcInspector
  #browser: Browser | undefined
  #page: Page | undefined
  #identity!: IpcIdentity
  #visibility: PreparedVisibility | undefined
  #runId: string | undefined
  #uncaughtErrors = 0
  readonly #countError = () => {
    this.#uncaughtErrors++
  }

  constructor(
    config: IpcActionConfig,
    report: IpcActionReport,
    control: IpcInspector,
  ) {
    this.#config = config
    this.#report = report
    this.#control = control
  }

  async run() {
    const page = await this.#attach()
    const report = this.#report
    try {
      for (const kind of ['success', 'failure', 'double-click'] as const)
        report.runs.push(await this.#perform(page, kind))
      report.findings = classifyActionRuns(report.runs)
    } catch (error) {
      report.error = (error as Error).message
    } finally {
      await this.#reset(page)
    }
  }

  /** Disarms the last run, restores the window and disconnects, leaving the app open. */
  async release() {
    const report = this.#report
    try {
      if (this.#runId) await resetIpcAndConfirm(this.#control, this.#runId)
    } catch (error) {
      report.finalReset = 'not-verified'
      report.cleanupError = (error as Error).message
    }
    try {
      if (this.#visibility)
        report.window!.restoration = await this.#visibility.revert()
    } catch (error) {
      report.windowRestoreError = (error as Error).message
    }
    this.#page?.off('pageerror', this.#countError)
    this.#control.close()
    if (this.#browser) await this.#browser.close()
  }

  async #attach() {
    const config = this.#config
    this.#browser = await connectDesktop(config.cdp)
    const { page, identity } = await attachIpcWindow(
      this.#browser,
      this.#control,
      [config.channel],
    )
    if (!identity.capabilities?.faultDelay)
      throw new Error(
        "The loaded hook can't delay its answers; restart the app with the hook from this version",
      )
    this.#visibility = await prepareVisibility(page, {
      restoreWindow: config.restoreWindow,
      control: this.#control,
    })
    this.#report.window = { initial: this.#visibility.initial }
    page.on('pageerror', this.#countError)
    this.#page = page
    this.#identity = identity
    return page
  }

  async #perform(page: Page, kind: ActionRunKind): Promise<ActionRun> {
    const fault: IpcFault = kind === 'success' ? 'null-result' : 'rejection'
    const { setup, initial, target } = await this.#prepare(page)
    // Arm right before the action, so slow setup can't outlive the plan.
    const id = randomUUID()
    this.#runId = id
    try {
      await this.#arm(id, fault)
      const errorsBefore = this.#uncaughtErrors
      const clicked = performance.now()
      if (kind === 'double-click') await target.dblclick()
      else await target.click()
      const watched = await watchScreen(page, this.#config, initial, clicked)
      const snapshot = await runSnapshot(
        this.#control,
        id,
        this.#identity.senderId,
      )
      return {
        kind,
        fault,
        requests: snapshot.injected,
        realRequests: snapshot.channels[this.#config.channel].realCalls,
        before: initial.ui,
        timeline: watched.timeline,
        final: watched.final,
        announced: watched.announced,
        uncaughtErrors: this.#uncaughtErrors - errorsBefore,
        devErrorOverlay: watched.devErrorOverlay,
        setup,
      }
    } finally {
      await resetIpcAndConfirm(this.#control, id)
    }
  }

  /** Reloads, runs the setup steps and finds the one visible action control. */
  async #prepare(page: Page) {
    const config = this.#config
    await waitForSettledCalls(this.#control, config.observationMs)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    const started = performance.now()
    const setup = await runSteps(page, config.setup, {
      mark: async () => null,
      signal: new AbortController().signal,
      elapsed: () => Math.round(performance.now() - started),
    })
    await sleep(300)
    const initial = await readScreen(page, config.regionSelector)
    const target = locate(page, config.action).filter({ visible: true })
    const count = await target.count()
    if (count !== 1)
      throw new Error(
        `ACTION_TARGET_NOT_UNIQUE: expected exactly one visible match, found ${count}`,
      )
    return { setup, initial, target }
  }

  #arm(id: string, fault: IpcFault) {
    const { channel, latencyMs, observationMs } = this.#config
    return this.#control.call('begin', {
      id,
      channel,
      fault,
      times: MAX_REQUESTS,
      delayMs: latencyMs,
      ttlMs: observationMs + latencyMs + 10000,
    })
  }

  async #reset(page: Page) {
    try {
      if (this.#runId) await resetIpcAndConfirm(this.#control, this.#runId)
      await waitForSettledCalls(this.#control, this.#config.observationMs)
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      this.#report.finalReset = 'healthy'
    } catch (error) {
      this.#report.cleanupError = (error as Error).message
    }
  }
}
