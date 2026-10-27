import { ensure, isNonEmptyString, isUnique } from '../../core/validate.mjs'
import type { ObservationConfig } from './config.mjs'

const LABEL = /^[\w.:/-]{1,100}$/

// Arrays pass too; the checks that follow it reject them.
export const hasOnlyKeys = (value: unknown, keys: string[]) =>
  Boolean(value) &&
  typeof value === 'object' &&
  Object.keys(value as object).every((key) => keys.includes(key))

export function validateHttpTarget(c: Record<string, unknown>) {
  const url = new URL(c.endpoint as string)
  ensure(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'endpoint must be HTTP(S) origin/path without credentials, query or fragment',
  )
  c.endpoint = url.href
  ensure(
    c.channel === undefined &&
      c.methods === undefined &&
      c.dataEvents === undefined,
    'channel, methods and dataEvents are only supported with IPC',
  )
}

export function validateIpcTarget(c: Record<string, unknown>) {
  ensure(isNonEmptyString(c.channel), 'channel is required')
  ensure(
    c.endpoint === undefined && c.page === undefined && c.pageUrl === undefined,
    'IPC selects the window owned by its development hook',
  )
  // The development hook ends an observation after at most 125 s.
  ensure(
    (c.observationMs as number) <= 120000,
    'observationMs must be at most 120000 with IPC',
  )
  ensure(
    c.slowReads === undefined,
    'slowReads is only supported with HTTP: the IPC hook does not time each call',
  )
  if (c.methods !== undefined) c.methods = labels(c.methods, 'methods')
  if (c.dataEvents !== undefined) c.dataEvents = dataEventsConfig(c.dataEvents)
}

function dataEventsConfig(value: unknown): ObservationConfig['dataEvents'] {
  const message = 'dataEvents must be { channel, methods? }'
  ensure(hasOnlyKeys(value, ['channel', 'methods']), message)
  const events = value as { channel?: unknown; methods?: unknown }
  ensure(isNonEmptyString(events.channel), message)
  return {
    channel: events.channel,
    ...(events.methods === undefined
      ? {}
      : { methods: labels(events.methods, 'dataEvents.methods') }),
  }
}

function labels(value: unknown, key: string): string[] {
  ensure(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 50 &&
      value.every((v) => typeof v === 'string' && LABEL.test(v)) &&
      isUnique(value),
    `${key} must list 1–50 unique labels matching ${LABEL}`,
  )
  return [...value]
}
