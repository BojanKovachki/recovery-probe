import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  snapshotFiles,
  compareSnapshots,
  fileEvidence,
  applyFileEvidence,
} from '../../dist/workflows/observe/files.mjs'
import { observationSummary } from '../../dist/workflows/observe/summaries.mjs'

async function contentDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-probe-files-'))
  await mkdir(join(directory, 'avatars', '5.3'), { recursive: true })
  await writeFile(join(directory, 'avatars', '5.3', 'a.pak'), 'a'.repeat(1000))
  await writeFile(join(directory, 'avatars', '5.3', 'b.pak'), 'b'.repeat(500))
  await writeFile(join(directory, 'library.pak'), 'c'.repeat(200))
  return directory
}

const snapshot = (entries, extra = {}) => ({
  files: new Map(Object.entries(entries)),
  truncated: false,
  ...extra,
})

test('records each file by its path under the directory', async () => {
  const directory = await contentDirectory()
  try {
    const { files, truncated, error } = await snapshotFiles(directory)
    assert.deepEqual([...files].sort(), [
      ['avatars/5.3/a.pak', 1000],
      ['avatars/5.3/b.pak', 500],
      ['library.pak', 200],
    ])
    assert.equal(truncated, false)
    assert.equal(error, undefined)
    assert.equal((await snapshotFiles(directory, 2)).truncated, true)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('reports a directory it cannot read', async () => {
  const result = await snapshotFiles(join(tmpdir(), 'recovery-probe-missing'))
  assert.equal(result.files.size, 0)
  assert.match(result.error, /ENOENT/)
})

test('finds files the app removed or shrank', async () => {
  const directory = await contentDirectory()
  try {
    const before = await snapshotFiles(directory)
    await rm(join(directory, 'avatars', '5.3', 'a.pak'))
    await truncate(join(directory, 'avatars', '5.3', 'b.pak'), 100)
    await writeFile(join(directory, 'library.pak'), 'c'.repeat(300))
    await writeFile(join(directory, 'new.pak'), 'd')
    const changes = compareSnapshots(before, await snapshotFiles(directory))
    assert.deepEqual(changes, {
      removed: 1,
      shrunk: 1,
      added: 1,
      grown: 1,
      bytesLost: 1000 + 400,
      removedPaths: ['avatars/5.3/a.pak'],
      shrunkPaths: ['avatars/5.3/b.pak'],
    })
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('gives each interval what changed while it was open', () => {
  const full = snapshot({ 'a.pak': 10, 'b.pak': 20 })
  const evidence = fileEvidence([
    { interval: 1, snapshot: full },
    { interval: 2, snapshot: full },
    { interval: 0, snapshot: snapshot({ 'b.pak': 20 }, { truncated: true }) },
  ])
  assert.deepEqual(evidence.intervals, [
    { interval: 1, removed: 0, shrunk: 0, added: 0, grown: 0, bytesLost: 0 },
    {
      interval: 2,
      removed: 1,
      shrunk: 0,
      added: 0,
      grown: 0,
      bytesLost: 10,
      incomplete: true,
    },
  ])
  assert.deepEqual(evidence.paths, [
    { interval: 2, removed: ['a.pak'], shrunk: [] },
  ])
})

test('reports lost files as a lead and partial snapshots as a gap', () => {
  const report = {
    status: 'complete',
    captureComplete: true,
    intervals: [
      { index: 1, findings: [] },
      { index: 2, findings: [] },
    ],
    findings: [],
    coverage: { gaps: [] },
  }
  applyFileEvidence(report, {
    intervals: [
      { interval: 1, removed: 0, shrunk: 0, added: 2, grown: 0, bytesLost: 0 },
      {
        interval: 2,
        removed: 14,
        shrunk: 1,
        added: 0,
        grown: 0,
        bytesLost: 412_300_000,
        incomplete: true,
      },
    ],
    paths: [],
  })
  assert.deepEqual(report.findings, [
    {
      code: 'LOCAL_FILES_REMOVED',
      basis: 'FILE_SNAPSHOTS',
      interval: 2,
      summary:
        '14 file(s) removed and 1 shrunk on disk (412.3 MB no longer there).',
    },
  ])
  assert.deepEqual(report.intervals[1].findings, ['LOCAL_FILES_REMOVED'])
  assert.deepEqual(report.coverage.gaps, ['FILE_SNAPSHOT_INCOMPLETE'])
  assert.equal(report.captureComplete, false)
  assert.equal(
    observationSummary(report.findings[0]),
    report.findings[0].summary,
  )
})
