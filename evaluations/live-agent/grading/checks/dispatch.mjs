// Behavior checks for the dispatch console, from its requirements (ORD-1 to ORD-5). They open
// the Orders view and read what a user sees: row text, status labels and messages.
import { until, visible } from '../wait.mjs'

const SEED = { all: 8, new: 2, packed: 3, shipped: 3 }
const ROWS = '#orders li'

/** The status label of each visible row, or "?" when a row shows none. */
async function rowStates(page) {
  const texts = await page.locator(ROWS).allInnerTexts()
  return texts.map((text) => text.match(/\b(New|Packed|Shipped)\b/)?.[1] ?? '?')
}

const exactly = (states, label, count) =>
  states.length === count && states.every((state) => state === label)

async function rowState(page, id) {
  const text = await page.locator(ROWS, { hasText: id }).first().innerText()
  return text.match(/\b(New|Packed|Shipped)\b/)?.[1] ?? '?'
}

async function loaded(page) {
  await until(
    async () => (await rowStates(page)).length === SEED.all,
    6000,
    'the 8 orders of the first load',
  )
}

const filter = (page, name) =>
  page.getByRole('button', { name, exact: true }).click()

/** Answers GET /api/orders with 503 while `failing()` is true. */
const failOrderReads = (page, failing) =>
  page.route('**/api/orders**', (route) =>
    failing() && route.request().method() === 'GET'
      ? route.fulfill({ status: 503, body: '{}' })
      : route.continue(),
  )

export const checks = {
  async 'lists-every-order'(page, origin) {
    await page.goto(`${origin}/#/orders`)
    await loaded(page)
  },

  async 'first-load-says-loading'(page, origin) {
    await page.goto(`${origin}/#/orders`)
    // Listing every order takes about 900 ms, so the message must be up first.
    if (!(await visible(page, 'Loading orders…')))
      throw new Error('"Loading orders…" was not shown during the first load')
    await loaded(page)
  },

  async 'filter-shows-matching-orders'(page, origin) {
    await page.goto(`${origin}/#/orders`)
    await loaded(page)
    await filter(page, 'Packed')
    await until(
      async () => exactly(await rowStates(page), 'Packed', SEED.packed),
      5000,
      'only the 3 packed orders under Packed',
    )
  },

  async 'quick-filter-change-shows-latest'(page, origin) {
    for (let round = 1; round <= 3; round++) {
      await page.goto(`${origin}/#/orders`)
      // The unfiltered first load is still on its way (about 900 ms).
      await filter(page, 'Shipped')
      await page.waitForTimeout(2500)
      const states = await rowStates(page)
      if (!exactly(states, 'Shipped', SEED.shipped))
        throw new Error(
          `round ${round}: with Shipped selected, the list showed ${JSON.stringify(states)}`,
        )
    }
  },

  async 'failed-refresh-keeps-orders'(page, origin) {
    await page.goto(`${origin}/#/orders`)
    await loaded(page)
    let failing = true
    await failOrderReads(page, () => failing)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await until(
      () => visible(page, 'Could not refresh orders.'),
      5000,
      '"Could not refresh orders." after a failed refresh',
    )
    await page.waitForTimeout(500)
    const states = await rowStates(page)
    if (states.length !== SEED.all)
      throw new Error(
        `after the failed refresh the list showed ${states.length} of 8 orders`,
      )
    failing = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await until(
      async () =>
        !(await visible(page, 'Could not refresh orders.')) &&
        (await rowStates(page)).length === SEED.all,
      5000,
      'the message to go after a successful refresh',
    )
  },

  async 'first-load-failure-can-be-retried'(page, origin) {
    let failing = true
    await failOrderReads(page, () => failing)
    await page.goto(`${origin}/#/orders`)
    await until(
      () => visible(page, 'Could not load orders.'),
      5000,
      '"Could not load orders." after a failed first load',
    )
    failing = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await loaded(page)
  },

  async 'shipping-updates-the-row'(page, origin) {
    await page.goto(`${origin}/#/orders`)
    await loaded(page)
    const row = page.locator(ROWS, { hasText: 'ORD-1002' }).first()
    await row.getByRole('button', { name: 'Mark shipped' }).click()
    await until(
      async () => (await rowState(page, 'ORD-1002')) === 'Shipped',
      3000,
      'ORD-1002 to show Shipped without a reload',
    )
    await page.reload()
    await loaded(page)
    if ((await rowState(page, 'ORD-1002')) !== 'Shipped')
      throw new Error('after a reload ORD-1002 was not shipped on the server')
  },

  async 'failed-shipping-keeps-status'(page, origin) {
    await page.route('**/api/orders/*/status', (route) =>
      route.fulfill({ status: 500, body: '{}' }),
    )
    await page.goto(`${origin}/#/orders`)
    await loaded(page)
    const row = page.locator(ROWS, { hasText: 'ORD-1004' }).first()
    await row.getByRole('button', { name: 'Mark shipped' }).click()
    await until(
      () => visible(page, 'Could not update the order.'),
      5000,
      '"Could not update the order." after a failed update',
    )
    if ((await rowState(page, 'ORD-1004')) !== 'Packed')
      throw new Error('ORD-1004 changed status although the update failed')
  },
}
