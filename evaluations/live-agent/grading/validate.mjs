// Validates the graders before the pilot is frozen: on each task's starting code the required
// checks must fail (pass, for the control and the clarification task) and every regression
// check pass; on the reference build every check must pass. Repeats each run to expose flaky
// checks, and runs the app's own tests on the starting code. Writes validation/graders.json.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attemptStart,
  EVALUATION,
  gradingRules,
  hiddenFromDisk,
  loadTask,
} from '../harness/tasks.mjs'
import { writeTree } from '../harness/workspace.mjs'
import { runChecks } from './run-checks.mjs'

const ROUNDS = Number(process.argv[2] ?? 3)

const failing = (results) =>
  Object.entries(results)
    .filter(([, result]) => !result.pass)
    .map(([name, result]) => `${name}: ${result.detail}`)

function appTests(directory) {
  try {
    execFileSync(process.execPath, ['--test', 'test/*.test.js'], {
      cwd: directory,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

async function check(rule, tree, build) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-live-validate-'))
  try {
    await writeTree(directory, tree)
    const rounds = []
    for (let round = 0; round < ROUNDS; round++) {
      const { required, regression } = await runChecks(directory, rule)
      const requiredFailing = failing(required)
      const fixTask = rule.kind === 'fix' && build === 'start'
      rounds.push({
        requiredFailing,
        regressionFailing: failing(regression),
        asExpected:
          (fixTask
            ? requiredFailing.length === Object.keys(required).length
            : requiredFailing.length === 0) && !failing(regression).length,
      })
    }
    return { build, appTestsPass: appTests(directory), rounds }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}

const hidden = await hiddenFromDisk()
const rules = gradingRules(hidden)
const results = {}
for (const [id, rule] of Object.entries(rules.tasks)) {
  const task = await loadTask(id)
  results[id] = []
  for (const [build, tree] of [
    ['start', attemptStart(task, 'A', hidden)],
    ['reference', attemptStart({ ...task, overlay: {} }, 'A', hidden)],
  ]) {
    const result = await check(rule, tree, build)
    results[id].push(result)
    const ok = result.rounds.every((round) => round.asExpected)
    console.log(
      `${ok ? 'OK  ' : 'BAD '} ${id} ${build}: tests ${result.appTestsPass ? 'pass' : 'FAIL'}; ${result.rounds
        .map(
          (round) =>
            [...round.requiredFailing, ...round.regressionFailing].length,
        )
        .join('/')} failing check(s) per round`,
    )
    if (!ok)
      for (const round of result.rounds)
        console.log(`     ${JSON.stringify(round)}`)
  }
}
await mkdir(join(EVALUATION, 'grading', 'validation'), { recursive: true })
await writeFile(
  join(EVALUATION, 'grading', 'validation', 'graders.json'),
  `${JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, results }, null, 2)}\n`,
)
