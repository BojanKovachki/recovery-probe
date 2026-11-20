import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTree, startTree, subtree } from './workspace.mjs'

export const EVALUATION = fileURLToPath(new URL('..', import.meta.url))

// The reference apps and the grading material: kept from the agents, sealed during a pilot.
export const HIDDEN = ['apps', 'grading']

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export const loadPilot = () => readJson(join(EVALUATION, 'pilot.json'))

/** A task as the agents see it: its app, its issue and the files that make its starting code. */
export async function loadTask(id) {
  const directory = join(EVALUATION, 'tasks', id)
  const start = join(directory, 'start')
  return {
    ...(await readJson(join(directory, 'task.json'))),
    issue: await readFile(join(directory, 'ISSUE.md')),
    overlay: existsSync(start) ? await readTree(start) : {},
  }
}

/** The prepared Recovery Probe registry and check configurations of an app (condition B). */
export const scenarioFiles = (app) =>
  readTree(join(EVALUATION, 'recovery-probe', app))

/** The hidden material from disk, before it is sealed or after it is unsealed. */
export async function hiddenFromDisk() {
  const tree = {}
  for (const folder of HIDDEN)
    for (const [path, content] of Object.entries(
      await readTree(join(EVALUATION, folder)),
    ))
      tree[`${folder}/${path}`] = content
  return tree
}

export const gradingRules = (hidden) =>
  JSON.parse(hidden['grading/rules.json'].toString('utf8'))

/** The tree an attempt starts from; without the overlay it is the reference build. */
export function attemptStart(task, condition, hidden, scenarios = {}) {
  return startTree({
    app: subtree(hidden, `apps/${task.app}`),
    overlay: task.overlay,
    issue: task.issue,
    extra: condition === 'B' ? scenarios : {},
  })
}
