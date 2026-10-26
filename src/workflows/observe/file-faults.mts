import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  truncate,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  DAMAGED,
  fileFaultSummary,
  intervalAt,
  type FileFaultRecord,
  type ObservationReport,
} from './report.mjs'
import type { FileStepControl } from './steps.mjs'

export interface FileFaultEvidence {
  /** For the report, which never names files. */
  faults: FileFaultRecord[]
  /** For the private files.json. `backup` and `error` are set when an original had to be kept. */
  paths: { step: number; path: string; backup?: string; error?: string }[]
}

// Enough to break any checksum or decoder, small enough to leave the size alone.
const CORRUPT_BYTES = 4096

/** The file's SHA-256, or `null` when there is no file. */
const sha256 = (path: string): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', (error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? resolve(null) : reject(error),
      )
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })

async function corrupt(path: string, size: number): Promise<void> {
  const length = Math.min(CORRUPT_BYTES, size)
  const position = Math.floor((size - length) / 2)
  const handle = await open(path, 'r+')
  try {
    const bytes = Buffer.alloc(length)
    await handle.read(bytes, 0, length, position)
    for (let i = 0; i < length; i++) bytes[i] ^= 0xff
    await handle.write(bytes, 0, length, position)
  } finally {
    await handle.close()
  }
}

/**
 * Damages files under `directory` for observe's file steps. Each original is copied
 * to a private temporary folder first, and put back when the capture ends unless the
 * app has restored or replaced it.
 */
export function fileFaults(directory: string): FileStepControl & {
  /** The damaged paths, relative to the directory, for the snapshots to leave out. */
  damaged(): Set<string>
  /** Checks what became of each file and puts back the ones the app left damaged or missing. */
  finish(): Promise<FileFaultEvidence>
} {
  const records: (FileFaultRecord & {
    path: string
    backup: string
    original: string | null
    /** The damaged file's hash, `null` once removed; unset until the damage is done. */
    left?: string | null
    /** The error message, which names local paths. */
    detail?: string
  })[] = []
  // Steps run one at a time, so the folder is never created twice.
  let backups: string | undefined

  return {
    async damage(path, fault, step) {
      const earlier = records.find((record) => record.path === path)
      if (earlier)
        throw Error(`FILE_ALREADY_DAMAGED: step ${earlier.step} damaged it`)
      const target = resolve(directory, path)
      const inside = relative(directory, target)
      if (!inside || inside.startsWith('..') || isAbsolute(inside))
        throw Error('FILE_OUTSIDE_DIRECTORY')
      const stats = await lstat(target).catch(() => null)
      if (!stats?.isFile()) throw Error('FILE_NOT_FOUND: no regular file there')
      if (fault !== 'remove' && stats.size === 0)
        throw Error(`FILE_EMPTY: an empty file cannot be ${DAMAGED[fault]}`)
      backups ??= await mkdtemp(join(tmpdir(), 'recovery-probe-files-'))
      const backup = join(backups, String(step))
      await copyFile(target, backup)
      // Recorded before the damage, so a step that fails halfway is still put back.
      const record: (typeof records)[number] = {
        step,
        fault,
        path,
        backup,
        original: await sha256(backup),
      }
      records.push(record)
      if (fault === 'remove') await unlink(target)
      else if (fault === 'truncate')
        await truncate(target, Math.floor(stats.size / 2))
      else await corrupt(target, stats.size)
      record.left = fault === 'remove' ? null : await sha256(target)
    },
    damaged: () => new Set(records.map((record) => record.path)),
    async finish() {
      for (const record of records) {
        const target = resolve(directory, record.path)
        try {
          const now = await sha256(target)
          if (record.left === undefined) {
            // The step failed, so its damage is not evidence; undo whatever it did.
            if (now !== record.original) await copyFile(record.backup, target)
            continue
          }
          record.outcome =
            now === record.original
              ? 'repaired'
              : now === record.left
                ? 'damaged'
                : 'changed'
          // A file the app rewrote is left as the app has it.
          if (now === record.left || now === null) {
            await mkdir(dirname(target), { recursive: true })
            await copyFile(record.backup, target)
            record.restored = true
          }
        } catch (error) {
          record.error = (error as NodeJS.ErrnoException).code ?? 'ERROR'
          record.detail = (error as Error).message.split('\n')[0].slice(0, 300)
        }
      }
      const kept = records.some((record) => record.error)
      if (backups && !kept)
        await rm(backups, { recursive: true, force: true }).catch(() => {})
      const reported = records.filter(
        (record) => record.left !== undefined || record.error,
      )
      return {
        faults: reported.map(({ step, fault, outcome, restored, error }) => ({
          step,
          fault,
          ...(outcome ? { outcome } : {}),
          ...(restored ? { restored } : {}),
          ...(error ? { error } : {}),
        })),
        paths: reported.map(({ step, path, backup, detail }) => ({
          step,
          path,
          ...(detail ? { backup, error: detail } : {}),
        })),
      }
    },
  }
}

/**
 * Adds file-fault evidence to an observation report: a `LOCAL_FILE_NOT_REPAIRED`
 * finding for each file the app had not restored by the end of the capture, and a
 * coverage gap when a file could not be checked or put back.
 */
export function applyFileFaultEvidence(
  report: ObservationReport,
  evidence: FileFaultEvidence,
): void {
  if (!evidence.faults.length) return
  report.mode = report.network
    ? 'observation with network and file faults'
    : 'observation with file faults'
  report.fileFaults = evidence.faults
  for (const record of evidence.faults) {
    if (record.outcome !== 'damaged' && record.outcome !== 'changed') continue
    const startedMs = report.operator?.steps?.[record.step]?.startedMs
    const interval = intervalAt(report, startedMs ?? 0)
    report.findings.push({
      code: 'LOCAL_FILE_NOT_REPAIRED',
      basis: 'FILE_FAULT',
      interval,
      summary: fileFaultSummary(record),
    })
    report.intervals
      .find((i) => i.index === interval)
      ?.findings.push('LOCAL_FILE_NOT_REPAIRED')
  }
  const gaps = report.coverage?.gaps
  if (!gaps) return
  if (
    evidence.faults.some((record) => record.error) &&
    !gaps.includes('FILE_FAULTS_NOT_RESTORED')
  )
    gaps.push('FILE_FAULTS_NOT_RESTORED')
  report.captureComplete = report.status === 'complete' && gaps.length === 0
}
