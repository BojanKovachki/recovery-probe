import { readFile } from 'node:fs/promises'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'

/** A mistake in how a command was called or configured. The CLI exits with 3. */
export class UsageError extends Error {}

export type Values = Record<string, string | boolean | undefined>

/** A string flag's value, or undefined when it isn't given. */
export const text = (values: Values, name: string): string | undefined =>
  typeof values[name] === 'string' ? values[name] : undefined

/** Parses a command's flags strictly; anything unknown or incomplete is a UsageError. */
export function parseOptions(
  args: string[],
  options: ParseArgsOptionsConfig,
  positionals = 0,
): { values: Values; positionals: string[] } {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: positionals > 0,
    })
  } catch (error) {
    // parseArgs explains how to pass a positional that starts with "-"; that's noise here.
    throw new UsageError((error as Error).message.split('. ')[0])
  }
  if (parsed.positionals.length > positionals)
    throw new UsageError(
      `Unexpected argument: ${parsed.positionals[positionals]}`,
    )
  return { values: parsed.values as Values, positionals: parsed.positionals }
}

/** A whole number flag within [min, max], or undefined when it isn't given. */
export function integerOption(
  values: Values,
  name: string,
  [min, max]: [number, number],
): number | undefined {
  const value = values[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new UsageError(`--${name} must be a whole number`)
  const number = Number(value)
  if (number < min || number > max)
    throw new UsageError(`--${name} must be ${min}–${max}`)
  return number
}

/** Reads a JSON config; a missing file, bad JSON or a rejected config is a UsageError. */
export async function readConfig<T = Record<string, unknown>>(
  path: string,
  validate: (config: Record<string, unknown>) => T = (config) => config as T,
): Promise<T> {
  let config: Record<string, unknown>
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new UsageError(`Can't read ${path}: ${(error as Error).message}`)
  }
  try {
    return validate(config)
  } catch (error) {
    throw new UsageError(`${path}: ${(error as Error).message}`)
  }
}

/** Runs a config validator, reporting what it rejects as wrong usage. */
export function validated<T>(validate: () => T): T {
  try {
    return validate()
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
