import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { version } from '../../dist/core/package.mjs'
import { startNode, untilExit } from '../../dist/tools/process.mjs'
import { runCheck, runRecoveryProbe } from '../../dist/tools/watch/checks.mjs'
import { hangingCheck } from '../helpers/hanging-check.mjs'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)
const acceptStopRequests = `import { acceptStopRequests } from ${JSON.stringify(
  new URL('../../dist/cli/until-stopped.mjs', import.meta.url).href,
)}
acceptStopRequests()
`

/** Starts `source` as a Node script and collects what it prints. */
async function script(t, source) {
  const folder = await mkdtemp(join(tmpdir(), 'recovery-probe-runs-'))
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5 }))
  const file = join(folder, 'command.mjs')
  await writeFile(file, source)
  const child = startNode(file, [])
  const run = { child, output: '' }
  child.stdout.on('data', (chunk) => (run.output += chunk))
  child.stderr.on('data', (chunk) => (run.output += chunk))
  return run
}

/** Resolves once `run` has printed `text`. */
async function printed(run, text) {
  while (!run.output.includes(text)) await sleep(20)
}

const alive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

/** Whether `pid` is gone within two seconds; an ended process can take a moment to go. */
async function gone(pid) {
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100)
  return !alive(pid)
}

test('a timeout ends the command and the processes it started, keeping its output', async (t) => {
  // On Windows a child that isn't detached dies with its parent anyway, so only a
  // detached one shows the tree is ended. Elsewhere detaching leaves the process group.
  const run = await script(
    t,
    `import { spawn } from 'node:child_process'
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: process.platform === 'win32',
})
console.log('grandchild', grandchild.pid)
setInterval(() => {}, 1000)
`,
  )
  const exit = await untilExit(run.child, { timeoutMs: 1500, graceMs: 200 })
  assert.equal(exit.stopped, 'timed-out')
  const grandchild = Number(/grandchild (\d+)/.exec(run.output)?.[1])
  assert.ok(grandchild > 0, run.output)
  assert.ok(await gone(/** @type {number} */ (run.child.pid)))
  assert.ok(await gone(grandchild), 'the grandchild is gone too')
})

test('a command that handles a stop request cleans up before it exits', async (t) => {
  const run = await script(
    t,
    `${acceptStopRequests}const timer = setInterval(() => {}, 1000)
process.on('SIGTERM', () => {
  console.log('cleaned up')
  clearInterval(timer)
})
console.log('ready')
`,
  )
  const abort = new AbortController()
  const exiting = untilExit(run.child, { signal: abort.signal, graceMs: 60000 })
  await printed(run, 'ready')
  abort.abort()
  const exit = await exiting
  assert.equal(exit.stopped, 'cancelled')
  assert.equal(exit.exitCode, 0, 'it exited on its own')
  assert.match(run.output, /cleaned up/)
})

test('a command that can not stop on its own is ended at once, without the grace period', async (t) => {
  const run = await script(
    t,
    `${acceptStopRequests}setInterval(() => {}, 1000)
console.log('ready')
`,
  )
  const abort = new AbortController()
  const exiting = untilExit(run.child, { signal: abort.signal, graceMs: 60000 })
  await printed(run, 'ready')
  const stoppedAt = Date.now()
  abort.abort()
  const exit = await exiting
  assert.equal(exit.stopped, 'cancelled')
  assert.ok(Date.now() - stoppedAt < 10000)
})

test(
  'the stop channel never keeps a finished command running',
  { timeout: 20000 },
  async (t) => {
    const run = await script(t, `${acceptStopRequests}console.log('done')\n`)
    const exit = await untilExit(run.child, { timeoutMs: 60000 })
    assert.deepEqual(exit, { exitCode: 0, killedBy: null })
    assert.equal(run.output, 'done\n')
    const real = await runRecoveryProbe(['--version'])
    assert.deepEqual(real, { exitCode: 0, output: `${version}\n` })
  },
)

