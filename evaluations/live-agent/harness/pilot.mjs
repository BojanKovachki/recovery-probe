// The live-agent pilot. See ../README.md.
//   node evaluations/live-agent/harness/pilot.mjs freeze  [--run NAME]
//   node evaluations/live-agent/harness/pilot.mjs run     [--run NAME] [--limit N]
//   node evaluations/live-agent/harness/pilot.mjs unseal  [--run NAME]
//   node evaluations/live-agent/harness/pilot.mjs grade   [--run NAME]
//   node evaluations/live-agent/harness/pilot.mjs smoke   [--task ID] [--condition A|B]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { claudeCli, everythingUnder } from './agent.mjs'
import { listeners, PORTS, runAttempt, unavailable } from './attempt.mjs'
import { assertFrozen, definitionHashes } from './freeze.mjs'
import { schedule } from './schedule.mjs'
import { newKey, seal, unseal } from './seal.mjs'
import { EVALUATION, HIDDEN, hiddenFromDisk, loadPilot } from './tasks.mjs'
import { subtree, writeTree } from './workspace.mjs'

const { values, positionals } = parseArgs({
  options: {
    run: { type: 'string' },
    limit: { type: 'string' },
    'keep-plaintext': { type: 'boolean' },
    task: { type: 'string' },
    condition: { type: 'string' },
  },
  allowPositionals: true,
})
const pilot = await loadPilot()
const runName = values.run ?? pilot.id
const runDirectory = join(EVALUATION, 'runs', runName)
// Outside the checkout and the workspaces: dependency templates, tools, and the run's key.
const PRIVATE = join(
  process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
  'rp-live-eval',
)
const keyFile = join(`${PRIVATE}-keys`, `${runName}.key`)
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const readKey = async () => Buffer.from(await readFile(keyFile, 'utf8'), 'hex')

