import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDemoServer } from '../../examples/demo-server.mjs'
import { assertReportShape } from '../helpers/report-shape.mjs'

let server
before(async () => {
  server = await startDemoServer()
})
after(async () => {
  await server?.close()
})

const scenario = (page) =>
  JSON.stringify({
    url: `${server.url}/${page}`,
    requestPattern: '**/api/profile',
    readySelector: '#profile',
    retrySelector: '#retry',
    timeoutMs: 1200,
  })

test('reruns a check when a file changes and reports what the change fixed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-watch-e2e-'))
  await writeFile(join(root, 'scenario.json'), scenario('broken'))
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../bin/recovery-probe.mjs', import.meta.url)),
      'watch',
      '.',
      '--settle',
      '300',
      '--max-runs',
      '2',
      '--',
      'check',
      '--config',
      'scenario.json',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  let edited = false
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    // Once the starting point has a result, "fix" the app the check points at.
    if (!edited && /^ {2}run 1: /m.test(stdout)) {
      edited = true
      void writeFile(join(root, 'scenario.json'), scenario('fixed'))
    }
  })
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`The watch did not finish:\n${stdout}\n${stderr}`))
      }, 90000)
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
    })
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /^ {2}run 1: [A-Z_]+ \(/m)
    assert.match(stdout, /changed: scenario\.json/)
    assert.match(stdout, /run 2: IMPROVED since run 1/)
    const [watchFolder] = (await readdir(join(root, '.recovery-probe'))).filter(
      (name) => name.startsWith('watch-'),
    )
    const folder = join(root, '.recovery-probe', watchFolder)
    const summary = JSON.parse(
      await readFile(join(folder, 'summary.json'), 'utf8'),
    )
    await assertReportShape(summary, 'watch-summary')
    assert.deepEqual(
      summary.runs.map((run) => run.report),
      ['run-1/report.json', 'run-2/report.json'],
    )
    assert.equal(summary.latest.verdict, 'IMPROVED')
    assert.match(
      await readFile(join(folder, 'summary.md'), 'utf8'),
      /\| Problem \| run 1 \| run 2 \| Change \|/,
    )
  } finally {
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
})