test('a run that ended before its report keeps its partial report as incomplete evidence', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'recovery-probe-runs-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const evidence = {
    schema: 'recovery-probe/evidence@1',
    workflow: 'discover',
    complete: false,
    gaps: ['BUDGET_EXHAUSTED', 'RUN_IN_PROGRESS'],
    problems: [
      { code: 'CONTENT_LOSS', scope: 'rejection-1', severity: 'lead' },
    ],
    outcomes: [],
    checked: [],
  }
  const limits = { signal: new AbortController().signal, timeoutMs: 1000 }
  /** @type {unknown[]} */
  const received = []
  const stopped = await runCheck(
    ['discover', '--config', 'd.json'],
    join(folder, 'stopped'),
    async (args, given) => {
      received.push(given)
      const out = args[args.indexOf('--out') + 1]
      await mkdir(out, { recursive: true })
      await writeFile(
        join(out, 'report.partial.json'),
        JSON.stringify({ evidence }),
      )
      return { exitCode: null, output: 'started\n', stopped: 'timed-out' }
    },
    limits,
  )
  assert.equal(received[0], limits)
  assert.equal(stopped.stopped, 'timed-out')
  assert.match(String(stopped.report), /report\.partial\.json$/)
  assert.equal(stopped.evidence?.complete, false)
  assert.deepEqual(stopped.evidence?.gaps, [
    'BUDGET_EXHAUSTED',
    'PROCESS_STOPPED',
  ])
  assert.deepEqual(stopped.evidence?.problems, evidence.problems)

  const finished = await runCheck(
    ['discover', '--config', 'd.json'],
    join(folder, 'finished'),
    async (args) => {
      const out = args[args.indexOf('--out') + 1]
      await mkdir(out, { recursive: true })
      for (const name of ['report.partial.json', 'report.json'])
        await writeFile(
          join(out, name),
          JSON.stringify({
            evidence: { ...evidence, complete: true, gaps: [] },
          }),
        )
      return { exitCode: 0, output: '' }
    },
  )
  assert.match(String(finished.report), /report\.json$/)
  assert.equal(finished.evidence?.complete, true)
  assert.equal('stopped' in finished, false)
})

test('stopping verify stops the check it runs, and verify says nothing was recorded', async (t) => {
  const hanging = await hangingCheck()
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-runs-'))
  t.after(async () => {
    await hanging.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await mkdir(join(root, '.recovery-probe'))
  await writeFile(join(root, 'hang.json'), hanging.config)
  await writeFile(
    join(root, '.recovery-probe', 'verify.json'),
    JSON.stringify({
      runs: 2,
      checks: [{ name: 'hang', command: ['check', '--config', 'hang.json'] }],
    }),
  )
  const previous = process.cwd()
  process.chdir(root)
  const verify = startNode(cli, ['verify', '--baseline'])
  process.chdir(previous)
  let output = ''
  verify.stdout.on('data', (chunk) => (output += chunk))
  verify.stderr.on('data', (chunk) => (output += chunk))
  const abort = new AbortController()
  const exiting = untilExit(verify, { signal: abort.signal, graceMs: 60000 })
  await hanging.connected
  abort.abort()
  const exit = await exiting
  await hanging.closed
  assert.equal(exit.exitCode, 2, output)
  assert.match(output, /Stopping: the check in progress gets 10 s/)
  assert.match(output, /Stopped before the baseline was recorded/)
  assert.doesNotMatch(output, /run 2/, 'no run starts after the stop')
})

// On Windows a child that isn't detached dies with its parent anyway; elsewhere the
// command runs in its own process group, and only the closed channel tells it to stop.
test('a command whose parent is gone stops as an unhandled SIGTERM would', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'recovery-probe-runs-'))
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5 }))
  const command = join(folder, 'command.mjs')
  await writeFile(
    command,
    `${acceptStopRequests}setInterval(() => {}, 1000)\nconsole.log('ready')\n`,
  )
  const parent = await script(
    t,
    `import { startNode } from ${JSON.stringify(
      new URL('../../dist/tools/process.mjs', import.meta.url).href,
    )}
const child = startNode(${JSON.stringify(command)}, [])
child.stdout.pipe(process.stdout)
console.log('child', child.pid)
setInterval(() => {}, 1000)
`,
  )
  await printed(parent, 'ready')
  const child = Number(/child (\d+)/.exec(parent.output)?.[1])
  parent.child.kill('SIGKILL')
  assert.ok(await gone(child), 'the command stopped when its parent went')
})
