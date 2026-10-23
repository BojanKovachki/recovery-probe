import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import type { IpcInspector } from './inspector.mjs'
import type { IpcSnapshot } from '../../ipc-probe.cjs'

export type IpcFault = NonNullable<IpcSnapshot['armed']>['fault']

declare global {
  /** The temporary renderer challenge that the hook's identify checks. */
  var __recoveryProbeWindowNonce: string | undefined
}

/** A failed reply does not mean a mutation failed to execute. Never retry begin.
 * Reset its exact ID and independently read back state, even if reset's reply fails.
 * Do not use an unscoped reset: that could disarm another client's newer run.
 */
export async function resetIpcAndConfirm(
  control: IpcInspector,
  id: string,
): Promise<IpcSnapshot | null> {
  if (typeof id !== 'string' || !id)
    throw new Error('A run ID is required for scoped cleanup')
  let resetError: Error | undefined
  try {
    await control.call('reset', id)
  } catch (error) {
    resetError = error as Error
  }
  let snapshot: IpcSnapshot | null
  try {
    snapshot = await control.call('snapshot')
  } catch (error) {
    throw new Error(
      `IPC cleanup unverified: cannot read back state (${(error as Error).message}). Stop the test app; a fault may remain armed until its TTL expires.`,
      { cause: error },
    )
  }
  if (
    snapshot !== null &&
    (!snapshot || !Object.hasOwn(snapshot, 'armed') || snapshot.armed !== null)
  ) {
    throw new Error(
      `IPC cleanup unverified: a plan may remain armed${resetError ? ' (' + resetError.message + ')' : ''}. Stop the test app; do not continue testing.`,
    )
  }
  return snapshot
}

/** The hook refuses a new plan while the previous plan's real calls are pending. */
export async function waitForSettledCalls(
  control: IpcInspector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const snapshot = await control.call('snapshot')
    if (
      !snapshot?.channels ||
      !Object.values(snapshot.channels).some((row) => row.pending)
    )
      return
    if (Date.now() >= deadline) throw new Error('IPC_PREVIOUS_CALLS_PENDING')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Confirms both debugger ports reach the same renderer, not merely two apps
 * showing the same URL. Removes the temporary challenge afterwards.
 */
export async function confirmSameWindow(
  page: Page,
  control: IpcInspector,
): Promise<void> {
  const challenge = randomUUID()
  await page.evaluate((value) => {
    if (Object.hasOwn(globalThis, '__recoveryProbeWindowNonce'))
      throw new Error(
        'Window already has a probe challenge; reload before retrying',
      )
    Object.defineProperty(globalThis, '__recoveryProbeWindowNonce', {
      value,
      configurable: true,
    })
  }, challenge)
  try {
    await control.call('identify', challenge)
  } finally {
    await page.evaluate((value) => {
      if (globalThis.__recoveryProbeWindowNonce === value)
        delete globalThis.__recoveryProbeWindowNonce
    }, challenge)
  }
}
