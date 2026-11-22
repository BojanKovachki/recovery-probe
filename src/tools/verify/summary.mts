import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Suspect } from '../suspects/source.mjs'
import { scanForSuspects } from '../suspects/scan.mjs'
import type { CheckVerification } from './check.mjs'
import type { RunEnd, VerificationLog } from './record.mjs'
import type { Claim, VerificationRecord } from './types.mjs'

/** The fields verify has always reported; claims and the rest of the record come after them. */
export interface VerificationFields {
  verdict: 'VERIFIED' | 'NOT_VERIFIED'
  /** 0: verified; 1: a new defect; 2: anything else that keeps it from being verified. */
  exitCode: 0 | 1 | 2
  reasons: string[]
  checks: CheckVerification[]
  suspects: Suspect[]
  directory: string
  markdown: string
}

export type Verification = VerificationFields & VerificationRecord

/** The suspects on lines changed since `base`, or why the scan didn't run. */
export async function scanChangedLines(
  base: string,
): Promise<{ suspects: Suspect[]; error?: string }> {
  try {
    const { suspects } = await scanForSuspects({
      changedSince: base,
      changedLinesOnly: true,
    })
    return { suspects }
  } catch (error) {
    return { suspects: [], error: (error as Error).message }
  }
}

/** Why the scan keeps the change from being verified, if it does. */
export const scanReason = (scan: { suspects: Suspect[]; error?: string }) =>
  scan.error !== undefined
    ? `the suspect scan did not run: ${scan.error}`
    : scan.suspects.length
      ? `${scan.suspects.length} suspect(s) on changed lines: prove or dismiss each, and mark a reviewed line with // recovery-probe-ignore`
      : undefined

/** The pull request block: a plan's checks, or a policy's claims when given. */
function markdownOf(
  result: Omit<VerificationFields, 'markdown'>,
  claims?: Claim[],
): string {
  const lines = [
    `**Recovery Probe verify: ${result.verdict === 'VERIFIED' ? 'verified' : 'not verified'}**`,
    '',
    ...(claims
      ? claims
          .filter((claim) => claim.kind !== 'suspect-scan')
          .map(
            (claim) =>
              `- \`${claim.id}\`: ${claim.outcome === 'VERIFIED' ? 'verified' : `${claim.outcome} (${claim.reason})`}`,
          )
      : result.checks.map(
          (check) =>
            `- \`${check.name}\`: ${check.verified ? check.comparison!.summary : check.reason}`,
        )),
    result.suspects.length
      ? `- Suspects on changed lines: ${result.suspects.map((s) => `\`${s.file}:${s.line}\` ${s.pattern}`).join(', ')}`
      : '- No suspects on changed lines.',
  ]
  return `${lines.join('\n')}\n`
}

/** Writes summary.md and summary.json, the end of every verification, a stopped one included. */
export async function finishVerification(
  log: VerificationLog,
  fields: Omit<VerificationFields, 'markdown'>,
  end: RunEnd,
): Promise<Verification> {
  const markdown = markdownOf(
    fields,
    log.mode === 'policy' ? end.claims : undefined,
  )
  await writeFile(join(fields.directory, 'summary.md'), markdown, {
    mode: 0o600,
  })
  const record = await log.finish(fields, end)
  return { ...fields, markdown, ...record }
}

/**
 * Runs `work`. When it throws, a stop included, the summary still gets written, with the
 * claims decided so far and the rest NOT_RUN, before the error goes on.
 */
export async function summarizedEvenIfStopped<T>(
  log: VerificationLog,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const fields = {
      verdict: 'NOT_VERIFIED' as const,
      exitCode: 2 as const,
      reasons: [(error as Error).message],
      checks: [],
      suspects: [],
      directory: log.directory,
    }
    const status = signal?.aborted ? 'cancelled' : 'failed'
    await finishVerification(log, fields, { status, claims: log.claims() })
    throw error
  }
}
