// The verifier pilot's harness. See ../PROTOCOL.md and ../README.md.
//   node evaluations/verifier-pilot/harness/pilot.mjs plan --grading DIR
//   node evaluations/verifier-pilot/harness/pilot.mjs phase1 --grading DIR --run NAME
//   node evaluations/verifier-pilot/harness/pilot.mjs run --grading DIR --run NAME --cli PATH --model NAME [--limit N]
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { recordFolder, runSession } from './attempt.mjs'
import {
  approvalFor,
  gradingFolder,
  readCases,
  repository,
} from './grading.mjs'
import { runPhase1 } from './phase1.mjs'
import { schedule } from './schedule.mjs'

export const CLI = join(repository, 'bin', 'recovery-probe.mjs')
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
export const defaultPilot = () =>
  readJson(join(repository, 'evaluations', 'verifier-pilot', 'pilot.json'))

/** The cases and the seeded order of every session. */
export async function plan({ grading, pilot }) {
  const cases = await readCases(grading)
  const sessions = schedule(
    cases.map((c) => c.id),
    pilot.repetitions,
    pilot.seed,
  )
  return { cases, sessions }
}

/** Phase 1, recorded in `<grading>/runs/<run>/phase1.json`. */
export async function phase1({ grading, run }) {
  const results = await runPhase1({
    cases: await readCases(grading),
    grading,
    run,
    cli: CLI,
  })
  await mkdir(join(grading, 'runs', run), { recursive: true })
  await writeFile(
    join(grading, 'runs', run, 'phase1.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  )
  return results
}

/** The approved budget left, or why no more can be spent: a missing cost can't be tracked. */
async function spending(grading, run, sessions, budgetUsd) {
  let spent = 0
  for (const session of sessions) {
    const file = join(recordFolder(grading, run, session.id), 'attempt.json')
    if (!existsSync(file)) continue
    const { costUsd, status } = await readJson(file)
    if (status === 'setup-failed') continue
    if (typeof costUsd !== 'number')
      return {
        stop: `session ${session.id}'s cost is missing, so spending can't be tracked`,
      }
    spent += costUsd
  }
  return spent >= budgetUsd
    ? { stop: `the approved budget, US$${budgetUsd}, is spent` }
    : { spent }
}

const finished = async (grading, run, session) => {
  const file = join(recordFolder(grading, run, session.id), 'attempt.json')
  return existsSync(file) && (await readJson(file)).status !== 'setting-up'
}

/**
 * Runs the agent sessions not yet recorded, in order. Refuses without the owner's approval or
 * before phase 1 passed, and stops at the approved budget.
 * @param {{ grading: string, run: string, pilot: any, values: Record<string, string>,
 *   limit?: number, sessionMs?: number }} options
 */
export async function runPilot({
  grading,
  run,
  pilot,
  values,
  limit = Infinity,
  sessionMs,
}) {
  const { cases, sessions } = await plan({ grading, pilot })
  const approval = await approvalFor(grading, cases, pilot.budgetUsd)
  const gate = join(grading, 'runs', run, 'phase1.json')
  if (
    !existsSync(gate) ||
    !(await readJson(gate)).every((result) => result.passed)
  )
    throw new Error(
      'Phase 1 must pass before any agent runs: run phase1 and resolve what fails',
    )
  const records = []
  for (const session of sessions) {
    if (records.length >= limit) break
    if (await finished(grading, run, session)) continue
    const budget = await spending(grading, run, sessions, approval.budgetUsd)
    if (budget.stop) return { records, stopped: budget.stop }
    const testCase = cases.find((c) => c.id === session.case)
    const agent = {
      values,
      recoveryProbe: CLI,
      sessionMs: sessionMs ?? pilot.sessionMinutes * 60000,
    }
    records.push(
      await runSession({ session, testCase, pilot, grading, run, agent }),
    )
  }
  return { records }
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      grading: { type: 'string' },
      run: { type: 'string' },
      cli: { type: 'string' },
      model: { type: 'string' },
      limit: { type: 'string' },
    },
  })
  const grading = gradingFolder(values.grading)
  const pilot = await defaultPilot()
  if (positionals[0] === 'plan') {
    const { cases, sessions } = await plan({ grading, pilot })
    console.log(
      `${cases.length} cases, ${sessions.length} sessions, ceiling US$${pilot.budgetUsd}`,
    )
    for (const session of sessions) console.log(`  ${session.id}`)
    return
  }
  if (!values.run) throw new Error('Name the run: --run NAME')
  if (positionals[0] === 'phase1') {
    const results = await phase1({ grading, run: values.run })
    for (const result of results)
      console.log(
        `${result.passed ? 'PASS' : 'FAIL'}  ${result.case} ${result.patch ?? ''}`,
      )
    process.exitCode = results.every((result) => result.passed) ? 0 : 1
    return
  }
  if (positionals[0] !== 'run') throw new Error('Commands: plan, phase1, run')
  if (!values.cli || !values.model)
    throw new Error('run needs --cli PATH and --model NAME')
  const result = await runPilot({
    grading,
    run: values.run,
    pilot,
    values: { cli: values.cli, model: values.model },
    limit: values.limit ? Number(values.limit) : Infinity,
  })
  for (const record of result.records)
    console.log(`${record.status.padEnd(14)} ${record.session.id}`)
  if (result.stopped) console.log(`Stopped: ${result.stopped}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
