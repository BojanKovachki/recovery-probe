import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  runWatch,
  validateCheckCommand,
  watchSources,
} from '../../dist/watch.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const within = (promise, ms, what) =>
  Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`Timed out waiting for ${what}`)
    }),
  ])
async function until(condition, ms, what) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(50)
  }
}
const action = (findings) =>
  JSON.stringify({
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: 'contacts:add',
    findings: findings.map(([classification, kind]) => ({
      classification,
      kind,
    })),
  })

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-watch-'))
  for (const folder of ['src', 'node_modules', '.recovery-probe'])
    await mkdir(join(root, folder))
  await writeFile(join(root, 'src', 'store.ts'), 'export const a = 1\n')
  return root
}

for (const recursive of [true, false])
  test(`reports changed source files once they are quiet, and leaves dependencies and reports alone (${recursive ? 'native' : 'per folder'})`, async () => {
    const root = await project()
    const batches = []
    const watcher = await watchSources([root], (files) => batches.push(files), {
      settleMs: 300,
      recursive,
    })
    try {
      await sleep(200)
      await writeFile(join(root, 'node_modules', 'lib.js'), 'x')
      await writeFile(join(root, '.recovery-probe', 'report.json'), '{}')
      await writeFile(join(root, 'src', 'store.ts'), 'export const a = 2\n')
      await writeFile(join(root, 'src', 'store.ts'), 'export const a = 3\n')
      await writeFile(join(root, 'src', 'view.ts'), 'export const b = 1\n')
      await until(() => batches.length, 5000, 'a change')
      await sleep(700)
      assert.equal(batches.length, 1)
      assert.deepEqual(
        batches[0].map((file) => relative(root, file).split(sep).join('/')),
        ['src/store.ts', 'src/view.ts'],
      )
      // A folder created during the watch is watched too.
      await mkdir(join(root, 'src', 'feature'))
      await writeFile(join(root, 'src', 'feature', 'list.ts'), 'export {}\n')
      await until(() => batches.length > 1, 5000, 'a change in a new folder')
      assert.ok(
        batches
          .slice(1)
          .flat()
          .some((file) => file.endsWith(join('feature', 'list.ts'))),
      )
    } finally {
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })

test('reruns the check after a change and compares it with the first run', async () => {
  const root = await project()
  const calls = []
  const events = []
  const out = join(root, '.recovery-probe', 'watch')
  const runCommand = async (args) => {
    calls.push(args)
    const folder = args[args.indexOf('--out') + 1]
    await mkdir(folder)
    await writeFile(
      join(folder, 'report.json'),
      calls.length === 1
        ? action([['SILENT_FAILURE', 'suspected-defect']])
        : action([['FEEDBACK_SHOWN', 'observation']]),
    )
    return { exitCode: calls.length === 1 ? 2 : 0, output: 'checked\n' }
  }
  try {
    const result = await within(
      runWatch({
        paths: [join(root, 'src')],
        command: ['ipc', '--action', '--config', 'action.json'],
        settleMs: 200,
        maxRuns: 2,
        out,
        runCommand,
        onEvent(event) {
          events.push(event)
          // The edit that fixes it, with a suspect of its own.
          if (event.type === 'run' && event.run.run === 1)
            void writeFile(
              join(root, 'src', 'store.ts'),
              'export const rows = async () => (await load()) ?? []\n',
            )
        },
      }),
      15000,
      'two runs',
    )
    assert.deepEqual(calls[0], [
      'ipc',
      '--action',
      '--config',
      'action.json',
      '--out',
      join(out, 'run-1'),
    ])
    assert.equal(result.runs.length, 2)
    assert.equal(result.runs[0].sinceStart, undefined)
    assert.equal(result.runs[1].sinceStart.verdict, 'IMPROVED')
    assert.equal(result.latest.verdict, 'IMPROVED')
    assert.ok(result.runs[1].changed[0].endsWith('src/store.ts'))
    const suspects = events.find((event) => event.type === 'suspects')
    assert.equal(suspects.suspects[0].pattern, 'UNKNOWN_AS_EMPTY')
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type !== 'running'),
      ['start', 'run', 'changed', 'suspects', 'run', 'stop'],
    )
    const summary = JSON.parse(
      await readFile(join(out, 'summary.json'), 'utf8'),
    )
    assert.deepEqual(summary.runs[0].problems, ['SILENT_FAILURE'])
    assert.equal(summary.runs[1].report, 'run-2/report.json')
    assert.equal(summary.latest.verdict, 'IMPROVED')
    assert.match(
      await readFile(join(out, 'summary.md'), 'utf8'),
      /\*\*Improved:\*\* 1 problem gone/,
    )
    assert.equal(await readFile(join(out, 'run-2.log'), 'utf8'), 'checked\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('records a run that wrote no report, with the reason it printed', async () => {
  const root = await project()
  try {
    const result = await within(
      runWatch({
        paths: [join(root, 'src')],
        command: ['--config', 'scenario.json'],
        maxRuns: 1,
        out: join(root, '.recovery-probe', 'watch'),
        runCommand: async (args) => {
          assert.ok(args.at(-1).endsWith(join('run-1', 'report.json')))
          return {
            exitCode: 2,
            output:
              'Starting\nRecovery Probe: connect ECONNREFUSED 127.0.0.1:9222\n',
          }
        },
      }),
      10000,
      'one run',
    )
    assert.equal(
      result.runs[0].error,
      'Recovery Probe: connect ECONNREFUSED 127.0.0.1:9222',
    )
    assert.equal(result.latest, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans changed files for suspects without a check', async () => {
  const root = await project()
  const controller = new AbortController()
  const events = []
  try {
    const watching = runWatch({
      paths: [join(root, 'src')],
      settleMs: 200,
      out: join(root, '.recovery-probe', 'watch'),
      signal: controller.signal,
      onEvent(event) {
        events.push(event)
        if (event.type === 'suspects') controller.abort()
      },
    })
    await until(
      () => events.some((event) => event.type === 'start'),
      5000,
      'the watch',
    )
    await sleep(200)
    await writeFile(
      join(root, 'src', 'store.ts'),
      'load().then((rows) => setRows(rows)).catch(logError)\n',
    )
    const result = await within(watching, 10000, 'a scan')
    assert.equal(result.runs.length, 0)
    const { suspects } = events.find((event) => event.type === 'suspects')
    assert.equal(suspects[0].pattern, 'FAILURE_ONLY_LOGGED')
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
})

test('accepts only a check it can rerun the same way', async () => {
  for (const [command, message] of [
    [['start', 'web'], /reruns a check/],
    [['mcp'], /reruns a check/],
    [['ipc', '--action'], /needs --config/],
    [['ipc', '--config', 'a.json', '--out', 'x'], /Leave out --out/],
    [['observe', '--config', 'a.json', '--interactive'], /--interactive/],
  ])
    assert.throws(() => validateCheckCommand(command), message)
  validateCheckCommand(['--config', 'scenario.json'])
  validateCheckCommand(['observe', '--config', 'observe.json', '--steps', 's'])
  await assert.rejects(
    runWatch({ suspects: false }),
    /Nothing to do on a change/,
  )
  const cli = fileURLToPath(
    new URL('../../bin/recovery-probe.mjs', import.meta.url),
  )
  const failed = await promisify(execFile)(process.execPath, [
    cli,
    'watch',
    '--',
    'start',
    'web',
  ]).catch((error) => error)
  assert.equal(failed.code, 2)
  assert.match(failed.stderr, /reruns a check/)
  const help = await promisify(execFile)(process.execPath, [
    cli,
    'watch',
    '--help',
  ])
  assert.match(help.stdout, /recovery-probe watch src -- ipc --action/)
})
