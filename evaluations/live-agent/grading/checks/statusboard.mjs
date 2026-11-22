// Behavior checks for the status board, from its requirements (HLT, NTF and SYN). They read
// what a user sees: service rows, state labels and messages.
import { until, visible } from '../wait.mjs'

const SERVICES = 5
const STATE = /\b(Operational|Degraded|Outage)\b/

async function serviceStates(page) {
  const texts = await page.locator('#services li').allInnerTexts()
  return texts.map((text) => text.match(STATE)?.[1] ?? '?')
}

const listed = async (page) => {
  const states = await serviceStates(page)
  return states.length === SERVICES && !states.includes('?')
}

/** Answers GET /api/services with 503 while `failing(call)` is true; counts the reads. */
async function serviceReads(page, failing) {
  const reads = { count: 0 }
  await page.route('**/api/services', (route) => {
    reads.count++
    return failing(reads.count)
      ? route.fulfill({ status: 503, body: '{}' })
      : route.continue()
  })
  return reads
}

const UNAVAILABLE = 'Service health unavailable'
const EMPTY = "You're all caught up"
const FAILED = 'Could not load notifications.'

export const checks = {
  async 'lists-every-service'(page, origin) {
    await page.goto(origin)
    await until(() => listed(page), 5000, 'the 5 services and their states')
  },

  async 'health-recovers-after-two-failures'(page, origin) {
    const reads = await serviceReads(page, (call) => call <= 2)
    await page.goto(origin)
    // Retries after 1 and 2 seconds: the third read succeeds after about 3 seconds.
    await until(
      () => listed(page),
      10000,
      'the services after two failed reads, without pressing Retry',
    )
    if (await visible(page, UNAVAILABLE))
      throw new Error(`"${UNAVAILABLE}" is still shown`)
    if (reads.count < 3)
      throw new Error(`only ${reads.count} health reads were made`)
  },

  async 'health-gives-up-after-three-retries'(page, origin) {
    let failing = true
    const reads = await serviceReads(page, () => failing)
    await page.goto(origin)
    await until(
      () => visible(page, UNAVAILABLE),
      15000,
      `"${UNAVAILABLE}" after the retries`,
    )
    await page.waitForTimeout(1500)
    if (reads.count !== 4)
      throw new Error(
        `${reads.count} health reads before giving up, not 1 and 3 retries`,
      )
    failing = false
    await page.getByRole('button', { name: 'Retry' }).first().click()
    await until(() => listed(page), 10000, 'the services after Retry')
  },

  async 'empty-notifications-say-caught-up'(page, origin) {
    await page.goto(origin)
    await until(() => visible(page, EMPTY), 5000, `"${EMPTY}" for dana`)
    if ((await page.locator('#notifications li').count()) !== 0)
      throw new Error('notifications were listed for an account that has none')
    if (await visible(page, FAILED)) throw new Error(`"${FAILED}" was shown`)
  },

  async 'failed-notifications-are-not-empty'(page, origin) {
    let failing = true
    await page.route('**/api/notifications', (route) =>
      failing ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
    )
    await page.goto(origin)
    await until(
      () => visible(page, FAILED),
      5000,
      `"${FAILED}" after a failure`,
    )
    if (await visible(page, EMPTY))
      throw new Error(`"${EMPTY}" was shown after a failed read`)
    failing = false
    await page
      .locator('section', { hasText: 'Notifications' })
      .getByRole('button', { name: 'Retry' })
      .click()
    await until(() => visible(page, EMPTY), 5000, `"${EMPTY}" after Retry`)
  },

  async 'notifications-newest-first'(page, origin) {
    await page.route('**/api/notifications', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'a',
            title: 'Older notice',
            createdAt: '2026-11-01T08:00:00.000Z',
          },
          {
            id: 'b',
            title: 'Newer notice',
            createdAt: '2026-11-02T08:00:00.000Z',
          },
        ]),
      }),
    )
    await page.goto(origin)
    const items = page.locator('#notifications li')
    await until(
      async () => (await items.count()) === 2,
      5000,
      'two notifications',
    )
    const first = await items.first().innerText()
    if (!first.includes('Newer notice'))
      throw new Error(`the first notification was "${first.trim()}"`)
  },

  async 'sync-shows-time-and-states'(page, origin) {
    await page.goto(origin)
    await until(() => listed(page), 5000, 'the services')
    await page.getByRole('button', { name: 'Sync now' }).click()
    await until(() => visible(page, 'Last synced at'), 6000, '"Last synced at"')
    // Upstream answers "operational" for the Public API, which started degraded.
    await until(
      async () =>
        (
          await page
            .locator('#services li', { hasText: 'Public API' })
            .first()
            .innerText()
        ).includes('Operational'),
      5000,
      'the Public API to show its synced state',
    )
  },
}
