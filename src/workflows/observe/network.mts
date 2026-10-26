import type {
  NetworkFaultControl,
  NetworkFaultRule,
} from '../../transports/net/types.mjs'
import type {
  NetworkStepRecord,
  ObservationNetwork,
  ObservationReport,
} from './report.mjs'
import type { NetworkStepControl } from './steps.mjs'

/**
 * Applies observe's network steps through a `recovery-probe net` control and records
 * what each armed set of rules faulted.
 */
export function networkSteps(
  control: NetworkFaultControl,
): NetworkStepControl & {
  /** Disarms in every case, so a capture never leaves the app's network faulted. */
  finish(): Promise<ObservationNetwork>
} {
  const faults: NetworkStepRecord[] = []
  let armed: NetworkStepRecord | undefined

  // Read before the rules are replaced: the proxy only reports the armed set.
  const settle = async () => {
    const record = armed
    armed = undefined
    if (record) record.rules = (await control.summary()).rules
  }

  return {
    async arm(rules: NetworkFaultRule[], step: number) {
      await settle()
      await control.arm(rules)
      armed = { step }
      faults.push(armed)
    },
    async restore(step: number) {
      await settle()
      await control.disarm()
      faults.push({ step, restored: true })
    },
    async finish() {
      await settle().catch(() => {})
      try {
        await control.disarm()
        return { faults }
      } catch (error) {
        return { faults, restoreError: (error as Error).message }
      }
    },
  }
}

/** Adds network evidence to an observation report, with its coverage gaps. */
export function applyNetworkEvidence(
  report: ObservationReport,
  network: ObservationNetwork,
): void {
  if (!network.faults.length && !network.restoreError) return
  report.mode = 'observation with network faults'
  report.network = network
  const gaps = report.coverage?.gaps
  if (!gaps) return
  const add = (code: string) => {
    if (!gaps.includes(code)) gaps.push(code)
  }
  if (
    network.faults.some((record) =>
      record.rules?.some((rule) => rule.applied === 0),
    )
  )
    add('NETWORK_FAULT_NOT_TRIGGERED')
  if (network.restoreError) add('NETWORK_FAULTS_NOT_RESTORED')
  report.captureComplete = report.status === 'complete' && gaps.length === 0
}
