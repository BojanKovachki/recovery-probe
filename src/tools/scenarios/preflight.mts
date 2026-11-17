import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseOptions,
  text,
  UsageError,
  type Values,
} from '../../core/options.mjs'
import { isRecord } from '../../core/validate.mjs'
import { CHECK_COMMAND_OPTIONS } from '../../workflows/command-line.mjs'
import { outsideProblem } from '../plan/paths.mjs'
import { validateCheckCommand } from '../watch/checks.mjs'
import { requirementsOf, validateConfig, validateSteps } from './validators.mjs'

/** A file a scenario reads, with the hash of its content (none for a folder). */
export interface ScenarioInput {
  path: string
  sha256: string | null
}

/** What a static look at a registered check finds, without running anything. */
export interface Preflight {
  /** Missing or unsafe files, invalid JSON, and errors from the command's own validators. */
  errors: string[]
  /** Values still to fill in, such as `{{origin}}` in a configuration. */
  unresolved: string[]
  /** What must be running or present for the check to run. */
  requires: string[]
  inputs: ScenarioInput[]
}

// Options that name a file or folder the check reads, and those read as JSON.
const PATH_OPTIONS = ['config', 'steps', 'state', 'files']
const JSON_OPTIONS = ['config', 'steps', 'state']
const PLACEHOLDER = /\{\{[^{}\n]*\}\}|\$\{[^{}\n]*\}/g

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Every placeholder left in the strings of a parsed JSON value. */
function placeholders(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string')
    for (const [match] of value.matchAll(PLACEHOLDER)) found.add(match)
  else if (Array.isArray(value))
    for (const item of value) placeholders(item, found)
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) placeholders(item, found)
  return found
}

/**
 * The check's command line as its command parses it, with the command's own option spec; throws
 * what the command would reject, without running it.
 */
function commandLine(command: string[]): Values {
  validateCheckCommand(command)
  const spec =
    CHECK_COMMAND_OPTIONS[command[0] as keyof typeof CHECK_COMMAND_OPTIONS]
  return parseOptions(command.slice(1), spec).values
}

/** Reads the files the command names, recording problems; returns the parsed JSON by option. */
async function readInputs(root: string, values: Values, result: Preflight) {
  const parsed: Record<string, unknown> = {}
  for (const name of PATH_OPTIONS) {
    const path = text(values, name)
    if (path === undefined) continue
    const problem = await outsideProblem(root, path)
    if (problem) {
      result.errors.push(problem)
      continue
    }
    if (!JSON_OPTIONS.includes(name)) {
      result.inputs.push({ path, sha256: null })
      continue
    }
    const content = await readFile(join(root, path), 'utf8').catch(() => null)
    if (content === null) {
      result.errors.push(`${path} is not a readable file`)
      continue
    }
    result.inputs.push({ path, sha256: sha256(content) })
    try {
      parsed[name] = JSON.parse(content)
    } catch {
      result.errors.push(`${path} is not valid JSON`)
    }
  }
  return parsed
}

/** Validates the configuration, and observe's steps, with the command's own validators. */
async function validate(
  name: string,
  values: Values,
  parsed: Record<string, unknown>,
  result: Preflight,
) {
  const { config, steps } = parsed
  if (!isRecord(config)) {
    result.errors.push(`${values.config} must hold a JSON object`)
    return
  }
  try {
    const validated = await validateConfig(name, values, config)
    result.requires = requirementsOf(validated, values)
  } catch (error) {
    const { message } = error as Error
    // A bad --page is a mistake on the command line, not in the configuration.
    result.errors.push(
      error instanceof UsageError ? message : `${values.config}: ${message}`,
    )
  }
  if (steps === undefined) return
  try {
    await validateSteps(values, steps)
  } catch (error) {
    result.errors.push(`${values.steps}: ${(error as Error).message}`)
  }
}

/**
 * Checks a registered command without running it: the command model and its command line, as
 * the command parses it, the files it names (inside
 * `root`, no links out, valid JSON), placeholders left in them, and its configuration and steps
 * against the validators the command itself uses. Starts nothing and contacts nothing.
 */
export async function preflightCheck(
  root: string,
  command: string[],
): Promise<Preflight> {
  const result: Preflight = {
    errors: [],
    unresolved: [],
    requires: [],
    inputs: [],
  }
  let values: Values
  try {
    values = commandLine(command)
  } catch (error) {
    result.errors.push((error as Error).message)
    return result
  }
  const parsed = await readInputs(root, values, result)
  result.unresolved = Object.entries(parsed).flatMap(([name, value]) =>
    [...placeholders(value)].map((found) => `${found} in ${values[name]}`),
  )
  if (!result.errors.length && !result.unresolved.length)
    await validate(command[0], values, parsed, result)
  return result
}
