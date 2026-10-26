/** Throws `message` unless `condition` holds. */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message)
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const isIntegerIn = (
  value: unknown,
  low: number,
  high: number,
): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= low &&
  value <= high

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

export const isUnique = (values: readonly unknown[]) =>
  new Set(values).size === values.length

/**
 * `input`'s options over `defaults`, keeping the order of `defaults`. Throws `notObject`
 * unless `input` is a plain object, and `unsupported(key)` for a key `defaults` lacks.
 */
export function withDefaults<T extends Record<string, unknown>>(
  input: unknown,
  defaults: T,
  notObject: string,
  unsupported: (key: string) => string,
): T {
  ensure(isRecord(input), notObject)
  const options: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(input)) {
    ensure(Object.hasOwn(defaults, key), unsupported(key))
    options[key] = input[key]
  }
  return options as T
}

/** `defaults` with the values `input` gives for their keys; its other keys are ignored. */
export function overDefaults<T extends Record<string, unknown>>(
  input: object,
  defaults: T,
): T {
  const options: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(defaults))
    if (Object.hasOwn(input, key))
      options[key] = (input as Record<string, unknown>)[key]
  return options as T
}

/** Throws `${key} must be ${low}–${high}` for the first option that is not an integer in its range. */
export function ensureRanges(
  options: Record<string, unknown>,
  ranges: readonly (readonly [key: string, low: number, high: number])[],
) {
  for (const [key, low, high] of ranges)
    ensure(
      isIntegerIn(options[key], low, high),
      `${key} must be ${low}–${high}`,
    )
}
