import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { translateLegacy } from '../../dist/cli/legacy.mjs'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)
// Runs the CLI and returns its exit code and output, whatever the code.
const run = (...args) =>
  promisify(execFile)(process.execPath, [cli, ...args]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  )

test('old spellings run the new commands with the same options', () => {
  const cases = [
    [['--demo', '--json'], 'demo', { json: true, reportFile: false }],
    [
      ['--config', 'a.json', '--out', 'r.json'],
      'check',
      { config: 'a.json', reportFile: 'r.json' },
    ],
    [['desktop', '--list', '--cdp', 'C'], 'windows', { cdp: 'C' }],
    [
      ['desktop', '--discover', '--page', '1', '--out', 'o'],
      'reads',
      { page: '1', out: 'o', reuseOut: true },
    ],
    [
      ['desktop', '--config', 'a.json', '--screenshots'],
      'check',
      { config: 'a.json', screenshots: true, attach: true, reuseOut: true },
    ],
    [
      ['web', '--login', '--url', 'U', '--state', 's.json'],
      'login',
      { url: 'U', state: 's.json' },
    ],
    [['web', '--discover', '--url', 'U'], 'reads', { url: 'U' }],
    [
      ['web', '--config', 'a.json', '--headed'],
      'check',
      { config: 'a.json', headed: true, launch: true },
    ],
    [['web', '--attach', '--list', '--cdp', 'C'], 'windows', { cdp: 'C' }],
    [
      ['web', '--attach', '--discover', '--page', '0'],
      'reads',
      { page: '0', reuseOut: true },
    ],
    [
      ['web', '--attach', '--discover', '--config', 'a.json', '--screenshots'],
      'discover',
      { config: 'a.json', screenshots: true },
    ],
    [
      ['web', '--attach', '--config', 'a.json', '--cdp', 'C'],
      'check',
      {
        config: 'a.json',
        cdp: 'C',
        attach: true,
        mode: 'attached browser recovery',
      },
    ],
    [
      ['ipc', '--config', 'a.json', '--restore-window'],
      'check',
      { config: 'a.json', 'restore-window': true },
    ],
    [
      ['ipc', '--discover', '--config', 'a.json', '--screenshots'],
      'discover',
      { config: 'a.json', screenshots: true },
    ],
    [['ipc', '--action', '--config', 'a.json'], 'action', { config: 'a.json' }],
  ]
  for (const [argv, command, values] of cases) {
    const translation = translateLegacy(argv)
    assert.equal(translation.command, command, argv.join(' '))
    assert.deepEqual(translation.values, values, argv.join(' '))
  }
  assert.equal(translateLegacy(['check', '--config', 'a.json']), null)
  for (const [argv, message] of [
    [['desktop', '--list', '--config', 'a.json'], /Choose one of/],
    [['ipc', '--discover', '--action', '--config', 'a'], /either --discover/],
    [['ipc', '--action', '--config', 'a', '--screenshots'], /needs --discover/],
    [['web', '--login', '--nope'], /Unknown option '--nope'/],
  ])
    assert.throws(() => translateLegacy(argv), message)
})

test('help lists every command, and old commands point to their new names', async () => {
  const help = await run('--help')
  assert.equal(help.code, 0)
  for (const name of ['init', 'check', 'discover', 'reads', 'windows', 'mcp'])
    assert.match(help.stdout, new RegExp(`^  ${name} +[A-Z]`, 'm'))
  assert.match((await run('check', '--help')).stdout, /--config FILE/)
  assert.match(
    (await run('desktop', '--help')).stdout,
    /windows +was desktop --list/,
  )
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

test('old spellings keep exit code 2 for errors and say what replaced them', async () => {
  const old = await run('desktop', '--list', '--cdp', 'http://127.0.0.1:1')
  assert.equal(old.code, 2)
  assert.match(
    old.stderr,
    /"recovery-probe desktop --list" is now "recovery-probe windows"/,
  )
  assert.equal((await run('desktop', '--nope')).code, 2)
  const quiet = await run('--config', 'missing.json', '--json')
  assert.equal(quiet.code, 2)
  assert.doesNotMatch(quiet.stderr, /is now/)
})
