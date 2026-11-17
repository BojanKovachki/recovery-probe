// The frozen definition of a pilot: a hash of every file that decides what agents see and how
// they are graded. A pilot runs and is graded only while every hash still matches.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EVALUATION } from './tasks.mjs'
import { readTree } from './workspace.mjs'

// Visible to the harness and, where condition B uses them, to the agents.
const DEFINITION = ['tasks', 'recovery-probe', 'harness']

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

/** Hashes of the pilot's definition: the visible folders, pilot.json and the hidden tree. */
export async function definitionHashes(hidden) {
  const hashes = {}
  for (const folder of DEFINITION)
    for (const [path, content] of Object.entries(
      await readTree(join(EVALUATION, folder)),
    ))
      hashes[`${folder}/${path}`] = sha256(content)
  hashes['pilot.json'] = sha256(await readFile(join(EVALUATION, 'pilot.json')))
  for (const [path, content] of Object.entries(hidden))
    if (!path.startsWith('grading/validation/')) hashes[path] = sha256(content)
  return Object.fromEntries(Object.entries(hashes).sort())
}

/** The paths whose content differs from the frozen hashes, or that were added or removed. */
export function changedSince(frozen, current) {
  const paths = new Set([...Object.keys(frozen), ...Object.keys(current)])
  return [...paths].filter((path) => frozen[path] !== current[path]).sort()
}

/** Throws unless the pilot's definition still matches what `runDirectory` froze. */
export async function assertFrozen(runDirectory, hidden) {
  const frozen = JSON.parse(
    await readFile(join(runDirectory, 'frozen.json'), 'utf8'),
  )
  const changed = changedSince(frozen.files, await definitionHashes(hidden))
  if (changed.length)
    throw new Error(
      `The pilot changed since it was frozen (${changed.length} file(s)): ${changed.slice(0, 8).join(', ')}`,
    )
}
