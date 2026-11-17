import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerifyCheck, VerifyPlan } from '../verify.mjs'
import type { ChangedFile } from './changes.mjs'

/** What the planner can tell about a recorded verify baseline. It can't tell which code it ran. */
export interface BaselineStatus {
  recorded: boolean
  /** When it was recorded. */
  at?: string
  /** Planned checks the baseline has no runs of, or ran with another command. */
  missing: string[]
  /** Changed files last modified before the baseline was recorded: it may include the change. */
  changedBefore: string[]
  advice: string
}

const command = (check: VerifyCheck) => JSON.stringify(check.command)

/** How to get a baseline when the working tree already holds the change. */
const fromBaseCheckout = (ref: string) =>
  `This working tree already holds the change, so a baseline run here would test the changed code. Check out ${ref} separately (git worktree add --detach ../before ${ref}), build and start that version of the app, and run recovery-probe verify --baseline --plan PLAN --out FOLDER from it. Then start this version and run recovery-probe verify --plan PLAN --out FOLDER here.`

/** Changed files whose modification time is before `at`. */
async function modifiedBefore(
  root: string,
  changes: ChangedFile[],
  at: string,
) {
  const before: string[] = []
  for (const change of changes) {
    if (change.status === 'deleted') continue
    const modified = await stat(join(root, change.path)).then(
      (s) => s.mtimeMs,
      () => Infinity,
    )
    if (modified < Date.parse(at)) before.push(change.path)
  }
  return before
}

/** The baseline verify keeps in `directory`, compared with the candidate plan and the change. */
export async function baselineStatus(
  directory: string,
  {
    root,
    ref,
    plan,
    changes,
  }: {
    root: string
    ref: string
    plan: VerifyPlan | null
    changes: ChangedFile[]
  },
): Promise<BaselineStatus> {
  const file = join(directory, 'before', 'baseline.json')
  if (!existsSync(file))
    return {
      recorded: false,
      missing: plan?.checks.map((check) => check.name) ?? [],
      changedBefore: [],
      advice: !plan
        ? 'No baseline, and no checks to record one for.'
        : changes.length
          ? `No baseline. ${fromBaseCheckout(ref)}`
          : 'No baseline. Record it with recovery-probe verify --baseline before changing the code.',
    }
  const baseline = JSON.parse(await readFile(file, 'utf8')) as {
    at: string
    checks: VerifyCheck[]
  }
  const recorded = new Set(baseline.checks.map(command))
  const missing = (plan?.checks ?? [])
    .filter((check) => !recorded.has(command(check)))
    .map((check) => check.name)
  const changedBefore = await modifiedBefore(root, changes, baseline.at)
  const advice = missing.length
    ? `The baseline from ${baseline.at} has no runs of ${missing.join(', ')}: record it again from the version before the change.`
    : changedBefore.length
      ? `${changedBefore.join(', ')} changed before the baseline was recorded at ${baseline.at}, so the baseline may already include the change. ${fromBaseCheckout(ref)}`
      : `A baseline from ${baseline.at} covers these checks. Recovery Probe cannot tell which code it ran against: it counts only if it ran before the change.`
  return { recorded: true, at: baseline.at, missing, changedBefore, advice }
}
