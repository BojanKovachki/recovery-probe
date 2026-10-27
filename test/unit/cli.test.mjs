import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)
// Runs the CLI and returns its exit code and output, whatever the code.
const run = (...args) =>
  promisify(execFile)(process.execPath, [cli, ...args]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  )

test('help lists every command', async () => {
  const help = await run('--help')
  assert.equal(help.code, 0)
  for (const name of ['init', 'check', 'discover', 'reads', 'windows', 'mcp'])
    assert.match(help.stdout, new RegExp(`^  ${name} +[A-Z]`, 'm'))
  assert.match((await run('check', '--help')).stdout, /--config FILE/)
})

test('exit codes tell wrong usage from a run that could not start', async () => {
  const wrong = await run('check', '--nope')
  assert.equal(wrong.code, 3)
  assert.match(wrong.stderr, /Unknown option '--nope'/)
  assert.equal((await run('nope')).code, 3)
  assert.equal((await run('check')).code, 3)
  const missing = await run('check', '--config', 'missing.json')
  assert.equal(missing.code, 3)
  assert.match(missing.stderr, /Can't read missing\.json/)
  const unreachable = await run('windows', '--cdp', 'http://127.0.0.1:1')
  assert.equal(unreachable.code, 4)
  assert.match(
    unreachable.stderr,
    /Nothing answered on http:\/\/127\.0\.0\.1:1/,
  )
})

test('the spellings 1.0 removed are wrong usage that names what replaced them', async () => {
  for (const [args, replacement] of /** @type {[string[], RegExp][]} */ ([
    [['desktop', '--list'], /1\.0 replaced it with windows, reads and check\./],
    [
      ['ipc', '--config', 'a.json'],
      /replaced it with check, discover and action\./,
    ],
    [['--demo'], /replaced it with demo\./],
  ])) {
    const removed = await run(...args)
    assert.equal(removed.code, 3)
    assert.match(removed.stderr, replacement)
  }
})
