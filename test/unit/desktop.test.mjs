import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateDesktopConfig,
  pageIdentity,
  selectDesktopPage,
  connectDesktop,
} from '../../dist/desktop.mjs'
import {
  desktopReportHtml,
  writeDesktopReport,
} from '../../dist/reports/check.mjs'
const config = {
  pageUrl: 'http://localhost/app',
  endpoint: 'https://api.example.test/data',
  readySelector: '#ready',
  retrySelector: '#retry',
}
test('rejects unsafe or ambiguous configuration before connecting or reloading', async () => {
  for (const endpoint of [
    'https://user:pass@example.test/data',
    'https://api.example.test/data?token=secret',
    'file:///data',
    'https://api.example.test/data#secret',
  ])
    assert.throws(() => validateDesktopConfig({ ...config, endpoint }))
  for (const timeoutMs of [-1, 0, 199, 60001, NaN])
    assert.throws(() => validateDesktopConfig({ ...config, timeoutMs }))
  assert.throws(() => validateDesktopConfig({ ...config, readySelector: '' }))
  assert.throws(() => validateDesktopConfig({ ...config, retrySelector: '' }))
  assert.throws(() => validateDesktopConfig({ ...config, faults: [] }))
  assert.throws(() =>
    validateDesktopConfig({ ...config, faults: ['http-error', 'http-error'] }),
  )
  for (const cdp of [
    'https://example.com',
    'http://0.0.0.0:9222',
    'http://user:pass@localhost:9222',
  ])
    await assert.rejects(connectDesktop(cdp), /loopback/)
  assert.equal(
    validateDesktopConfig({
      ...config,
      recovery: 'automatic',
      retrySelector: undefined,
    }).recovery,
    'automatic',
  )
})
test('page identities omit credentials, query strings and fragments', () => {
  assert.equal(
    pageIdentity(
      'https://user:secret@example.test/app?token=private#access_token=secret',
    ),
    'https://example.test/app',
  )
})
test('never silently picks between multiple app windows', () => {
  const a = { url: () => 'http://localhost/app' }
  const b = { url: () => 'http://localhost/app' }
  const browser = { contexts: () => [{ pages: () => [a, b] }] }
  assert.throws(() => selectDesktopPage(browser), /Choose one window/)
  assert.throws(
    () => selectDesktopPage(browser, { pageUrl: a.url() }),
    /Choose one window/,
  )
  assert.equal(selectDesktopPage(browser, { page: 1, pageUrl: a.url() }), b)
  assert.throws(
    () =>
      selectDesktopPage(browser, {
        page: 1,
        pageUrl: 'http://localhost/wrong',
      }),
    /another page/,
  )
})
test('reports escape application metadata and reject unsafe screenshot paths', () => {
  const html = desktopReportHtml({
    endpoint: '<img src=x onerror=alert(1)>',
    timeoutMs: 500,
    generatedAt: '',
    recovery: 'retry',
    finalReset: 'healthy',
    results: [
      {
        kind: 'http-error',
        outcome: 'fail',
        code: '<script>bad</script>',
        applied: 1,
        successfulResponsesAfterFault: 0,
        screenshot: 'https://tracker.example/image.png',
      },
    ],
  })
  assert.ok(!html.includes('<script>bad'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('src="https://tracker'))
})

test('reports say why a baseline failed and quote the screen under a fault', async () => {
  const row = {
    kind: 'http-error',
    applied: 0,
    successfulResponsesAfterFault: 0,
    retryClicked: false,
  }
  const report = {
    endpoint: 'https://api.example.test/orders',
    timeoutMs: 500,
    generatedAt: '',
    recovery: 'automatic',
    finalReset: 'healthy',
    ok: false,
    limitation: '',
    results: [
      {
        ...row,
        outcome: 'inconclusive',
        code: 'BASELINE_FAILED',
        reason: 'the ready selector matched 2 elements',
      },
      {
        ...row,
        kind: 'timeout',
        outcome: 'fail',
        code: 'RECOVERY_NOT_OBSERVED',
        screenText: 'You have <no> orders yet\nRetry',
        applied: 1,
      },
    ],
  }
  const html = desktopReportHtml(report)
  assert.ok(html.includes('Why: the ready selector matched 2 elements'))
  assert.ok(
    html.includes(
      'Screen showed: &quot;You have &lt;no&gt; orders yet / Retry&quot;',
    ),
  )
  const directory = await mkdtemp(join(tmpdir(), 'recovery-probe-brief-'))
  try {
    await writeDesktopReport(directory, report, {})
    const brief = await readFile(join(directory, 'fix-brief.md'), 'utf8')
    assert.match(
      brief,
      /- http-error: BASELINE_FAILED; .*; Why: the ready selector matched 2 elements\n/,
    )
    assert.match(
      brief,
      /- timeout: RECOVERY_NOT_OBSERVED; .*; Screen showed: "You have <no> orders yet \/ Retry"\n/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
