import { readFile } from 'node:fs/promises'
import { UsageError } from '../core/options.mjs'

export {
  integerOption,
  parseOptions,
  text,
  UsageError,
  type Values,
} from '../core/options.mjs'

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
