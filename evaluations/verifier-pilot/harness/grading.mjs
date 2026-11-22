// The private grading folder: cases, expected outcomes, the owner's approval and every
// session's record. Agents never get it; the harness refuses it inside this repository.
import { existsSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This repository's checkout. */
export const repository = realpathSync(
  fileURLToPath(new URL('../../../', import.meta.url)),
)

export const CASE_TYPES = [
  'tests-catch',
  'failure-handling',
  'intended-change',
  'missing-expectation',
  'outside-claims',
  'base-fails',
]

/** Whether `path` is `folder` or inside it. */
export function isInside(path, folder) {
  const rel = relative(resolve(folder), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The grading folder at `path`, refused inside this repository or around it. */
export function gradingFolder(path) {
  if (!path) throw new Error('Name the private grading folder: --grading DIR')
  const folder = realpathSync(resolve(path))
  if (isInside(folder, repository) || isInside(repository, folder))
    throw new Error(
      'The grading folder must be outside this repository, so expected outcomes never travel with the code',
    )
  return folder
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

/** Why a case can't be used, or undefined. */
function caseProblem(folder, data) {
  if (!CASE_TYPES.includes(data.type))
    return `type must be one of ${CASE_TYPES.join(', ')}`
  for (const key of ['repository', 'buggyCommit', 'fixCommit'])
    if (typeof data[key] !== 'string' || !data[key]) return `${key} is required`
  for (const file of [
    'ISSUE.md',
    'arm-a.md',
    'policy/recovery-probe.policy.json',
  ])
    if (!existsSync(join(folder, file))) return `${file} is missing`
  return undefined
}

/**
 * @typedef {{ id: string, folder: string, type: string, repository: string,
 *   buggyCommit: string, fixCommit: string, expected?: unknown }} PilotCase
 */

/**
 * Every case in `<grading>/cases`, each checked.
 * @returns {Promise<PilotCase[]>}
 */
export async function readCases(grading) {
  const root = join(grading, 'cases')
  const ids = existsSync(root) ? (await readdir(root)).sort() : []
  const cases = []
  for (const id of ids) {
    const folder = join(root, id)
    const data = await readJson(join(folder, 'case.json'))
    const problem = caseProblem(folder, data)
    if (problem) throw new Error(`Case ${id}: ${problem}`)
    cases.push({ ...data, id, folder })
  }
  return cases
}

/** The owner's approval of every case and of a budget within the ceiling, which agent runs need. */
export async function approvalFor(grading, cases, ceilingUsd) {
  const file = join(grading, 'approval.json')
  if (!existsSync(file))
    throw new Error(
      'No approval: the owner approves the cases and the budget in approval.json before any agent run',
    )
  const approval = await readJson(file)
  const approved = Array.isArray(approval.cases) ? approval.cases : []
  const missing = cases.filter((testCase) => !approved.includes(testCase.id))
  if (missing.length)
    throw new Error(
      `Not approved: ${missing.map((testCase) => testCase.id).join(', ')}`,
    )
  if (!(approval.budgetUsd > 0) || approval.budgetUsd > ceilingUsd)
    throw new Error(
      `The approved budget must be above 0 and at most the ceiling, US$${ceilingUsd}`,
    )
  return approval
}
