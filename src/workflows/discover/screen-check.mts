import { load, type LoadContext } from './load.mjs'
import type { DiscoveryResult, ReadSnapshot } from './types.mjs'

/** Faults armed to fail every read of one load: the most the IPC hook allows. */
const EVERY_READ = 10

type ScreenCheck<
  Fault extends string,
  Snapshot extends ReadSnapshot,
> = NonNullable<DiscoveryResult<Fault, Snapshot>['screenCheck']>

/**
 * Fails every read of the target for one load. A screen that still ends up as
 * the healthy one doesn't show that read, so no experiment on it would mean
 * anything. When the read wasn't made, or a read after the faults succeeded,
 * the check can't tell.
 */
export async function checkScreenUsesRead<
  Fault extends string,
  Snapshot extends ReadSnapshot,
>(context: LoadContext<Fault, Snapshot>, screenUrl: string): Promise<void> {
  const { setup, timing, report } = context
  const [{ fault }] = setup.experiments
  let check: ScreenCheck<Fault, Snapshot>
  try {
    const result = await load(context, {
      experiment: { fault, times: EVERY_READ },
    })
    const { injected, successfulAfterFault } = result.snapshot
    const outcome =
      injected === 0 || successfulAfterFault > 0
        ? 'not-established'
        : result.ui.fingerprint === context.trustedFingerprint()
          ? 'unchanged'
          : 'changed'
    check = { fault, injected, outcome, ui: result.ui }
  } catch (error) {
    if ((error as Error).message !== 'TARGET_NAVIGATED') throw error
    // Leaving the screen is a change; return to it for the experiments.
    const left = report.stoppedObservation
    delete report.stoppedObservation
    check = {
      fault,
      injected: left?.snapshot?.injected ?? 0,
      outcome: 'changed',
      ui: left?.ui,
    }
    await setup.page.goto(screenUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timing.baselineTimeoutMs,
    })
  }
  report.screenCheck = check
  if (check.outcome === 'unchanged') throw new Error('FAULT_NOT_VISIBLE')
}
