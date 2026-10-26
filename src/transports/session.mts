import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import { observeHttp, type HttpObserver } from './http/observer.mjs'
import { resetIpcAndConfirm } from './ipc/control.mjs'
import type { FaultKind } from '../core/faults.mjs'
import type { IpcInspector } from './ipc/inspector.mjs'

/** Faults for one HTTP read: `skip` lets that many matching reads through first. */
export interface HttpPlan {
  fault?: FaultKind
  times?: number
  skip?: number
}

export function httpRefreshAdapter(
  page: Page,
  config: { endpoint: string; requiredEndpoints?: string[] },
) {
  let current: HttpObserver | undefined
  let stopped = false
  const coverage = new Map<
    string,
    ReturnType<HttpObserver['coverage']>[number]
  >()
  // Keeps the requests an observer saw, then stops it.
  const retire = async () => {
    if (!current || stopped) return
    for (const entry of current.coverage())
      coverage.set(entry.method + entry.endpoint, entry)
    stopped = true
    await current.stop()
  }
  return {
    async begin(plan: HttpPlan = {}) {
      await retire()
      current = await observeHttp(page, {
        endpoint: config.endpoint,
        requiredEndpoints: config.requiredEndpoints,
        ...plan,
      })
      stopped = false
    },
    snapshot() {
      if (!current) throw Error('Observer not started')
      return current.snapshot()
    },
    async disarm() {
      if (current) await current.disarm()
    },
    stop: retire,
    /** Every GET and non-GET request the observers saw, by method and endpoint. */
    coverage: () => [...coverage.values()],
  }
}
export function ipcRefreshAdapter(
  control: IpcInspector,
  config: {
    channel: string
    requiredChannels?: string[]
    baselineTimeoutMs?: number
  },
  senderId: number,
) {
  let id: string | undefined
  const disarm = async () => {
    if (id) return resetIpcAndConfirm(control, id)
    if ((await control.call('snapshot'))?.armed)
      throw Error('IPC_OTHER_PLAN_ARMED: not owned by this experiment')
  }
  return {
    async begin(
      fault: {
        fault?: 'rejection' | 'null-result'
        times?: number
        skip?: number
        ttlMs?: number
      } = {},
    ) {
      if (id) await resetIpcAndConfirm(control, id)
      const deadline = Date.now() + (config.baselineTimeoutMs ?? 15000)
      // Do not retry a mutating begin after an uncertain reply. Wait using
      // read-only snapshots before issuing that mutation exactly once.
      while (true) {
        const previous = await control.call('snapshot')
        if (previous?.armed) throw Error('IPC_PLAN_ALREADY_ARMED')
        if (
          !previous?.channels ||
          !Object.values(previous.channels).some((row) => row.pending)
        )
          break
        if (Date.now() >= deadline) throw Error('IPC_PREVIOUS_CALLS_PENDING')
        await sleep(50)
      }
      id = randomUUID() // Assign before mutation: a lost reply still requires reset.
      await control.call('begin', {
        id,
        channel: config.channel,
        requiredChannels: config.requiredChannels,
        ...fault,
      })
    },
    async snapshot() {
      const s = await control.call('snapshot')
      if (!s || s.id !== id || s.senderId !== senderId)
        throw Error('IPC_TARGET_OR_RUN_CHANGED')
      return s
    },
    disarm,
    stop: disarm,
  }
}
