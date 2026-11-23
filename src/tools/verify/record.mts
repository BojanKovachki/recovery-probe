import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomically } from '../../reports/folder.mjs'
import { VERDICT_RULES } from './rules.mjs'
import {
  VERIFICATION_SCHEMA,
  type Claim,
  type ClaimAttempt,
  type RunRecord,
  type VerificationRecord,
} from './types.mjs'

export const PARTIAL_SUMMARY = 'verification.partial.json'

/** A claim the run will decide: what it says, before any result. */
export type PendingClaim = Pick<
  Claim,
  'id' | 'kind' | 'statement' | 'expectation'
>

/** How a verification ended, and what is known only then. */
export interface RunEnd {
  status: RunRecord['status']
  claims: Claim[]
  coverage?: VerificationRecord['coverage']
  reviewSignals?: VerificationRecord['reviewSignals']
  environment?: VerificationRecord['environment']
}

type RecordStart = Omit<
  VerificationRecord,
  'schema' | 'run' | 'verdictRules' | 'claims'
>

const runId = (at: Date) =>
  `${at.toISOString().replace(/[-:]|\.\d+/g, '')}-${randomBytes(2).toString('hex')}`

/**
 * What a verification has done so far. Every attempt rewrites verification.partial.json, and
 * the end, a stop included, writes summary.json, so an interrupted run leaves its evidence.
 */
export class VerificationLog {
  readonly #directory: string
  readonly #record: Omit<VerificationRecord, 'claims'>
  readonly #pending: PendingClaim[]
  readonly #attempts = new Map<string, ClaimAttempt[]>()
  readonly #decided = new Map<string, Claim>()

  private constructor(
    directory: string,
    start: RecordStart,
    pending: PendingClaim[],
  ) {
    const startedAt = new Date()
    this.#directory = directory
    this.#pending = pending
    this.#record = {
      schema: VERIFICATION_SCHEMA,
      ...start,
      run: {
        id: runId(startedAt),
        status: 'running',
        startedAt: startedAt.toISOString(),
      },
      verdictRules: VERDICT_RULES,
    }
  }

  static async start(
    directory: string,
    start: RecordStart,
    pending: PendingClaim[],
  ) {
    const log = new VerificationLog(directory, start, pending)
    await log.#writePartial()
    return log
  }

  get mode() {
    return this.#record.mode
  }

  get directory() {
    return this.#directory
  }

  attemptsOf(id: string): ClaimAttempt[] {
    return this.#attempts.get(id) ?? []
  }

  async attempt(id: string, attempt: ClaimAttempt) {
    this.#attempts.set(id, [...this.attemptsOf(id), attempt])
    await this.#writePartial()
  }

  async decided(claim: Claim) {
    this.#decided.set(claim.id, claim)
    await this.#writePartial()
  }

  /** The claims decided so far, and the rest without a result, which never counts as a pass. */
  claims(note = 'the run ended before this claim had a result'): Claim[] {
    return this.#pending.map(
      (claim) =>
        this.#decided.get(claim.id) ?? {
          ...claim,
          outcome: 'NOT_VERIFIED',
          reason: 'NOT_RUN',
          execution: { status: 'skipped', attempts: this.attemptsOf(claim.id) },
          baseline: { status: 'not-run' },
          evidence: [],
          gaps: [`NOT_RUN: ${note}`],
        },
    )
  }

  /** Writes summary.json: the older `fields` with the record. Returns the record. */
  async finish(
    fields: object,
    { status, claims, coverage, reviewSignals, environment }: RunEnd,
  ): Promise<VerificationRecord> {
    const record: VerificationRecord = {
      ...this.#record,
      ...(coverage ? { coverage } : {}),
      ...(reviewSignals ? { reviewSignals } : {}),
      ...(environment ? { environment } : {}),
      run: { ...this.#record.run, status, endedAt: new Date().toISOString() },
      claims,
    }
    await writeFile(
      join(this.#directory, 'summary.json'),
      `${JSON.stringify({ ...fields, ...record }, null, 2)}\n`,
      { mode: 0o600 },
    )
    await rm(join(this.#directory, PARTIAL_SUMMARY), { force: true })
    return record
  }

  #writePartial() {
    return writeAtomically(
      join(this.#directory, PARTIAL_SUMMARY),
      `${JSON.stringify({ ...this.#record, claims: this.claims('no result yet') }, null, 2)}\n`,
    )
  }
}
