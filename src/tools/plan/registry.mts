import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { isNonEmptyString, isRecord } from '../../core/validate.mjs'
import { validateCheckCommand } from '../watch/checks.mjs'
import { PlanInputError } from './changes.mjs'

/** A scenario the team registered for some source files, or an open question about them. */
export interface RegistryEntry {
  name: string
  /** Repository-relative file patterns: `*` within a folder, `**` across folders. */
  paths: string[]
  /** An existing Recovery Probe check, as a verify plan lists it. */
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
}

export interface Registry {
  /** As given, relative to the working directory. */
  path: string
  entries: RegistryEntry[]
  /** Entries too malformed to say which files they concern. */
  unusable: { index: number; message: string }[]
}

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
// Check arguments that name a file or folder the check reads.
const PATH_FLAGS = ['--config', '--steps', '--state', '--files']

/** A registry path as a safe relative path with forward slashes, or undefined when it is not one. */
export function safeRelativePath(value: string): string | undefined {
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = path.split('/')
  if (
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    parts.some((part) => part === '' || part === '..')
  )
    return undefined
  return path
}

/** Why `path` is not a file or folder inside `root`, following symlinks; undefined when it is. */
async function outsideProblem(root: string, path: string) {
  const safe = safeRelativePath(path)
  if (!safe) return `${path} is not a relative path inside the project`
  const target = join(root, safe)
  if (!existsSync(target)) return `${path} does not exist`
  const inside = relative(await realpath(root), await realpath(target))
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    return `${path} leads outside the project`
  return undefined
}

/** Why a check's command can't run as registered, or undefined. */
async function checkProblem(root: string, check: string[]) {
  try {
    validateCheckCommand(check)
  } catch (error) {
    return (error as Error).message
  }
  for (const [i, arg] of check.entries()) {
    if (!PATH_FLAGS.includes(arg)) continue
    const problem = await outsideProblem(root, check[i + 1] ?? '')
    if (problem) return problem
    if (arg === '--files') continue
    try {
      JSON.parse(await readFile(join(root, check[i + 1]), 'utf8'))
    } catch {
      return `${check[i + 1]} is not valid JSON`
    }
  }
  return undefined
}

/** Why the entry's check fields are malformed, or undefined. */
function checkFields(entry: Record<string, unknown>): string | undefined {
  if (entry.check === undefined)
    return entry.question === undefined
      ? 'needs a check, a question, or both'
      : undefined
  if (
    !Array.isArray(entry.check) ||
    !entry.check.every((arg) => typeof arg === 'string')
  )
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
  }
  const problem =
    entryFields(entry) ??
    (entry.check
      ? await checkProblem(root, entry.check as string[])
      : undefined)
  if (problem) return { ...fields, problem }
  for (const key of ['check', ...TEXTS] as const)
    if (entry[key] !== undefined) Object.assign(fields, { [key]: entry[key] })
  return fields
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
    if (message) registry.unusable.push({ index, message })
    else {
      names.add((entry as { name: string }).name)
      registry.entries.push(
        await readEntry(root, entry as Record<string, unknown>),
      )
    }
  }
  return registry
}
