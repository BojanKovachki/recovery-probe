import { readFile } from 'node:fs/promises'
import { isNonEmptyString, isRecord } from '../../core/validate.mjs'
import { preflightCheck, type Preflight } from '../scenarios/preflight.mjs'
import { PlanInputError } from './changes.mjs'
import { safeRelativePath } from './paths.mjs'

/** A scenario the team registered for some source files, or an open question about them. */
export interface RegistryEntry {
  name: string
  /** Repository-relative file patterns: `*` within a folder, `**` across folders. */
  paths: string[]
  /** An existing Recovery Probe check, as a verify plan lists it; kept when the entry has a problem. */
  check?: string[]
  /** What the check shows. */
  behavior?: string
  /** The expected behavior and where it comes from, such as a requirement. */
  expectation?: string
  /** What the check does not cover. */
  limits?: string
  /** An open question about how these files should behave. */
  question?: string
  /** Why the entry can't be used; its paths still say which changes it concerns. */
  problem?: string
  /** The static preflight of the check of a well-formed entry. */
  preflight?: Preflight
}

export interface Registry {
  /** As given, relative to the working directory. */
  path: string
  entries: RegistryEntry[]
  /** Entries too malformed to say which files they concern, with their name when they have one. */
  unusable: { index: number; name?: string; message: string }[]
}

export const DEFAULT_REGISTRY = 'recovery-probe.registry.json'

const NAME = /^[\w.-]{1,40}$/
const KEYS = [
  'name',
  'paths',
  'check',
  'behavior',
  'expectation',
  'limits',
  'question',
]
const TEXTS = ['behavior', 'expectation', 'limits', 'question'] as const

/** Why a check can't run as registered, from its static preflight, or undefined. */
const problemOf = ({ errors, unresolved }: Preflight) => {
  const problems = [
    ...errors,
    ...unresolved.map((value) => `unresolved ${value}`),
  ]
  return problems.length ? problems.join('; ') : undefined
}

const isArguments = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((arg) => typeof arg === 'string')

/** Why the entry's check fields are malformed, or undefined. */
function checkFields(entry: Record<string, unknown>): string | undefined {
  if (entry.check === undefined)
    return entry.question === undefined
      ? 'needs a check, a question, or both'
      : undefined
  if (!isArguments(entry.check))
    return 'check must be a list of Recovery Probe arguments'
  if (entry.behavior === undefined)
    return 'a check needs a behavior: what it shows'
  return undefined
}

/** The entry's own fields, or why they are malformed. */
function entryFields(entry: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(entry).find((key) => !KEYS.includes(key))
  if (unknown) return `unsupported field: ${unknown}`
  const text = TEXTS.find(
    (key) =>
      entry[key] !== undefined &&
      !(isNonEmptyString(entry[key]) && entry[key].length <= 500),
  )
  if (text) return `${text} must be text of 1–500 characters`
  return checkFields(entry)
}

/** The entry's name and paths, which say which changes it concerns, or why they are unusable. */
function identity(entry: unknown, names: Set<string>) {
  if (!isRecord(entry)) return 'must be an object'
  const { name, paths } = entry
  if (typeof name !== 'string' || !NAME.test(name))
    return `name must match ${NAME}`
  if (names.has(name)) return `the name ${name} is used twice`
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 50 ||
    paths.some((path) => typeof path !== 'string')
  )
    return 'paths must list 1–50 file patterns'
  const unsafe = paths.find((path) => !safeRelativePath(path))
  if (unsafe) return `${unsafe} is not a relative path inside the project`
  return undefined
}

async function readEntry(
  root: string,
  entry: Record<string, unknown>,
): Promise<RegistryEntry> {
  const fields: RegistryEntry = {
    name: entry.name as string,
    paths: (entry.paths as string[]).map((path) => safeRelativePath(path)!),
    ...(isArguments(entry.check) ? { check: entry.check } : {}),
  }
  const malformed = entryFields(entry)
  if (malformed) return { ...fields, problem: malformed }
  for (const key of TEXTS)
    if (entry[key] !== undefined) Object.assign(fields, { [key]: entry[key] })
  if (!fields.check) return fields
  const preflight = await preflightCheck(root, fields.check)
  const problem = problemOf(preflight)
  return { ...fields, preflight, ...(problem ? { problem } : {}) }
}

/**
 * Reads the registry. A malformed file stops planning; a malformed entry is reported, and
 * check files are resolved against `root`, the directory verify runs the checks from.
 */
export async function readRegistry(
  path: string,
  root: string,
): Promise<Registry> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new PlanInputError(
      `Cannot read the registry ${path}: ${(error as Error).message}`,
    )
  }
  if (
    !isRecord(input) ||
    !Array.isArray(input.scenarios) ||
    input.scenarios.length > 200
  )
    throw new PlanInputError(
      `The registry ${path} must be { "scenarios": [ ... ] } with at most 200 entries`,
    )
  const registry: Registry = { path, entries: [], unusable: [] }
  const names = new Set<string>()
  for (const [index, entry] of input.scenarios.entries()) {
    const message = identity(entry, names)
    if (message) {
      const name = isRecord(entry) ? entry.name : undefined
      registry.unusable.push({
        index,
        ...(typeof name === 'string' ? { name } : {}),
        message,
      })
    } else {
      names.add((entry as { name: string }).name)
      registry.entries.push(
        await readEntry(root, entry as Record<string, unknown>),
      )
    }
  }
  return registry
}
