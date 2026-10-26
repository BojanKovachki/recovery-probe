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
import { DAMAGED, fileFaultSummary } from './summaries.mjs'
import {
  intervalAt,
  type FileFaultRecord,
  type ObservationReport,
} from './report.mjs'
import type { FileFault, FileStepControl } from './steps.mjs'

export interface FileFaultEvidence {
  /** For the report, which never names files. */
  faults: FileFaultRecord[]
  /** For the private files.json. `backup` and `error` are set when an original had to be kept. */
  paths: { step: number; path: string; backup?: string; error?: string }[]
}

interface DamageRecord extends FileFaultRecord {
  path: string
  backup: string
  original: string | null
  /** The damaged file's hash, `null` once removed; unset until the damage is done. */
  left?: string | null
  /** The error message, which names local paths. */
  detail?: string
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

async function applyFault(target: string, fault: FileFault, size: number) {
  if (fault === 'remove') await unlink(target)
  else if (fault === 'truncate') await truncate(target, Math.floor(size / 2))
  else await corrupt(target, size)
}

const outcomeOf = (now: string | null, record: DamageRecord) => {
  if (now === record.original) return 'repaired'
  return now === record.left ? 'damaged' : 'changed'
}

/**
 * Damages files under `directory` for observe's file steps. Each original is copied
 * to a private temporary folder first, and put back when the capture ends unless the
 * app has restored or replaced it.
 */
export class FileFaults implements FileStepControl {
  readonly #directory: string
  readonly #records: DamageRecord[] = []
  // Steps run one at a time, so the folder is never created twice.
  #backups?: string

  constructor(directory: string) {
    this.#directory = directory
  }

  async damage(path: string, fault: FileFault, step: number) {
    const earlier = this.#records.find((record) => record.path === path)
    if (earlier)
      throw Error(`FILE_ALREADY_DAMAGED: step ${earlier.step} damaged it`)
    const target = this.#inside(path)
    const stats = await lstat(target).catch(() => null)
    if (!stats?.isFile()) throw Error('FILE_NOT_FOUND: no regular file there')
    if (fault !== 'remove' && stats.size === 0)
      throw Error(`FILE_EMPTY: an empty file cannot be ${DAMAGED[fault]}`)
    this.#backups ??= await mkdtemp(join(tmpdir(), 'recovery-probe-files-'))
    const backup = join(this.#backups, String(step))
    await copyFile(target, backup)
    // Recorded before the damage, so a step that fails halfway is still put back.
    const record: DamageRecord = {
      step,
      fault,
      path,
      backup,
      original: await sha256(backup),
    }
    this.#records.push(record)
    await applyFault(target, fault, stats.size)
    record.left = fault === 'remove' ? null : await sha256(target)
  }

  /** The damaged paths, relative to the directory, for the snapshots to leave out. */
  damaged(): Set<string> {
    return new Set(this.#records.map((record) => record.path))
  }

  /** Checks what became of each file and puts back the ones the app left damaged or missing. */
  async finish(): Promise<FileFaultEvidence> {
    for (const record of this.#records) await this.#settle(record)
    const kept = this.#records.some((record) => record.error)
    if (this.#backups && !kept)
      await rm(this.#backups, { recursive: true, force: true }).catch(() => {})
    const reported = this.#records.filter(
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
  }

  #inside(path: string) {
    const target = resolve(this.#directory, path)
    const inside = relative(this.#directory, target)
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw Error('FILE_OUTSIDE_DIRECTORY')
    return target
  }

  /** Records what became of one file, and puts it back if the app left it damaged or missing. */
  async #settle(record: DamageRecord) {
    const target = resolve(this.#directory, record.path)
    try {
      const now = await sha256(target)
      if (record.left === undefined) {
        // The step failed, so its damage is not evidence; undo whatever it did.
        if (now !== record.original) await copyFile(record.backup, target)
        return
      }
      record.outcome = outcomeOf(now, record)
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
  for (const record of evidence.faults)
    if (record.outcome === 'damaged' || record.outcome === 'changed')
      addNotRepaired(report, record)
  const gaps = report.coverage?.gaps
  if (!gaps) return
  const unrestored = evidence.faults.some((record) => record.error)
  if (unrestored && !gaps.includes('FILE_FAULTS_NOT_RESTORED'))
    gaps.push('FILE_FAULTS_NOT_RESTORED')
  report.captureComplete = report.status === 'complete' && gaps.length === 0
}

function addNotRepaired(report: ObservationReport, record: FileFaultRecord) {
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
