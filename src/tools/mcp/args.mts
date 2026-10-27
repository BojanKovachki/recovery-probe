import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MAX_OUTPUT = 50_000

export const text = (
  args: Record<string, unknown>,
  key: string,
  required = true,
) => {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${key} must be a non-empty string`)
  return value
}

export const integer = (
  args: Record<string, unknown>,
  key: string,
  [min, max]: [number, number],
) => {
  const value = args[key]
  if (value === undefined) return undefined
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${key} must be an integer from ${min} to ${max}`)
  return value as number
}

// Playwright is an optional peer dependency, needed only by the browser tools.
export const loadWeb = async () => {
  try {
    return await import('../../workflows/web.mjs')
  } catch (error) {
    throw new Error(
      `The browser tools need Playwright: npm install --save-dev playwright && npx playwright install chromium (${(error as Error).message})`,
      { cause: error },
    )
  }
}

/** A new private directory under .recovery-probe for one run's reports. */
export const reportDirectory = async (kind: string) => {
  const directory = resolve(
    '.recovery-probe',
    `mcp-${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  return directory
}

export const truncated = (value: string) =>
  value.length > MAX_OUTPUT
    ? `${value.slice(0, MAX_OUTPUT)}\n[truncated ${value.length - MAX_OUTPUT} characters]`
    : value