function npm(args, cwd) {
  execFileSync('npm', [...args, '--no-audit', '--no-fund'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

/** Seals the hidden material, records the frozen definition and the attempt order. */
async function freeze() {
  if (existsSync(join(runDirectory, 'frozen.json')))
    throw new Error(`${runName} is already frozen`)
  const hidden = await hiddenFromDisk()
  for (const file of ['graders.json', 'scenarios.json'])
    if (!hidden[`grading/validation/${file}`])
      throw new Error(
        `Validate before freezing: grading/validation/${file} is missing`,
      )
  const key = newKey()
  await mkdir(dirname(keyFile), { recursive: true })
  await writeFile(keyFile, key.toString('hex'), { mode: 0o600 })
  await mkdir(runDirectory, { recursive: true })
  await writeFile(join(runDirectory, 'hidden.sealed'), seal(hidden, key))
  await writeFile(
    join(runDirectory, 'frozen.json'),
    json({
      at: new Date().toISOString(),
      files: await definitionHashes(hidden),
    }),
  )
  await writeFile(join(runDirectory, 'schedule.json'), json(schedule(pilot)))
  if (!values['keep-plaintext'])
    for (const folder of HIDDEN)
      await rm(join(EVALUATION, folder), { recursive: true, force: true })
  console.log(
    `Frozen ${runName}. The key is in ${keyFile}; keep it until grading.`,
  )
}

/** Installs each app's dependencies once, outside every workspace; returns the folders. */
async function appTemplates(hidden) {
  const templates = {}
  for (const app of new Set(
    Object.keys(hidden)
      .filter((path) => path.startsWith('apps/'))
      .map((path) => path.split('/')[1]),
  )) {
    const folder = join(PRIVATE, 'templates', app)
    if (!existsSync(join(folder, 'node_modules'))) {
      const files = subtree(hidden, `apps/${app}`)
      await writeTree(folder, {
        'package.json': files['package.json'],
        'package-lock.json': files['package-lock.json'],
      })
      npm(['ci'], folder)
    }
    templates[app] = join(folder, 'node_modules')
  }
  return templates
}

/** Installs condition B's Recovery Probe once, outside every workspace. */
async function recoveryProbeTools() {
  const folder = join(PRIVATE, `tools-${pilot.recoveryProbe}`)
  const installed = join(folder, 'node_modules', 'recovery-probe')
  if (!existsSync(installed)) {
    await writeTree(folder, {
      'package.json': Buffer.from('{ "private": true }\n'),
    })
    npm(
      [
        'install',
        '--save-exact',
        `recovery-probe@${pilot.recoveryProbe}`,
        `playwright@${pilot.playwright}`,
      ],
      folder,
    )
  }
  const { version } = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8'),
  )
  if (version !== pilot.recoveryProbe)
    throw new Error(`${installed} is ${version}, not ${pilot.recoveryProbe}`)
  return {
    recoveryProbeBin: join(installed, 'bin', 'recovery-probe.mjs'),
    toolsBin: join(folder, 'node_modules', '.bin'),
  }
}

/**
 * What an attempt has no business reading: this checkout (graders, other attempts' results),
 * the key, the harness's private files and Claude's own. File tools are denied them; a tool
 * call that names them is flagged.
 */
function outside() {
  const places = [resolve(EVALUATION, '..', '..'), dirname(keyFile), PRIVATE]
  return {
    deniedReads: [...places.map(everythingUnder), '~/.claude/**'],
    marks: [...places, '/.claude/'],
  }
}

/** What every attempt needs. The ports must be free, so that nothing of the user's is ended. */
async function attemptContext(hidden) {
  const busy = listeners(PORTS)
  if (busy.length)
    throw new Error(
      `Ports ${PORTS.join(' and ')} must be free; process(es) ${busy.join(', ')} listen on them`,
    )
  return {
    pilot,
    hidden,
    cli: claudeCli(pilot.agent.version),
    tools: await recoveryProbeTools(),
    nodeModules: await appTemplates(hidden),
    watched: outside(),
  }
}

/** Runs the scheduled attempts that have no sealed result yet, in order. */
async function run() {
  const key = await readKey()
  const hidden = unseal(
    await readFile(join(runDirectory, 'hidden.sealed')),
    key,
  )
  await assertFrozen(runDirectory, hidden)
  const context = await attemptContext(hidden)
  const order = JSON.parse(
    await readFile(join(runDirectory, 'schedule.json'), 'utf8'),
  )
  const limit = Number(values.limit ?? Infinity)
  let ran = 0
  for (const attempt of order) {
    const file = join(runDirectory, 'attempts', `${attempt.id}.sealed`)
    if (existsSync(file)) continue
    if (ran++ >= limit) break
    console.log(`${new Date().toISOString()} ${attempt.id}: running`)
    const { artifacts, cleanup } = await runAttempt(attempt, context)
    const record = JSON.parse(artifacts['attempt.json'])
    if (unavailable(record, artifacts)) {
      await cleanup()
      throw new Error(
        `${attempt.id}: the model service refused the session (usage limit or overload). Nothing was recorded for it; run again to resume.`,
      )
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, seal(artifacts, key))
    // A workspace that cannot be removed stops the run: no later attempt may see it.
    await cleanup()
    console.log(
      `${new Date().toISOString()} ${attempt.id}: ${record.report?.status ?? 'no report'}; exit ${record.execution.exitCode}${record.execution.timedOut ? ', timed out' : ''}; ${record.outsideReach.length} flag(s)`,
    )
  }
}

/**
 * One attempt from the plain hidden material, to check the setup before freezing: the CLI, its
 * settings, the MCP server and the final report. It is never part of a pilot; its artifacts go
 * to runs/smoke-<time>/.
 */
async function smoke() {
  const attempt = {
    task: values.task ?? 'empty-notifications',
    condition: values.condition ?? 'B',
    repetition: 1,
    order: 0,
  }
  attempt.id = `smoke-${attempt.task}-${attempt.condition}`
  const context = await attemptContext(await hiddenFromDisk())
  const { artifacts, cleanup } = await runAttempt(attempt, context)
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
  const folder = join(EVALUATION, 'runs', `smoke-${stamp}`)
  await writeTree(folder, artifacts)
  await cleanup()
  const { init, execution, report, metrics, outsideReach } = JSON.parse(
    artifacts['attempt.json'],
  )
  console.log(json({ init, execution, report, metrics, outsideReach }))
  console.log(`Artifacts: ${folder}`)
}

/** Restores the hidden material and the attempts' artifacts as plain files. */
async function unsealRun() {
  const key = await readKey()
  await writeTree(
    EVALUATION,
    unseal(await readFile(join(runDirectory, 'hidden.sealed')), key),
  )
  const folder = join(runDirectory, 'attempts')
  const names = existsSync(folder) ? await readdir(folder) : []
  for (const name of names)
    if (name.endsWith('.sealed'))
      await writeTree(
        join(folder, name.slice(0, -'.sealed'.length)),
        unseal(await readFile(join(folder, name)), key),
      )
  console.log(`Unsealed ${runName}.`)
}

const commands = {
  freeze,
  run,
  unseal: unsealRun,
  // The graders are sealed during a pilot, so they load only to grade.
  grade: async () => (await import('./grade.mjs')).gradeRun(runDirectory),
  smoke,
}
const command = commands[positionals[0]]
if (!command) {
  console.error(
    'Usage: pilot.mjs freeze|run|unseal|grade [--run NAME] [--limit N], or smoke [--task ID] [--condition A|B]',
  )
  process.exitCode = 3
} else await command()
