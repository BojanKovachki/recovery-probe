// One agent session: its folder is prepared, the agent runs under the session's time limit,
// and its record, full transcript and final diff land in the grading folder, whatever happens.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runCommand } from '../../../dist/tools/process.mjs'
import { caseEnvironment } from './grading.mjs'
import { git, prepareSession } from './workspace.mjs'

/** The session's folder: a fresh one under the system's temporary folder. */
export const sessionFolder = (run, id) =>
  join(tmpdir(), 'rp-verifier-pilot', run, id)

/** Where a session's record lives: the grading folder, which agents are denied. */
export const recordFolder = (grading, run, id) => join(grading, 'runs', run, id)

/** The cost the agent's output reports in `field`, or 'missing': never a guessed zero. */
export async function costOf(transcript, field) {
  const text = await readFile(transcript, 'utf8').catch(() => '')
  const lines = text.trim().split('\n').reverse()
  for (const line of lines)
    try {
      const value = JSON.parse(line)?.[field]
      if (typeof value === 'number') return value
    } catch {}
  return 'missing'
}

/** `template` with each {name} replaced by its value. */
const filled = (template, values) =>
  template.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`),
  )

/** Everything the agent changed from the pilot base, untracked files included. */
async function finalDiff(workspace) {
  await git(workspace, 'add', '-A')
  const { stdout } = await git(workspace, 'diff', '--cached', 'main')
  return stdout
}

/**
 * Runs one session and returns its record. The record is written before setup starts and
 * again at the end, so a failed setup or a timeout is never lost.
 */
export async function runSession({
  session,
  testCase,
  pilot,
  grading,
  run,
  agent,
}) {
  const records = recordFolder(grading, run, session.id)
  await mkdir(records, { recursive: true })
  const record = {
    session,
    startedAt: new Date().toISOString(),
    status: 'setting-up',
  }
  const save = () =>
    writeFile(
      join(records, 'attempt.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    )
  await save()
  const folder = sessionFolder(run, session.id)
  await rm(folder, { recursive: true, force: true })
  try {
    let prepared
    try {
      prepared = await prepareSession({
        testCase,
        arm: session.arm,
        folder,
        grading,
        cli: agent.recoveryProbe,
      })
    } catch (error) {
      Object.assign(record, {
        status: 'setup-failed',
        error: error.message,
        endedAt: new Date().toISOString(),
      })
      await save()
      return record
    }
    const command = filled(pilot.agent.command, {
      ...agent.values,
      ...prepared,
    })
    const transcript = join(records, 'transcript.log')
    const started = performance.now()
    const result = await runCommand(
      command,
      prepared.workspace,
      agent.sessionMs,
      { log: transcript, env: caseEnvironment(testCase) },
    )
    await writeFile(
      join(records, 'diff.patch'),
      await finalDiff(prepared.workspace),
    )
    Object.assign(record, {
      status: result.timedOut
        ? 'timed-out'
        : result.error
          ? 'failed-to-start'
          : result.code === 0
            ? 'completed'
            : 'failed',
      exitCode: result.code,
      durationMs: Math.round(performance.now() - started),
      costUsd: await costOf(transcript, pilot.agent.costField),
      denied: prepared.denied,
      endedAt: new Date().toISOString(),
    })
    await save()
    return record
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 })
  }
}
