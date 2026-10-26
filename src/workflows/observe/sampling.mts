interface PhaseStats {
  count: number
  meanMs: number | null
  minMs: number | null
  maxMs: number | null
}

export interface SamplingSnapshot {
  requestedDelayMs: number
  completedSamples: number
  sampleDuration: PhaseStats
  startToStart: PhaseStats
  phases: Record<string, PhaseStats>
  note: string
}

const samplingPhases = [
  'beforeSnapshotMs',
  'uiRoundTripMs',
  'rendererReadMs',
  'summarizeMs',
  'afterSnapshotMs',
] as const

export type SamplingTimings = Partial<
  Record<(typeof samplingPhases)[number], number>
>

const round = (n: number) => Math.round(n * 100) / 100

/** Count, mean, minimum and maximum of the values added. */
function accumulator() {
  let count = 0,
    sum = 0,
    min = Infinity,
    max = 0
  return {
    add(value: number) {
      count++
      sum += value
      min = Math.min(min, value)
      max = Math.max(max, value)
    },
    stats(): PhaseStats {
      return {
        count,
        meanMs: count ? round(sum / count) : null,
        minMs: count ? round(min) : null,
        maxMs: count ? round(max) : null,
      }
    },
  }
}

// Aggregate every completed sample, including samples omitted from the change-only timeline.
export function samplingMetrics(requestedDelayMs: number) {
  const duration = accumulator()
  const startToStart = accumulator()
  const phases: Record<string, ReturnType<typeof accumulator>> = {}
  let previous: number | undefined
  return {
    add(fromMs: number, toMs: number, timings: SamplingTimings = {}) {
      duration.add(toMs - fromMs)
      if (previous !== undefined) startToStart.add(fromMs - previous)
      previous = fromMs
      for (const key of samplingPhases) {
        const value = timings[key]
        if (value !== undefined && Number.isFinite(value) && value >= 0)
          (phases[key] ??= accumulator()).add(value)
      }
    },
    snapshot(): SamplingSnapshot {
      const sampleDuration = duration.stats()
      return {
        requestedDelayMs,
        completedSamples: sampleDuration.count,
        sampleDuration,
        startToStart: startToStart.stats(),
        phases: Object.fromEntries(
          Object.entries(phases).map(([key, phase]) => [key, phase.stats()]),
        ),
        note: 'The configured delay follows each completed sample. Sample duration brackets the UI read and following counter snapshot; cadence also includes other protocol work. These are completed-sample measurements, not guaranteed temporal coverage.',
      }
    },
  }
}
