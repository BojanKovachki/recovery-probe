import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { observeHttp } from '../../transports/http/observer.mjs'
import type { IpcInspector } from '../../transports/ipc/inspector.mjs'
import type { IpcIdentity, IpcSnapshot } from '../../ipc-probe.cjs'
import type { ObservationConfig } from './config.mjs'
import type { ReadSnapshot } from './reads.mjs'
import type { ObservationMetadata } from './report.mjs'

export interface ObservationAdapter {
  start(): Promise<void>
  snapshot(): ReadSnapshot | Promise<ReadSnapshot>
  stop(): Promise<Record<string, unknown> | undefined>
  metadata?(): ObservationMetadata['ipcHook']
}

// Older hooks answer identify with fewer fields, hence the optional chaining.
function requireObservationSupport(
  identity: IpcIdentity,
  config: ObservationConfig,
) {
  const capabilities = identity.capabilities
  if (!capabilities?.observation || !capabilities.readTimestamps)
    throw Error(
      'IPC_OBSERVATION_UNSUPPORTED: restart the development app with the new observation-capable hook',
    )
  if (config.methods && !capabilities.methods)
    throw Error(
      'IPC_METHODS_UNSUPPORTED: configure a classify function in the development hook',
    )
  if (
    config.dataEvents &&
    (!capabilities.pushes ||
      !identity.pushChannels?.includes(config.dataEvents.channel))
  )
    throw Error(
      'IPC_PUSHES_UNSUPPORTED: list dataEvents.channel in the development hook pushChannels',
    )
}

function hookMetadata(
  identity: IpcIdentity,
): NonNullable<ObservationMetadata['ipcHook']> {
  const capabilities = identity.capabilities
  return {
    version: identity.version ?? null,
    runtime: {
      node: identity.runtime?.node ?? null,
      electron: identity.runtime?.electron ?? null,
      chrome: identity.runtime?.chrome ?? null,
    },
    capabilities: {
      observation: capabilities.observation,
      readTimestamps: capabilities.readTimestamps,
      maxFaultCount: capabilities.maxFaultCount ?? null,
      methods: capabilities.methods ?? false,
      pushes: capabilities.pushes ?? false,
    },
  }
}

/** Whether the hook still observes for run `id` in the selected window, injecting nothing. */
const stillObserving = (
  s: IpcSnapshot | null,
  id: string | undefined,
  senderId: number,
): s is IpcSnapshot =>
  s != null &&
  s.id === id &&
  s.senderId === senderId &&
  Boolean(s.observation) &&
  Boolean(s.observingUntil) &&
  !s.armed &&
  !s.injected

/** Whether run `id` ended without leaving anything armed or injected. */
const cleanlyEnded = (s: IpcSnapshot | null, id: string): s is IpcSnapshot =>
  s != null && s.id === id && !s.observingUntil && !s.armed && s.injected === 0

/** Ends observation run `id` and reads back that the hook is clean. */
async function endObservation(control: IpcInspector, id: string) {
  // reset(id) cannot clear another client's plan, even after an uncertain reply.
  const resetError = await control.call('reset', id).then(
    () => undefined,
    (error: Error) => error,
  )
  const s = await control.call('snapshot')
  if (!cleanlyEnded(s, id))
    throw Error(
      `IPC_OBSERVATION_CLEANUP_UNVERIFIED${resetError ? ': ' + resetError.message : ''}`,
    )
  return {
    transport: 'ipc',
    verified: true,
    runId: s.id,
    capturedAt: s.capturedAt,
    observingUntil: s.observingUntil,
    armed: s.armed,
    injected: s.injected,
  }
}

export function ipcObservationAdapter(
  control: IpcInspector,
  config: ObservationConfig,
  senderId: number,
): ObservationAdapter {
  let id: string | undefined,
    metadata: ObservationMetadata['ipcHook'] = null
  return {
    metadata: () => metadata,
    async start() {
      const identity = await control.call('identify')
      requireObservationSupport(identity, config)
      metadata = hookMetadata(identity)
      if (identity.senderId !== senderId) throw Error('IPC_TARGET_CHANGED')
      const previous = await control.call('snapshot')
      if (previous?.armed || previous?.observingUntil)
        throw Error('IPC_PLAN_ALREADY_ACTIVE')
      id = randomUUID() // A lost begin reply still requires scoped cleanup.
      await control.call('begin', {
        id,
        channel: config.channel!,
        observation: true,
        ttlMs: config.observationMs + 5000,
      })
    },
    async snapshot() {
      const s = await control.call('snapshot')
      if (!stillObserving(s, id, senderId))
        throw Error('IPC_OBSERVATION_COVERAGE_LOST')
      return s
    },
    async stop() {
      if (id) return endObservation(control, id)
    },
  }
}

export function httpObservationAdapter(
  page: Page,
  config: ObservationConfig,
): ObservationAdapter {
  let observer: Awaited<ReturnType<typeof observeHttp>> | undefined
  return {
    async start() {
      observer = await observeHttp(page, { endpoint: config.endpoint! })
    },
    snapshot() {
      return observer!.snapshot()
    },
    async stop() {
      await observer?.stop()
      return { transport: 'http', listenersDetached: true }
    },
  }
}
