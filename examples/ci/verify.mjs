// Verify both the CLI exit status and evidence: an unrelated crash is never the expected failure.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
await mkdir('artifacts', { recursive: true })
const directory = await mkdtemp(resolve('artifacts/ci-example-'))
for (const variant of ['broken', 'fixed']) {
  const output = join(directory, variant)
  const code = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), variant, output],
      { stdio: 'inherit', timeout: 45000 },
    )
    child.once('error', reject)
    child.once('exit', (status, signal) =>
      signal ? reject(Error(`Example stopped: ${signal}`)) : done(status),
    )
  })
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      await readFile(join(output, 'summary.md'), 'utf8'),
    )
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.equal(report.baseline, true)
  assert.equal(report.fault.applied, 1)
  assert.equal(report.fault.injectionErrors, 0)
  assert.equal(report.cleanup, 'complete')
  assert.equal(code, variant === 'broken' ? 1 : 0)
  assert.equal(report.status, variant === 'broken' ? 'fail' : 'pass')
  assert.equal(
    report.code,
    variant === 'broken' ? 'RECOVERY_ASSERTION_FAILED' : 'OK',
  )
}
console.log(`Broken/fixed CI example verified. Artifacts: ${directory}`)
