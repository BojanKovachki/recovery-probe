import type { Page, Request } from 'playwright'
import { escapeRegExp } from '../../core/regexp.mjs'
import { ensure, isRecord } from '../../core/validate.mjs'
import type { ObservationInterval, ObservationReport } from './report.mjs'

/** Which exported spans an observation lists, and which of their attribute values it keeps. */
export interface SpansConfig {
  /** Span names to list; `*` matches any run of characters. */
  names: string[]
  /** Attribute keys whose values are recorded. Spans can carry personal data, so others are left out. */
  attributes: string[]
}

type AttributeValue = string | number | boolean

export interface ObservedSpan {
  name: string
  /** When it started and ended, in ms since the capture started. */
  startMs: number
  endMs: number
  durationMs: number
  status: 'unset' | 'ok' | 'error'
  attributes: Record<string, AttributeValue>
  interval?: number
  /**
   * When the span ended compared with its interval's content becoming fully loaded: before,
   * within the samples that bound that moment, or after, and by how much.
   */
  vsContentLoaded?: { ended: 'after' | 'before' | 'within'; byMs: number }
}

export interface ObservationSpans {
  spans: ObservedSpan[]
  /** Exports that were not OTLP JSON, such as protobuf. */
  unreadableExports: number
  /** Matching spans beyond the first MAX_SPANS. */
  droppedSpans: number
}

const MAX_SPANS = 500
const STATUS = ['unset', 'ok', 'error'] as const

const isShortText = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 100

export function spansConfig(value: unknown): SpansConfig {
  ensure(isRecord(value), 'spans must be { names, attributes }')
  for (const key of Object.keys(value))
    ensure(
      key === 'names' || key === 'attributes',
      `Unsupported spans property: ${key}`,
    )
  const { names, attributes = [] } = value
  ensure(
    Array.isArray(names) && names.length > 0 && names.length <= 20,
    'spans.names must list 1–20 span names',
  )
  ensure(
    Array.isArray(attributes) && attributes.length <= 20,
    'spans.attributes must list up to 20 attribute keys',
  )
  ensure(
    [...names, ...attributes].every(isShortText),
    'spans names and attributes must be text of 1–100 characters',
  )
  return { names: names as string[], attributes: attributes as string[] }
}

const pattern = (glob: string) =>
  new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`)

type OtlpValue = {
  stringValue?: string
  boolValue?: boolean
  intValue?: string | number
  doubleValue?: number
}
type OtlpSpan = {
  name?: string
  startTimeUnixNano?: string | number
  endTimeUnixNano?: string | number
  status?: { code?: number }
  attributes?: { key?: string; value?: OtlpValue }[]
}

const attributeValue = ({
  stringValue,
  boolValue,
  intValue,
  doubleValue,
}: OtlpValue) =>
  stringValue ??
  boolValue ??
  (intValue === undefined ? doubleValue : Number(intValue))

/** The spans in one OTLP/HTTP JSON export that `config` lists, with their kept attributes. */
export function spansOf(
  payload: unknown,
  config: SpansConfig,
  startedEpoch: number,
): ObservedSpan[] {
  const names = config.names.map(pattern)
  const origin = BigInt(startedEpoch) * 1_000_000n
  const resourceSpans = (payload as { resourceSpans?: unknown[] }).resourceSpans
  ensure(Array.isArray(resourceSpans), 'not an OTLP JSON export')
  const spans = resourceSpans.flatMap(
    (resource) =>
      (resource as { scopeSpans?: { spans?: OtlpSpan[] }[] }).scopeSpans ?? [],
  )
  return spans
    .flatMap((scope) => scope.spans ?? [])
    .filter((span) => names.some((name) => name.test(span.name ?? '')))
    .map((span) => observedSpan(span, config, origin))
}

/** Nanoseconds as milliseconds, to the microsecond. */
const ms = (nanos: bigint) => Number(nanos / 1000n) / 1000

/** `span` with its times in ms since `origin`, the capture's start in epoch nanoseconds. */
function observedSpan(
  span: OtlpSpan,
  config: SpansConfig,
  origin: bigint,
): ObservedSpan {
  const start = BigInt(span.startTimeUnixNano ?? 0)
  const end = BigInt(span.endTimeUnixNano ?? 0)
  const kept = (span.attributes ?? []).filter(
    (attribute) => attribute.key && config.attributes.includes(attribute.key),
  )
  return {
    name: span.name ?? '',
    startMs: ms(start - origin),
    endMs: ms(end - origin),
    durationMs: ms(end - start),
    status: STATUS[span.status?.code ?? 0] ?? 'unset',
    attributes: Object.fromEntries(
      kept.flatMap(({ key, value }) => {
        const recorded = value && attributeValue(value)
        return recorded === undefined ? [] : [[key!, recorded]]
      }),
    ),
  }
}

/**
 * Lists the spans the page exports over OTLP/HTTP JSON (`POST …/v1/traces`) during the capture,
 * reading the requests as they go out; the page is not changed.
 */
export class SpanRecorder {
  readonly #page: Page
  readonly #config: SpansConfig
  readonly #spans: ObservedSpan[] = []
  #startedEpoch = 0
  #unreadable = 0
  #dropped = 0

  readonly #onRequest = (request: Request) => {
    if (
      request.method() !== 'POST' ||
      !new URL(request.url()).pathname.endsWith('/v1/traces')
    )
      return
    try {
      const spans = spansOf(
        JSON.parse(request.postData() ?? ''),
        this.#config,
        this.#startedEpoch,
      )
      const kept = spans.slice(0, MAX_SPANS - this.#spans.length)
      this.#spans.push(...kept)
      this.#dropped += spans.length - kept.length
    } catch {
      this.#unreadable++
    }
  }

  constructor(page: Page, config: SpansConfig) {
    this.#page = page
    this.#config = config
  }

  start(startedEpoch: number): void {
    this.#startedEpoch = startedEpoch
    this.#page.on('request', this.#onRequest)
  }

  stop(): ObservationSpans {
    this.#page.off('request', this.#onRequest)
    return {
      spans: this.#spans,
      unreadableExports: this.#unreadable,
      droppedSpans: this.#dropped,
    }
  }
}

/** Places each span in the interval it started in, and times it against that interval's fully loaded content. */
export function relateSpans(report: ObservationReport): void {
  for (const span of report.spans?.spans ?? []) {
    const interval = report.intervals.findLast(
      (candidate) => candidate.startMs <= span.startMs,
    )
    if (!interval) continue
    span.interval = interval.index
    const loaded = interval.contentLoaded
    const relation = loaded && vsContentLoaded(span.endMs, loaded)
    if (relation) span.vsContentLoaded = relation
  }
}

function vsContentLoaded(
  endMs: number,
  { notLoadedAtMs, toMs }: NonNullable<ObservationInterval['contentLoaded']>,
): ObservedSpan['vsContentLoaded'] {
  if (endMs > toMs) return { ended: 'after', byMs: endMs - toMs }
  // Content already fully loaded at the interval's first sample has no lower bound.
  if (notLoadedAtMs === null) return undefined
  if (endMs < notLoadedAtMs)
    return { ended: 'before', byMs: notLoadedAtMs - endMs }
  return { ended: 'within', byMs: 0 }
}
