import type { Plan } from './checks.cjs'
import { readStats } from './stats.cjs'
import type { IpcIdentity, ProbeState, ProbeWebContents } from './types.cjs'

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json is outside the source root, so it is read at runtime.
const { version } = require('../../package.json') as { version: string }

/** What `identify` reports about the hook and its target window. */
export function identityOf(
  contents: ProbeWebContents,
  {
    allowed,
    registered,
    pushChannels,
    methods,
  }: {
    allowed: Set<string>
    registered: Set<string>
    pushChannels: Set<string>
    methods: boolean
  },
): IpcIdentity {
  return {
    version,
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
    },
    senderId: contents.id,
    pageUrl: contents.getURL(),
    channels: [...allowed],
    registered: [...registered],
    pushChannels: [...pushChannels],
    capabilities: {
      maxFaultCount: 10,
      observation: true,
      readTimestamps: true,
      methods,
      pushes: pushChannels.size > 0,
      faultDelay: true,
      faultSkip: true,
    },
  }
}

/** A new plan's state, with a row per watched channel. */
export function newState(
  plan: Plan,
  senderId: number,
  methods: boolean,
): ProbeState {
  const state: ProbeState = {
    id: plan.id,
    channel: plan.channel,
    senderId,
    startedAt: Date.now(),
    observation: plan.observation,
    observingUntil: plan.observation ? Date.now() + plan.ttlMs : null,
    injected: 0,
    injectedAt: null,
    successfulAfterFault: 0,
    armed: plan.fault
      ? {
          fault: plan.fault,
          remaining: plan.times,
          skip: plan.skip,
          expiresAt: Date.now() + plan.ttlMs,
          delayMs: plan.delayMs,
        }
      : null,
    channels: Object.create(null),
    pushes: Object.create(null),
  }
  for (const name of plan.watched)
    state.channels[name] = {
      ...readStats(),
      realCalls: 0,
      maxDurationMs: 0,
      ...(methods ? { methods: Object.create(null) } : {}),
    }
  return state
}

/** Adds a row per push channel; only observation plans count pushes. */
export function addPushRows(state: ProbeState, channels: Iterable<string>) {
  for (const name of channels)
    state.pushes[name] = {
      count: 0,
      firstAt: null,
      lastAt: null,
      methods: Object.create(null),
    }
}
