import type { Page, Request, Response, Route } from 'playwright'
import type { FaultKind } from '../../core/faults.mjs'
import { defaultFaults } from '../../core/faults.mjs'
import { pageIdentity } from '../../core/urls.mjs'
import { isReadRequest } from '../../transports/http/reads.mjs'

export interface DesktopConfig {
  cdp?: string
  page?: number
  pageUrl: string
  endpoint: string
  readySelector: string
  readyText?: string
  busySelector?: string
  recovery?: 'retry' | 'automatic'
  retrySelector?: string
  timeoutMs?: number
  baselineTimeoutMs?: number
  recoveryTimeoutMs?: number
  times?: number
  faults?: FaultKind[]
}

/** A configuration after validation: defaults applied, the endpoint and page normalized. */
export type ValidDesktopConfig = DesktopConfig &
  Required<
    Pick<
      DesktopConfig,
      | 'recovery'
      | 'timeoutMs'
      | 'baselineTimeoutMs'
      | 'recoveryTimeoutMs'
      | 'times'
      | 'faults'
    >
  >

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

export interface DesktopReport {
  schemaVersion: number
  mode: string
  generatedAt: string
  endpoint: string
  recovery: string
  timeoutMs: number
  baselineTimeoutMs: number
  recoveryTimeoutMs: number
  times: number
  results: DesktopRow[]
  finalReset: string
  ok: boolean
  limitation: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const kinds = new Set<string>(defaultFaults.map((f) => f.kind))

// Configurations also come from JSON files, so every field is checked at runtime.
export function validateDesktopConfig(
  input: DesktopConfig,
): ValidDesktopConfig {
  const config: Record<string, unknown> = {
    times: 1,
    timeoutMs: 5000,
    recovery: 'retry',
    faults: [...kinds],
    ...input,
  }
  for (const key of ['pageUrl', 'endpoint', 'readySelector']) {
    const value = config[key]
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${key} is required`)
  }
  for (const key of ['baselineTimeoutMs', 'recoveryTimeoutMs']) {
    config[key] ??= config.timeoutMs
    const value = config[key]
    if (
      !Number.isInteger(value) ||
      (value as number) < 200 ||
      (value as number) > 60000
    )
      throw new Error(`Invalid ${key}`)
  }
  const times = config.times as number
  if (!Number.isInteger(times) || times < 1 || times > 10)
    throw new Error('times must be 1–10')
  const endpoint = new URL(config.endpoint as string)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'endpoint must be an HTTP(S) origin and path, without credentials, query, or fragment',
    )
  }
  config.endpoint = endpoint.href
  config.pageUrl = pageIdentity(config.pageUrl as string)
  if (!['retry', 'automatic'].includes(config.recovery as string))
    throw new Error('recovery must be retry or automatic')
  if (
    config.recovery === 'retry' &&
    (typeof config.retrySelector !== 'string' || !config.retrySelector.trim())
  )
    throw new Error('retrySelector is required for retry recovery')
  for (const key of ['busySelector', 'readyText']) {
    const value = config[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      throw new Error(`${key} must be a non-empty string`)
  }
  const timeoutMs = config.timeoutMs as number
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 60000)
    throw new Error('timeoutMs must be 200–60000')
  const faults = config.faults
  if (
    !Array.isArray(faults) ||
    !faults.length ||
    new Set(faults).size !== faults.length ||
    faults.some((f) => !kinds.has(f))
  )
    throw new Error('faults must contain unique supported fault kinds')
  const page = config.page
  if (page !== undefined && (!Number.isInteger(page) || (page as number) < 0))
    throw new Error('page must be a non-negative integer')
  return config as unknown as ValidDesktopConfig
}

async function healthy(page: Page, config: ValidDesktopConfig) {
  const ready = page.locator(config.readySelector)
  if ((await ready.count()) !== 1 || !(await ready.isVisible())) return false
  if (
    config.readyText !== undefined &&
    !(await ready.innerText()).includes(config.readyText)
  )
    return false
  if (config.busySelector) {
    const busy = page.locator(config.busySelector)
    for (const item of await busy.all())
      if (await item.isVisible()) return false
  }
  return true
}

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await fn()) return true
    await sleep(Math.min(50, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  return false
}

async function baseline(page: Page, config: ValidDesktopConfig) {
  let successes = 0
  const listener = (response: Response) => {
    if (
      isReadRequest(response.request(), page, config.endpoint) &&
      response.ok()
    )
      successes++
  }
  page.on('response', listener)
  try {
    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: config.baselineTimeoutMs,
    })
    return await waitUntil(
      async () => successes > 0 && (await healthy(page, config)),
      config.baselineTimeoutMs,
    )
  } catch {
    return false
  } finally {
    page.off('response', listener)
  }
}

/** Tests one explicitly selected GET endpoint in the existing renderer, leaving the app open. */
export async function checkDesktop(
  page: Page,
  input: DesktopConfig,
  {
    onFailure,
  }: { onFailure?: (page: Page, row: DesktopRow) => Promise<void> } = {},
): Promise<DesktopReport> {
  const config = validateDesktopConfig(input)
  if (pageIdentity(page.url()) !== config.pageUrl)
    throw new Error('The selected page does not match pageUrl')
  // Validate locator syntax before changing page state. A typo must not be a reported app bug.
  for (const key of [
    'readySelector',
    'retrySelector',
    'busySelector',
  ] as const) {
    const selector = config[key]
    if (selector) await page.locator(selector).count()
  }
  // CDP can attach to a background Electron window. Activate the selected page
  // so real actionability checks receive animation frames; never force clicks.
  await page.bringToFront()
  const report: DesktopReport = {
    schemaVersion: 1,
    mode: 'desktop renderer recovery',
    generatedAt: new Date().toISOString(),
    endpoint: config.endpoint,
    recovery: config.recovery,
    timeoutMs: config.timeoutMs,
    baselineTimeoutMs: config.baselineTimeoutMs,
    recoveryTimeoutMs: config.recoveryTimeoutMs,
    times: config.times,
    results: [],
    finalReset: 'not-run',
    ok: false,
    limitation:
      'A pass checks only the selected GET origin/path and configured UI marker. It is not proof of overall app health. Query variants share a fault budget. Native SDK/IPC requests are outside this check.',
  }
  let stop = false
  for (const kind of config.faults) {
    const row: DesktopRow = {
      kind,
      outcome: 'inconclusive',
      code: 'BASELINE_FAILED',
      applied: 0,
      successfulResponsesAfterFault: 0,
      retryClicked: false,
    }
    report.results.push(row)
    if (stop) {
      row.code = 'PREVIOUS_CHECK_BLOCKED'
      row.outcome = 'skipped'
      continue
    }
    if (!(await baseline(page, config))) {
      stop = true
      continue
    }
    let reserved = 0
    let injectedAt: number | undefined
    let injected = false
    let injectionError = false
    let stage: 'setup' | 'reload' | 'retry' | 'recovery' = 'setup'
    let routeInstalled = false
    const injectedRequests = new Set<Request>()
    const pending = new Set<Promise<void>>()
    const match = (url: URL) => pageIdentity(url.href) === config.endpoint
    const handler = async (route: Route) => {
      if (
        reserved >= config.times ||
        !isReadRequest(route.request(), page, config.endpoint)
      )
        return route.fallback()
      reserved++
      injectedAt ??= Date.now()
      injectedRequests.add(route.request())
      const op = (async () => {
        try {
          if (kind === 'connection-failure')
            await route.abort('connectionfailed')
          else
            await route.fulfill({
              status: kind === 'http-error' ? 503 : 200,
              contentType: 'application/json',
              body:
                kind === 'invalid-json'
                  ? '{invalid-json'
                  : '{"error":"injected-test-fault"}',
            })
          row.applied++
        } catch {
          injectionError = true
        } finally {
          injected = row.applied === config.times || injectionError
        }
      })()
      pending.add(op)
      try {
        await op
      } finally {
        pending.delete(op)
      }
    }
    // Track a successful request that started AFTER the injected request was reserved.
    // Exclude the deliberately fulfilled malformed-JSON response (HTTP 200).
    const candidates = new Set<Request>()
    const requestListener = (request: Request) => {
      if (!isReadRequest(request, page, config.endpoint)) return
      if (reserved === config.times) candidates.add(request)
    }
    const responseListener = (response: Response) => {
      if (
        candidates.has(response.request()) &&
        !injectedRequests.has(response.request())
      ) {
        candidates.delete(response.request())
        if (response.ok()) row.successfulResponsesAfterFault++
      }
    }
    const failedListener = (request: Request) => candidates.delete(request)
    page.on('request', requestListener)
    page.on('response', responseListener)
    page.on('requestfailed', failedListener)
    try {
      await page.route(match, handler)
      routeInstalled = true
      stage = 'reload'
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: config.baselineTimeoutMs,
      })
      await page.bringToFront()
      if (!(await waitUntil(() => injected, config.recoveryTimeoutMs))) {
        row.code = 'FAULT_NOT_TRIGGERED'
        stop = true
      } else if (injectionError) {
        row.code = 'INJECTION_ERROR'
        stop = true
      } else {
        if (config.recovery === 'retry') {
          stage = 'retry'
          // Validation requires a retry selector for retry recovery.
          const retry = page.locator(config.retrySelector!)
          await retry.waitFor({ state: 'visible', timeout: config.timeoutMs })
          await retry.click({ timeout: config.timeoutMs })
          row.retryClicked = true
        }
        stage = 'recovery'
        // The fault was applied, so the handler stamped its time.
        const startedAt = injectedAt!
        const remainingMs = Math.max(
          0,
          config.recoveryTimeoutMs - (Date.now() - startedAt),
        )
        const recovered =
          (await waitUntil(
            async () =>
              row.successfulResponsesAfterFault > 0 &&
              (await healthy(page, config)),
            remainingMs,
          )) && Date.now() - startedAt <= config.recoveryTimeoutMs
        row.outcome = recovered ? 'pass' : 'fail'
        row.code = recovered ? 'RECOVERED' : 'RECOVERY_NOT_OBSERVED'
        row.recoveryMs = recovered ? Date.now() - startedAt : null
      }
    } catch {
      if (stage === 'setup') {
        row.code = 'INJECTION_ERROR'
        stop = true
      } else if (injectionError) {
        row.code = 'INJECTION_ERROR'
        stop = true
      } else if (row.applied !== config.times) {
        row.code = 'FAULT_NOT_TRIGGERED'
        stop = true
      } else if (stage === 'retry') {
        row.outcome = 'inconclusive'
        row.code = 'RETRY_ACTION_UNAVAILABLE'
      } else if (stage === 'recovery') {
        row.outcome = 'fail'
        row.code = 'RECOVERY_NOT_OBSERVED'
      } else {
        row.code = 'RELOAD_FAILED'
        stop = true
      }
    } finally {
      try {
        if (routeInstalled) await page.unroute(match, handler)
      } catch {
        row.outcome = 'inconclusive'
        row.code = 'CLEANUP_FAILED'
        stop = true
      }
      await Promise.allSettled([...pending])
      page.off('request', requestListener)
      page.off('response', responseListener)
      page.off('requestfailed', failedListener)
    }
    if (row.outcome !== 'pass' && onFailure) {
      try {
        await onFailure(page, row)
      } catch {
        row.evidenceCaptureFailed = true
      }
    }
  }
  // A reload rescue is cleanup, not a successful Retry result.
  report.finalReset = (await baseline(page, config))
    ? 'healthy'
    : 'not-verified'
  report.ok =
    report.results.every((row) => row.outcome === 'pass') &&
    report.finalReset === 'healthy'
  return report
}
