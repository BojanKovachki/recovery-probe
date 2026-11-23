import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { freePort } from '../../dist/core/ports.mjs'
import { openBrowser } from '../../dist/tools/verify/apps.mjs'

// A dev server can build the app on its first request, so the first load of a policy app gets
// the time left before its readiness limit, not Playwright's fixed default.
test("the app browser's first load gets the time it's given", async (t) => {
  const port = await freePort()
  const server = createServer((_, response) => {
    setTimeout(() => response.end('<title>slow first load</title>'), 1500)
  })
  await new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve(undefined)),
  )
  t.after(() => server.close())
  const url = `http://127.0.0.1:${port}/`
  await assert.rejects(
    openBrowser(url, 500).then((browser) => browser.close()),
    /Timeout 500ms exceeded/,
  )
  const browser = await openBrowser(url, 10000)
  try {
    const version = await fetch(`${browser.cdp}/json/version`).then((r) =>
      r.json(),
    )
    assert.match(version.Browser, /Chrome/, 'the run attaches to it over CDP')
  } finally {
    await browser.close()
  }
})
