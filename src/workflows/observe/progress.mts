import type { ObservationFinding, SeenAfterAction } from './report.mjs'
import type { RowSample } from './rows.mjs'

export interface ProgressWentBackFinding extends ObservationFinding {
  code: 'PROGRESS_WENT_BACK'
  row: string
  /** The highest progress, in percent, the row showed before it went back. */
  from: number
  /** The lowest progress it showed while below `from`. */
  to: number
  /** Bounds of the first sample that showed it below `from`. */
  firstSeenMs: [number, number]
  /** End of the last sample that showed it below `from`. */
  lastSeenMs: number
  samples: number
  /** End of the first sample that showed it back at `from` or higher; null if none did. */
  recoveredByMs: number | null
  afterAction: SeenAfterAction | null
}

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?)(?:\s*([kmgt]i?b|b))?`
const PERCENT = /(\d+(?:[.,]\d+)?)\s*%/
const PART_OF_TOTAL = new RegExp(
  String.raw`${AMOUNT}\s*(?:\/|\bof\b)\s*${AMOUNT}`,
  'i',
)
const BYTES: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
}

const number = (text: string) => Number(text.replace(',', '.'))
const hundredths = (value: number) => Math.round(value * 100) / 100

/**
 * The progress, in percent, that a text such as "45%", "0.3 / 1.2 GB" or "300 MB of 1.2 GB"
 * shows; null when it shows none. An amount without a unit takes the other amount's unit.
 */
export function progressPercent(text: string): number | null {
  const percent = PERCENT.exec(text)
  if (percent) return hundredths(number(percent[1]))
  const amounts = PART_OF_TOTAL.exec(text)
  if (!amounts) return null
  const [, done, doneUnit, total, totalUnit] = amounts
  const scale = (unit = doneUnit ?? totalUnit) =>
    unit ? BYTES[unit.toLowerCase()] : 1
  const of = number(total) * scale(totalUnit)
  return of > 0 ? hundredths((100 * number(done) * scale(doneUnit)) / of) : null
}

interface ProgressEntry {
  /** The last sample that showed the row. */
  index: number
  /** The highest progress the row has shown since it appeared. */
  highest?: number
  /** Its finding while it shows less than `highest`. */
  wentBack?: ProgressWentBackFinding
}

/**
 * Reports a row that showed less progress than it had shown before as PROGRESS_WENT_BACK:
 * one finding until the row is back at its earlier high or leaves the region. A row that
 * leaves and comes back starts over, as a new download of the same item would.
 */
export class ProgressTracker {
  #seen = false
  readonly #rows = new Map<string, ProgressEntry>()
  readonly #report: (finding: ProgressWentBackFinding) => void
  readonly #afterAction: (s: RowSample) => SeenAfterAction | null

  constructor(
    report: (finding: ProgressWentBackFinding) => void,
    afterAction: (s: RowSample) => SeenAfterAction | null,
  ) {
    this.#report = report
    this.#afterAction = afterAction
  }

  /** Whether any row has shown a readable progress value. */
  get seen() {
    return this.#seen
  }

  add(row: string, progress: number | undefined, s: RowSample) {
    const entry = this.#entry(row, s)
    if (progress === undefined) return
    this.#seen = true
    const { highest = progress, wentBack } = entry
    if (wentBack && progress < wentBack.from) {
      wentBack.to = Math.min(wentBack.to, progress)
      wentBack.lastSeenMs = s.toMs
      wentBack.samples++
    } else if (wentBack) {
      wentBack.recoveredByMs = s.toMs
      entry.wentBack = undefined
      entry.highest = progress
    } else if (progress < highest) {
      entry.wentBack = this.#finding(row, highest, progress, s)
      this.#report(entry.wentBack)
    } else entry.highest = progress
  }

  #entry(row: string, s: RowSample) {
    const entry = this.#rows.get(row)
    if (entry?.index === s.index - 1) {
      entry.index = s.index
      return entry
    }
    const appeared: ProgressEntry = { index: s.index }
    this.#rows.set(row, appeared)
    return appeared
  }

  #finding(
    row: string,
    from: number,
    to: number,
    s: RowSample,
  ): ProgressWentBackFinding {
    return {
      code: 'PROGRESS_WENT_BACK',
      kind: 'observation',
      basis: 'LOWER_THAN_EARLIER_SAMPLE',
      interval: s.interval,
      row,
      from,
      to,
      firstSeenMs: [s.fromMs, s.toMs],
      lastSeenMs: s.toMs,
      samples: 1,
      recoveredByMs: null,
      afterAction: this.#afterAction(s),
      note: 'The row showed less progress than it had shown earlier while it stayed in the region. A restart or a new phase can lower progress on purpose, so check it against the application logic; it is not a defect verdict.',
    }
  }
}
