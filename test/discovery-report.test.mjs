import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  callsGap,
  findingId,
  laterCalls,
  writeDiscoveryReport,
} from '../dist/discovery-report.mjs'
import { retainPartialFindings } from '../dist/discovery-control.mjs'

test('later calls are failed one by one only when every healthy load made as many', () => {
  assert.deepEqual(laterCalls([1, 1, 1]), [])
  assert.deepEqual(laterCalls([2, 2, 2]), [2])
  assert.deepEqual(laterCalls([6, 6, 6]), [2, 3, 4])
  assert.deepEqual(laterCalls([2, 3, 2]), [])
  assert.equal(callsGap([1, 1, 1]), undefined)
  assert.equal(callsGap([3, 3, 3]), undefined)
  assert.match(callsGap([2, 3, 2]), /different number of times \(2, 3, 2\)/)
  assert.match(callsGap([6, 6, 6]), /after the 4th/)
  assert.match(callsGap([2, 2, 2], false), /Restart the app/)
})

test('a later-call experiment keeps its own id, also when it is cut short', () => {
  assert.equal(findingId({ fault: 'rejection', times: 2 }), 'rejection-2')
  assert.equal(
    findingId({ fault: 'rejection', times: 1, call: 2 }),
    'rejection-1-call2',
  )
  const interpretation = { classification: 'RECOVERED', kind: 'observation' }
  const report = {
    results: [
      { fault: 'rejection', times: 1, interpretation },
      { fault: 'rejection', times: 1, call: 2, interpretation },
    ],
    findings: [{ id: 'rejection-1' }],
    error: 'CONTROL_UNSTABLE',
  }
  retainPartialFindings(report, 3)
  assert.equal(report.findings.length, 2)
  assert.equal(report.findings[1].id, 'rejection-1-call2')
  assert.equal(report.findings[1].call, 2)
  assert.equal(report.findings[1].partial, true)
})

test('the discovery report shows only screenshots saved in its folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rp-discovery-'))
  try {
    await writeDiscoveryReport(
      directory,
      {
        findings: [],
        limitation: '',
        baselines: [{ screenshot: 'baseline.png' }, {}],
        results: [
          { screenshot: 'rejection-1-call2-run1.png' },
          { screenshot: '../outside.png' },
          { screenshot: 'x.png" onerror="alert(1)' },
        ],
      },
      {},
    )
    const html = await readFile(join(directory, 'report.html'), 'utf8')
    assert.equal(html.match(/<figure>/g).length, 2)
    assert.match(html, /<img [^>]*src="baseline\.png">/)
    assert.match(html, /<figcaption>rejection-1-call2-run1<\/figcaption>/)
    await writeDiscoveryReport(directory, { findings: [], limitation: '' }, {})
    assert.doesNotMatch(
      await readFile(join(directory, 'report.html'), 'utf8'),
      /<h2>Screenshots/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('only discovery takes screenshots', async () => {
  const cli = fileURLToPath(
    new URL('../bin/recovery-probe.mjs', import.meta.url),
  )
  for (const args of [
    ['ipc', '--screenshots', '--config', 'missing.json'],
    ['web', '--attach', '--screenshots', '--config', 'missing.json'],
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, ...args]),
      (error) => /--screenshots needs --discover/.test(error.stderr),
      args.join(' '),
    )
})
