import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../../core/validate.mjs'
import { outsideProblem } from '../plan/paths.mjs'
import { validateCheckCommand } from '../watch/checks.mjs'
import {
  flagsOf,
  requirementsOf,
  validateConfig,
  validateSteps,
} from './validators.mjs'

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

// Check arguments that name a file or folder the check reads, and those read as JSON.
const PATH_FLAGS = ['--config', '--steps', '--state', '--files']
const JSON_FLAGS = ['--config', '--steps', '--state']
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

/** Reads the files the command names, recording problems; returns the parsed JSON by flag. */
async function readInputs(root: string, command: string[], result: Preflight) {
  const parsed: Record<string, unknown> = {}
  for (const [i, flag] of command.entries()) {
    if (!PATH_FLAGS.includes(flag)) continue
    const path = command[i + 1] ?? ''
    const problem = await outsideProblem(root, path)
    if (problem) {
      result.errors.push(problem)
      continue
    }
    if (!JSON_FLAGS.includes(flag)) {
      result.inputs.push({ path, sha256: null })
      continue
    }
    const text = await readFile(join(root, path), 'utf8').catch(() => null)
    if (text === null) {
      result.errors.push(`${path} is not a readable file`)
      continue
    }
    result.inputs.push({ path, sha256: sha256(text) })
    try {
      parsed[flag] = JSON.parse(text)
    } catch {
      result.errors.push(`${path} is not valid JSON`)
    }
  }
  return parsed
}

const fileOf = (command: string[], flag: string) =>
  command[command.indexOf(flag) + 1]

/** Validates the configuration, and observe's steps, with the command's own validators. */
async function validate(
  command: string[],
  parsed: Record<string, unknown>,
  result: Preflight,
) {
  const config = parsed['--config']
  if (!isRecord(config)) {
    result.errors.push(`${fileOf(command, '--config')} must hold a JSON object`)
    return
  }
  try {
    const validated = await validateConfig(command, config)
    result.requires = requirementsOf(validated, flagsOf(command))
  } catch (error) {
    result.errors.push(
      `${fileOf(command, '--config')}: ${(error as Error).message}`,
    )
  }
  if (parsed['--steps'] === undefined) return
  try {
    await validateSteps(command, parsed['--steps'])
  } catch (error) {
    result.errors.push(
      `${fileOf(command, '--steps')}: ${(error as Error).message}`,
    )
  }
}

/**
 * Checks a registered command without running it: the command model, the files it names (inside
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
  try {
    validateCheckCommand(command)
  } catch (error) {
    result.errors.push((error as Error).message)
    return result
  }
  const parsed = await readInputs(root, command, result)
  result.unresolved = Object.entries(parsed).flatMap(([flag, value]) =>
    [...placeholders(value)].map(
      (found) => `${found} in ${fileOf(command, flag)}`,
    ),
  )
  if (!result.errors.length && !result.unresolved.length)
    await validate(command, parsed, result)
  return result
}
