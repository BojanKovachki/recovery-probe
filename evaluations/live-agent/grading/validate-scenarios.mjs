// Validates condition B's prepared scenarios before the pilot is frozen: `self-check --run`
// on each task's starting code and on the reference builds. A scenario should come out
// `findings` on the build with its defect and `clean` everywhere else. Writes
// validation/scenarios.json. Uses the Recovery Probe of this checkout; ports 4173 and 9222 must be free.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attemptStart,
  EVALUATION,
  gradingRules,
  hiddenFromDisk,
  loadTask,
  scenarioFiles,
} from '../harness/tasks.mjs'
import { killTree } from '../harness/agent.mjs'
import { freePorts, listeners, PORTS } from '../harness/attempt.mjs'
import { writeTree } from '../harness/workspace.mjs'
import { until } from './wait.mjs'

const REPO = join(EVALUATION, '..', '..')
const CLI = join(REPO, 'bin', 'recovery-probe.mjs')
const RUNS = Number(process.argv[2] ?? 3)

const answers = async (url) => {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

function start(script, directory) {
  return spawn(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, PORT: '4173' },
    stdio: 'ignore',
    windowsHide: true,
  })
}

function selfCheck(directory, reference) {
  return new Promise((resolve, reject) => {
    const args = ['self-check', '--run', '--reference', reference]
    const child = spawn(
      process.execPath,
      [CLI, ...args, '--runs', String(RUNS), '--json'],
      { cwd: directory, windowsHide: true },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', () => resolve(JSON.parse(output)))
  })
}

/** Serves `tree` on port 4173 (and, for observe, a browser on 9222) and self-checks it. */
async function validate(tree, app, reference) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-live-scenarios-'))
  const processes = []
  try {
    await writeTree(directory, tree)
    await symlink(
      join(REPO, 'node_modules'),
      join(directory, 'node_modules'),
      'junction',
    )
    processes.push(start(join(directory, 'server.mjs'), directory))
    await until(() => answers('http://127.0.0.1:4173/'), 10000, 'the app')
    if (app === 'dispatch') {
      processes.push(
        start(join(directory, 'checks', 'open-browser.mjs'), directory),
      )
      await until(
        async () =>
          (await (await fetch('http://127.0.0.1:9222/json/list')).json()).some(
            (target) => target.url.startsWith('http://127.0.0.1:4173/'),
          ),
        20000,
        'the app open in the browser',
      )
    }
    const report = await selfCheck(directory, reference)
    return Object.fromEntries(
      report.scenarios.map((scenario) => [
        scenario.name,
        {
          outcome: scenario.outcome,
          problems: [
            ...new Set(
              scenario.runs.flatMap((run) => run.problems.map((p) => p.code)),
            ),
          ],
          gaps: [...new Set(scenario.runs.flatMap((run) => run.gaps))],
        },
      ]),
    )
  } finally {
    // The helper's Chromium outlives a killed Node process on Windows: end whole trees.
    for (const child of processes) killTree(child.pid)
    freePorts()
    await until(async () => !listeners(PORTS).length, 10000, 'free ports')
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}

const hidden = await hiddenFromDisk()
const rules = gradingRules(hidden)
const results = {}
for (const [id, rule] of Object.entries(rules.tasks)) {
  const task = await loadTask(id)
  const scenarios = await scenarioFiles(task.app)
  const builds = Object.keys(task.overlay).length
    ? [
        ['start', task],
        ['reference', { ...task, overlay: {} }],
      ]
    : [['start (the reference: no defect)', task]]
  for (const [build, variant] of builds) {
    const key = `${id} / ${build}`
    results[key] = await validate(
      attemptStart(variant, 'B', hidden, scenarios),
      rule.app,
      `${id} ${build}`,
    )
    console.log(key)
    for (const [name, result] of Object.entries(results[key]))
      console.log(
        `  ${name}: ${result.outcome} ${result.problems.join(', ')} ${result.gaps.join(', ')}`,
      )
  }
}
await mkdir(join(EVALUATION, 'grading', 'validation'), { recursive: true })
await writeFile(
  join(EVALUATION, 'grading', 'validation', 'scenarios.json'),
  `${JSON.stringify({ at: new Date().toISOString(), runs: RUNS, results }, null, 2)}\n`,
)
