import type { Page } from 'playwright'
import type { FaultKind } from '../../../core/faults.mjs'
import {
  observeHttp,
  type HttpObserver,
} from '../../../transports/http/observer.mjs'
import type { ValidDesktopConfig } from './config.mjs'
import { healthy, waitUntil } from './health.mjs'

export interface DesktopRow {
  kind: FaultKind
  outcome: 'pass' | 'fail' | 'inconclusive' | 'skipped'
  code: string
  applied: number
  successfulResponsesAfterFault: number
  retryClicked: boolean
  recoveryMs?: number | null
  screenshot?: string
  evidenceCaptureFailed?: boolean
}

type Stage = 'setup' | 'reload' | 'retry' | 'recovery'

/** One fault on a healthy page: arm it, reload, retry if configured, wait for recovery. */
export class FaultTrial {
  readonly #page: Page
  readonly #config: ValidDesktopConfig
  readonly #row: DesktopRow
  #observer: HttpObserver | undefined
  #stage: Stage = 'setup'

  constructor(page: Page, config: ValidDesktopConfig, row: DesktopRow) {
    this.#page = page
    this.#config = config
    this.#row = row
  }

  /** Fills the row; true when the next faults can't be trusted to run. */
  async run(): Promise<boolean> {
    let blocked: boolean
    try {
      blocked = await this.#attempt()
    } catch {
      blocked = this.#interrupted()
    }
    return (await this.#stop()) || blocked
  }

  async #attempt() {
    const config = this.#config
    this.#observer = await observeHttp(this.#page, {
      endpoint: config.endpoint,
      fault: this.#row.kind,
      times: config.times,
    })
    this.#stage = 'reload'
    await this.#page.reload({
      waitUntil: 'domcontentloaded',
      timeout: config.baselineTimeoutMs,
    })
    await this.#page.bringToFront()
    const injected = () => {
      const snapshot = this.#progress()
      return snapshot.injected === config.times || snapshot.injectionError
    }
    if (!(await waitUntil(injected, config.recoveryTimeoutMs)))
      return this.#block('FAULT_NOT_TRIGGERED')
    if (this.#progress().injectionError) return this.#block('INJECTION_ERROR')
    if (config.recovery === 'retry') await this.#retry()
    await this.#recover()
    return false
  }

  async #retry() {
    this.#stage = 'retry'
    const { retrySelector, timeoutMs } = this.#config
    // Validation requires a retry selector for retry recovery.
    const retry = this.#page.locator(retrySelector!)
    await retry.waitFor({ state: 'visible', timeout: timeoutMs })
    await retry.click({ timeout: timeoutMs })
    this.#row.retryClicked = true
  }

  async #recover() {
    this.#stage = 'recovery'
    const { recoveryTimeoutMs } = this.#config
    // The fault was applied, so the observer stamped its time.
    const startedAt = this.#progress().injectedAt!
    const remainingMs = Math.max(
      0,
      recoveryTimeoutMs - (Date.now() - startedAt),
    )
    const recovered =
      (await waitUntil(
        async () =>
          this.#progress().successfulAfterFault > 0 &&
          (await healthy(this.#page, this.#config)),
        remainingMs,
      )) && Date.now() - startedAt <= recoveryTimeoutMs
    this.#row.outcome = recovered ? 'pass' : 'fail'
    this.#row.code = recovered ? 'RECOVERED' : 'RECOVERY_NOT_OBSERVED'
    this.#row.recoveryMs = recovered ? Date.now() - startedAt : null
  }

  /** Classifies an error thrown at the current stage. */
  #interrupted() {
    const snapshot = this.#observer && this.#progress()
    if (this.#stage === 'setup' || snapshot?.injectionError)
      return this.#block('INJECTION_ERROR')
    if (this.#row.applied !== this.#config.times)
      return this.#block('FAULT_NOT_TRIGGERED')
    if (this.#stage === 'reload') return this.#block('RELOAD_FAILED')
    const retrying = this.#stage === 'retry'
    this.#row.outcome = retrying ? 'inconclusive' : 'fail'
    this.#row.code = retrying
      ? 'RETRY_ACTION_UNAVAILABLE'
      : 'RECOVERY_NOT_OBSERVED'
    return false
  }

  // The observer counts faults and the successful reads that started after them,
  // leaving out the injected malformed-JSON response.
  #progress() {
    const snapshot = this.#observer!.snapshot()
    this.#row.applied = snapshot.injected
    this.#row.successfulResponsesAfterFault = snapshot.successfulAfterFault
    return snapshot
  }

  #block(code: string) {
    this.#row.code = code
    return true
  }

  /** Stops the observer, which removes its route and waits for its injected responses. */
  async #stop() {
    try {
      await this.#observer?.stop()
      return false
    } catch {
      this.#row.outcome = 'inconclusive'
      return this.#block('CLEANUP_FAILED')
    }
  }
}
