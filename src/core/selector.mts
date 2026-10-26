import { ensure, isNonEmptyString, isRecord } from './validate.mjs'

/** A CSS selector, or an element matched by CSS and/or ARIA role, name and text. */
export type SelectorSpec =
  string | { css?: string; role?: string; name?: string; text?: string }

const SELECTOR_KEYS = new Set(['css', 'role', 'name', 'text'])

const isTextUpTo200 = (value: unknown) =>
  isNonEmptyString(value) && value.length <= 200

/** Validates a CSS string or { css, role, name, text } selector; `key` names it in errors. */
export function selectorSpec(value: unknown, key: string): SelectorSpec {
  if (typeof value === 'string') {
    ensure(value.trim() !== '', `${key} must be a non-empty CSS selector`)
    return value
  }
  ensure(
    isRecord(value),
    `${key} must be a CSS selector string or { css, role, name, text }`,
  )
  for (const property of Object.keys(value))
    ensure(
      SELECTOR_KEYS.has(property),
      `Unsupported ${key} property: ${property}`,
    )
  const { css, role, name } = value
  ensure(css !== undefined || role !== undefined, `${key} needs css or role`)
  ensure(
    css === undefined || isNonEmptyString(css),
    `${key}.css must be a non-empty CSS selector`,
  )
  ensure(
    role === undefined ||
      (typeof role === 'string' && /^[a-z]{2,30}$/.test(role)),
    `${key}.role must be an ARIA role name`,
  )
  for (const property of ['name', 'text'])
    ensure(
      value[property] === undefined || isTextUpTo200(value[property]),
      `${key}.${property} must be 1–200 characters`,
    )
  ensure(name === undefined || role !== undefined, `${key}.name requires role`)
  return { ...value } as SelectorSpec
}
