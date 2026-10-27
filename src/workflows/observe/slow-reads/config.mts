import { ensure, isIntegerIn, isRecord } from '../../../core/validate.mjs'

/** A page object that sends requests with postMessage and answers with message events. */
export interface PageBridgeConfig {
  /** The global holding the bridge, for example an Android WebMessageListener object. */
  global: string
  /** The request and response field that pairs an answer with its request. */
  idKey: string
}

export interface SlowReadsConfig {
  /** A read whose content takes longer than this to appear is reported. */
  thresholdMs: number
  bridge?: PageBridgeConfig
}

const GLOBAL = /^[A-Za-z_$][\w$]{0,63}$/
const ID_KEY = /^[\w$-]{1,64}$/

export function slowReadsConfig(value: unknown): SlowReadsConfig {
  ensure(
    isRecord(value) &&
      Object.keys(value).every((key) =>
        ['thresholdMs', 'bridge'].includes(key),
      ),
    'slowReads must be { thresholdMs?, bridge? }',
  )
  const thresholdMs = value.thresholdMs ?? 3000
  ensure(
    isIntegerIn(thresholdMs, 500, 600000),
    'slowReads.thresholdMs must be an integer from 500 to 600000',
  )
  return {
    thresholdMs: thresholdMs as number,
    ...(value.bridge === undefined
      ? {}
      : { bridge: bridgeConfig(value.bridge) }),
  }
}

function bridgeConfig(value: unknown): PageBridgeConfig {
  const message = `slowReads.bridge must be { global, idKey? }: a global name matching ${GLOBAL} and a field name matching ${ID_KEY}`
  ensure(
    isRecord(value) &&
      Object.keys(value).every((key) => ['global', 'idKey'].includes(key)),
    message,
  )
  const idKey = value.idKey ?? 'id'
  ensure(
    typeof value.global === 'string' &&
      GLOBAL.test(value.global) &&
      typeof idKey === 'string' &&
      ID_KEY.test(idKey),
    message,
  )
  return { global: value.global as string, idKey: idKey as string }
}
