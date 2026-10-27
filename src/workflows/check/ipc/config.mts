import type { IpcFault } from '../../../transports/ipc/control.mjs'
import {
  ensure,
  ensureRanges,
  isNonEmptyString,
  isUnique,
} from '../../../core/validate.mjs'

export interface IpcCheckConfig {
  cdp: string
  inspector: string
  channel: string
  readySelector: string
  readyText: string
  busySelector?: string
  requiredChannels: string[]
  faults: IpcFault[]
  baselineTimeoutMs: number
  retryDelayMs: number
  renderMarginMs: number
  /** Un-minimizes the window for the check and minimizes it again afterwards. */
  restoreWindow: boolean
}

export type IpcCheckInput = Partial<IpcCheckConfig> &
  Pick<IpcCheckConfig, 'channel' | 'readySelector' | 'readyText'>

const TIMINGS = [
  ['baselineTimeoutMs', 200, 60000],
  ['retryDelayMs', 0, 60000],
  ['renderMarginMs', 0, 60000],
] as const

const IPC_FAULTS: readonly unknown[] = ['rejection', 'null-result']

const isDependencyList = (value: unknown, target: string) =>
  Array.isArray(value) &&
  value.every(isNonEmptyString) &&
  !value.includes(target) &&
  isUnique(value)

const isFaultList = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  isUnique(value) &&
  value.every((fault) => IPC_FAULTS.includes(fault))

export function validateIpcConfig(input: IpcCheckInput): IpcCheckConfig {
  const c: IpcCheckConfig = {
    cdp: 'http://127.0.0.1:9222',
    inspector: 'http://127.0.0.1:9229',
    requiredChannels: [],
    faults: ['rejection'],
    baselineTimeoutMs: 15000,
    retryDelayMs: 1000,
    renderMarginMs: 1000,
    restoreWindow: false,
    ...input,
  }
  for (const name of ['channel', 'readySelector', 'readyText'] as const)
    ensure(
      isNonEmptyString(c[name]),
      `${name} is required; use known fixture content`,
    )
  ensure(
    isDependencyList(c.requiredChannels, c.channel),
    'requiredChannels must be unique dependency channels, excluding the target',
  )
  ensure(isFaultList(c.faults), 'Use unique rejection/null-result faults')
  ensureRanges(c, TIMINGS, (key) => `Invalid ${key}`)
  ensure(typeof c.restoreWindow === 'boolean', 'restoreWindow must be boolean')
  return c
}
