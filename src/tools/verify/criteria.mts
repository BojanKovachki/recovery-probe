import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isRecord } from '../../core/validate.mjs'
import { checkJsonFiles } from '../scenarios/preflight.mjs'
import { blobAt } from './git.mjs'
import type { PolicyClaim, ProjectCheck } from './policy.mjs'
import type { CriteriaChange } from './rules.mjs'
import type { Expectation } from './types.mjs'

/** The repository, where checks run from, and the two revisions criteria are read from. */
export interface Sides {
  root: string
  cwd: string
  /** The base commit. */
  base: string
  /** The candidate's snapshot tree. */
  candidate: string
}

/** A path as Git names it: relative to the repository root, with forward slashes. */
export const repoPathOf = (sides: Sides, path: string) =>
  relative(sides.root, resolve(sides.cwd, path)).split(sep).join('/')

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value

/** JSON with every object's keys sorted, so equal values hash the same. */
export const canonical = (value: unknown) =>
  JSON.stringify(sorted(value) ?? null)

export const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex')

export const versionOf = (value: unknown) =>
  `sha256:${sha256(canonical(value))}`

/** An input on one side: its committed bytes' hash, or the hash of the JSON value `file#a.b` selects. */
async function inputAt(sides: Sides, treeish: string, input: string) {
  const [path, selector] = input.split('#')
  const bytes = await blobAt(sides.root, treeish, path)
  if (!bytes || selector === undefined) return bytes && sha256(bytes)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  for (const key of selector.split('.'))
    value = isRecord(value) ? value[key] : undefined
  return value === undefined ? null : sha256(canonical(value))
}

/** Each input's hash on both sides, null where it's absent, and the inputs that differ. */
async function inputsOnBothSides(sides: Sides, inputs: string[]) {
  const base: Record<string, string | null> = {}
  const candidate: Record<string, string | null> = {}
  for (const input of inputs) {
    base[input] = await inputAt(sides, sides.base, input)
    candidate[input] = await inputAt(sides, sides.candidate, input)
  }
  return {
    base,
    candidate,
    changed: inputs.filter((input) => base[input] !== candidate[input]),
  }
}

/** The registry's entries on one side, by name; empty when it has none. */
export async function registryAt(sides: Sides, treeish: string, path: string) {
  const entries = new Map<string, Record<string, unknown>>()
  const bytes = await blobAt(sides.root, treeish, path)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes?.toString('utf8') ?? 'null')
  } catch {
    return entries
  }
  const scenarios = isRecord(parsed) ? parsed.scenarios : undefined
  for (const entry of Array.isArray(scenarios) ? scenarios : [])
    if (isRecord(entry) && typeof entry.name === 'string')
      entries.set(entry.name, entry)
  return entries
}

export interface Registries {
  path: string
  base: Map<string, Record<string, unknown>>
  candidate: Map<string, Record<string, unknown>>
}

export interface Criteria {
  change: 'present' | 'missing' | CriteriaChange
  expectation: Expectation
  /** Why the base has no expectation for the claim. */
  missing?: string
}

/** The approved version, and the candidate's where it differs, of what a claim is judged by. */
function criteriaOf(
  definition: (side: 'base' | 'candidate') => unknown,
  changedInputs: string[],
  change: CriteriaChange,
): Criteria {
  const changed = changedInputs.length > 0
  return {
    change: changed ? change : 'present',
    expectation: {
      source: 'policy',
      approved: !changed,
      approvedVersion: versionOf(definition('base')),
      ...(changed
        ? {
            candidateVersion: versionOf(definition('candidate')),
            changedInputs,
          }
        : {}),
    },
  }
}

export interface BehaviorCriteria extends Criteria {
  /** The approved scenarios' commands, and the files they read, by repository path. */
  scenarios?: { failure: string[]; normal: string[] }
  files: string[]
}

const missingCriteria = (missing: string): BehaviorCriteria => ({
  change: 'missing',
  expectation: { source: 'policy', approved: false },
  missing,
  files: [],
})

/** The JSON files the commands read, by repository path, or why a command can't run. */
function filesRead(sides: Sides, commands: string[][]): string[] | string {
  try {
    const paths = commands.flatMap((command) =>
      Object.values(checkJsonFiles(command)).map((path) =>
        repoPathOf(sides, path),
      ),
    )
    return [...new Set(paths)]
  } catch (error) {
    return `a base scenario can't run: ${(error as Error).message}`
  }
}

/** A behavior claim's criteria: its scenarios in the base registry and the files they read. */
export async function behaviorCriteria(
  sides: Sides,
  claim: PolicyClaim,
  registries: Registries,
): Promise<BehaviorCriteria> {
  const names = [claim.failurePath, claim.normalPath]
  const approved = names.map((name) => registries.base.get(name))
  const proposed = names.map((name) => registries.candidate.get(name) ?? null)
  const commands = approved.map((entry) => entry?.check)
  const absent = names.find((_, i) => !Array.isArray(commands[i]))
  if (absent)
    return missingCriteria(`${absent} has no check in the base registry`)
  const files = filesRead(sides, commands as string[][])
  if (typeof files === 'string') return missingCriteria(files)
  const inputs = await inputsOnBothSides(sides, files)
  const gone = files.find((path) => inputs.base[path] === null)
  if (gone) return missingCriteria(`${gone} isn't on the base`)
  const changedEntries = names
    .filter((_, i) => canonical(approved[i]) !== canonical(proposed[i]))
    .map((name) => `${registries.path}#${name}`)
  return {
    ...criteriaOf(
      (side) => ({
        claim,
        scenarios: side === 'base' ? approved : proposed,
        inputs: inputs[side],
      }),
      [...changedEntries, ...inputs.changed],
      'EXPECTATION_CHANGED',
    ),
    scenarios: {
      failure: commands[0] as string[],
      normal: commands[1] as string[],
    },
    files,
  }
}

/** A project check's criteria: its command, and the inputs the policy names for it. */
export async function projectCriteria(sides: Sides, check: ProjectCheck) {
  const inputs = await inputsOnBothSides(sides, check.inputs)
  return criteriaOf(
    (side) => ({ check, inputs: inputs[side] }),
    inputs.changed,
    'CHECK_INPUT_CHANGED',
  )
}

/** Writes the base's committed copy of each file under `folder`, at its repository path. */
export async function copyApproved(
  sides: Sides,
  files: string[],
  folder: string,
) {
  for (const path of files) {
    const bytes = await blobAt(sides.root, sides.base, path)
    if (!bytes) continue
    await mkdir(dirname(join(folder, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(folder, path), bytes, { mode: 0o600 })
  }
}

/** `command` reading the approved copies under `folder` instead of the candidate's files. */
export function withApprovedFiles(
  sides: Sides,
  command: string[],
  folder: string,
) {
  const options = Object.keys(checkJsonFiles(command)).map(
    (name) => `--${name}`,
  )
  const copy = (path: string) => join(folder, repoPathOf(sides, path))
  const result: string[] = []
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]
    const inline = options.find((option) => arg.startsWith(`${option}=`))
    if (inline) result.push(`${inline}=${copy(arg.slice(inline.length + 1))}`)
    else if (options.includes(arg) && i + 1 < command.length)
      result.push(arg, copy(command[++i]))
    else result.push(arg)
  }
  return result
}
