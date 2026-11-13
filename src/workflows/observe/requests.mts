import type { Page, Route } from 'playwright'
import {
  addCoverageGap,
  faultMode,
  type ObservationReport,
  type ObservationRequests,
  type RequestStepRecord,
} from './report.mjs'
import type { RequestStepControl } from './steps.mjs'

/**
 * Applies observe's request steps to the page's own requests through Playwright routes,
 * counting what each rule failed. Playwright turns off the browser cache while a route is set.
 */
export function requestSteps(page: Page): RequestStepControl & {
  /** Removes the rules in every case, so a capture never leaves the page's requests failing. */
  finish(): Promise<ObservationRequests>
} {
  const faults: RequestStepRecord[] = []
  let routes: { url: string; handler: (route: Route) => Promise<void> }[] = []

  const clear = async () => {
    const armed = routes
    routes = []
    await Promise.all(
      armed.map(({ url, handler }) => page.unroute(url, handler)),
    )
  }

  return {
    async arm(rules, step) {
      await clear()
      const record: Required<Pick<RequestStepRecord, 'step' | 'rules'>> = {
        step,
        rules: rules.map((rule) => ({ ...rule, faulted: 0 })),
      }
      faults.push(record)
      for (const rule of record.rules) {
        const handler = (route: Route) => {
          rule.faulted += 1
          return rule.fault === 'abort'
            ? route.abort('blockedbyclient')
            : route.fulfill({ status: rule.status, body: '' })
        }
        await page.route(rule.url, handler)
        routes.push({ url: rule.url, handler })
      }
    },
    async restore(step) {
      await clear()
      faults.push({ step, restored: true })
    },
    async finish() {
      try {
        await clear()
        return { faults }
      } catch (error) {
        return { faults, restoreError: (error as Error).message }
      }
    },
  }
}

/** Adds request-step evidence to an observation report, with its coverage gaps. */
export function applyRequestEvidence(
  report: ObservationReport,
  requests: ObservationRequests,
): void {
  if (!requests.faults.length) return
  report.requests = requests
  report.mode = faultMode(report)
  if (requests.faults.some((r) => r.rules?.some((rule) => rule.faulted === 0)))
    addCoverageGap(report, 'REQUEST_FAULT_NOT_TRIGGERED')
  if (requests.restoreError)
    addCoverageGap(report, 'REQUEST_FAULTS_NOT_RESTORED')
}
