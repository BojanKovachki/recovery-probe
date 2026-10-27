import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { observationSteps } from '../../dist/workflows/observe/steps.mjs'
import { runSteps } from '../../dist/workflows/observe/step-runner.mjs'
import {
  FileFaults,
  applyFileFaultEvidence,
} from '../../dist/workflows/observe/file-faults.mjs'
import { applyExpectationEvidence } from '../../dist/workflows/observe/report.mjs'
import { fileFaultSummary } from '../../dist/workflows/observe/summaries.mjs'
import { fileEvidence } from '../../dist/workflows/observe/files.mjs'
import { fake } from '../helpers/fake.mjs'

const runOptions = (files) => ({
  mark: async () => null,
  signal: new AbortController().signal,
  elapsed: () => 0,
  files,
})

async function installation(files) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-file-faults-'))
  for (const [path, content] of Object.entries(files))
    await writeFile(join(directory, path), content)
  return directory
}

test('file steps need a directory and a path inside it', () => {
  const remove = { file: { path: 'Binaries/api.dll', fault: 'remove' } }
  assert.throws(() => observationSteps([remove]), /needs a directory/)
  assert.deepEqual(
    observationSteps(
      [
        remove,
        { file: { path: 'Paks\\content.pak', fault: 'truncate' } },
        { file: { path: './data.bin', fault: 'corrupt' }, name: 'corrupt' },
      ],
      { files: true },
    ),
    [
      { kind: 'file', path: 'Binaries/api.dll', fault: 'remove' },
      { kind: 'file', path: 'Paks/content.pak', fault: 'truncate' },
      { kind: 'file', path: 'data.bin', fault: 'corrupt', name: 'corrupt' },
    ],
  )
  for (const path of [
    '../outside.dll',
    'Binaries/../../outside.dll',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\file',
    'Binaries//api.dll',
    '',
  ])
    assert.throws(
      () =>
        observationSteps([{ file: { path, fault: 'remove' } }], {
          files: true,
        }),
      /relative path inside the --files directory/,
      path,
    )
  assert.throws(
    () =>
      observationSteps([{ file: { path: 'a.dll', fault: 'delete' } }], {
        files: true,
      }),
    /fault must be remove, truncate, corrupt/,
  )
  assert.throws(
    () =>
      observationSteps([{ file: { path: 'a.dll', fault: 'remove', at: 1 } }], {
        files: true,
      }),
    /Unsupported steps\[0\]\.file property: at/,
  )
})

test('expect steps wait 15 s unless told otherwise', () => {
  assert.deepEqual(
    observationSteps([
      { expect: '#repairing' },
      { expect: { role: 'alert' }, timeoutMs: 500, name: 'alert' },
    ]),
    [
      { kind: 'expect', target: '#repairing', timeoutMs: 15000 },
      {
        kind: 'expect',
        target: { role: 'alert' },
        timeoutMs: 500,
        name: 'alert',
      },
    ],
  )
})

test('runs file steps through the control', async () => {
  const calls = []
  const steps = observationSteps(
    [{ file: { path: 'a.dll', fault: 'remove' } }, { wait: 0 }],
    { files: true },
  )
  const results = await runSteps(
    fake({}),
    steps,
    runOptions({
      damage: async (path, fault, step) => calls.push([path, fault, step]),
    }),
  )
  assert.deepEqual(calls, [['a.dll', 'remove', 0]])
  assert.ok(results.every((result) => result.status === 'done'))
  await assert.rejects(
    runSteps(fake({}), steps, runOptions(undefined)),
    /FILE_CONTROL_MISSING/,
  )
})

test('damages files and reports what the app did with them', async () => {
  const original = Buffer.alloc(10_000, 7)
  const directory = await installation({
    'restored.dll': original,
    'untouched.pak': original,
    'rewritten.bin': original,
    'deleted.pak': original,
  })
  try {
    const damage = new FileFaults(directory)
    await damage.damage('restored.dll', 'remove', 0)
    await damage.damage('untouched.pak', 'truncate', 1)
    await damage.damage('rewritten.bin', 'corrupt', 2)
    await damage.damage('deleted.pak', 'truncate', 3)

    await assert.rejects(stat(join(directory, 'restored.dll')))
    assert.equal((await stat(join(directory, 'untouched.pak'))).size, 5_000)
    const corrupted = await readFile(join(directory, 'rewritten.bin'))
    assert.equal(corrupted.length, original.length)
    assert.notDeepEqual(corrupted, original)
    assert.deepEqual([...damage.damaged()].sort(), [
      'deleted.pak',
      'restored.dll',
      'rewritten.bin',
      'untouched.pak',
    ])
    await assert.rejects(
      damage.damage('untouched.pak', 'corrupt', 4),
      /FILE_ALREADY_DAMAGED: step 1/,
    )
    await assert.rejects(
      damage.damage('../outside.dll', 'remove', 5),
      /FILE_OUTSIDE_DIRECTORY/,
    )
    await assert.rejects(
      damage.damage('missing.dll', 'remove', 6),
      /FILE_NOT_FOUND/,
    )

    // What the app does in the meantime.
    await writeFile(join(directory, 'restored.dll'), original)
    await writeFile(join(directory, 'rewritten.bin'), 'a newer version')
    await unlink(join(directory, 'deleted.pak'))

    const evidence = await damage.finish()
    assert.deepEqual(evidence.faults, [
      { step: 0, fault: 'remove', outcome: 'repaired' },
      { step: 1, fault: 'truncate', outcome: 'damaged', restored: true },
      { step: 2, fault: 'corrupt', outcome: 'changed' },
      { step: 3, fault: 'truncate', outcome: 'changed', restored: true },
    ])
    assert.deepEqual(evidence.paths, [
      { step: 0, path: 'restored.dll' },
      { step: 1, path: 'untouched.pak' },
      { step: 2, path: 'rewritten.bin' },
      { step: 3, path: 'deleted.pak' },
    ])
    // Files the app left damaged or missing are put back; one it rewrote is left alone.
    assert.deepEqual(await readFile(join(directory, 'untouched.pak')), original)
    assert.deepEqual(await readFile(join(directory, 'deleted.pak')), original)
    assert.equal(
      await readFile(join(directory, 'rewritten.bin'), 'utf8'),
      'a newer version',
    )
    assert.equal(
      fileFaultSummary(evidence.faults[1]),
      'Step 1: the file the step truncated was still truncated when the capture ended; Recovery Probe put it back',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an empty file can be removed but not truncated or corrupted', async () => {
  const directory = await installation({ 'empty.txt': '' })
  try {
    const damage = new FileFaults(directory)
    await assert.rejects(
      damage.damage('empty.txt', 'truncate', 0),
      /FILE_EMPTY: an empty file cannot be truncated/,
    )
    await damage.damage('empty.txt', 'remove', 1)
    const evidence = await damage.finish()
    assert.deepEqual(evidence.faults, [
      { step: 1, fault: 'remove', outcome: 'damaged', restored: true },
    ])
    assert.equal((await stat(join(directory, 'empty.txt'))).size, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file that cannot be checked keeps its original, and the report gets only the error code', async () => {
  const directory = await installation({ 'api.dll': 'original' })
  let backup
  try {
    const damage = new FileFaults(directory)
    await damage.damage('api.dll', 'remove', 0)
    // What the app put in its place cannot be read as a file.
    await mkdir(join(directory, 'api.dll'))

    const evidence = await damage.finish()
    backup = evidence.paths[0].backup

    assert.deepEqual(evidence.faults, [
      { step: 0, fault: 'remove', error: 'EISDIR' },
    ])
    assert.match(evidence.paths[0].error, /EISDIR/)
    assert.equal(await readFile(backup, 'utf8'), 'original')
  } finally {
    await rm(directory, { recursive: true, force: true })
    if (backup) await rm(dirname(backup), { recursive: true, force: true })
  }
})

test('files the steps damaged are left out of the snapshot comparison', () => {
  const snapshot = (entries) => ({
    files: new Map(entries),
    truncated: false,
  })
  const evidence = fileEvidence(
    [
      {
        interval: 1,
        snapshot: snapshot([
          ['api.dll', 100],
          ['content.pak', 100],
        ]),
      },
      { interval: 0, snapshot: snapshot([]) },
    ],
    new Set(['api.dll']),
  )
  assert.equal(evidence.intervals[0].removed, 1)
  assert.deepEqual(evidence.paths[0].removed, ['content.pak'])
})

/** @returns {import('../../dist/workflows/observe/report.mjs').ObservationReport} */
const capture = () =>
  fake({
    status: 'complete',
    captureComplete: true,
    coverage: { gaps: [] },
    intervals: [
      { index: 1, startMs: 0, samples: 1, findings: [] },
      { index: 2, startMs: 5_000, samples: 1, findings: [] },
    ],
    findings: [],
    operator: {
      status: 'complete',
      steps: [
        { index: 0, kind: 'mark', startedMs: 4_900, status: 'done' },
        { index: 1, kind: 'file', startedMs: 5_100, status: 'done' },
        {
          index: 2,
          kind: 'expect',
          name: 'repairing',
          startedMs: 5_200,
          endedMs: 20_200,
          status: 'unmet',
        },
      ],
    },
  })

test('a file the app did not restore is LOCAL_FILE_NOT_REPAIRED in its step’s interval', () => {
  const report = capture()
  applyFileFaultEvidence(report, {
    faults: [{ step: 1, fault: 'remove', outcome: 'damaged', restored: true }],
    paths: [],
  })
  assert.equal(report.mode, 'observation with file faults')
  assert.deepEqual(
    report.findings.map(({ code, interval }) => [code, interval]),
    [['LOCAL_FILE_NOT_REPAIRED', 2]],
  )
  assert.match(
    report.findings[0].summary,
    /^Step 1: the file the step removed was still missing/,
  )
  assert.deepEqual(report.intervals[1].findings, ['LOCAL_FILE_NOT_REPAIRED'])
  assert.equal(report.captureComplete, true)

  const repaired = capture()
  applyFileFaultEvidence(repaired, {
    faults: [{ step: 1, fault: 'remove', outcome: 'repaired' }],
    paths: [],
  })
  assert.deepEqual(repaired.findings, [])

  const kept = capture()
  applyFileFaultEvidence(kept, {
    faults: [{ step: 1, fault: 'corrupt', error: 'EBUSY' }],
    paths: [],
  })
  assert.deepEqual(kept.coverage.gaps, ['FILE_FAULTS_NOT_RESTORED'])
  assert.equal(kept.captureComplete, false)
})

test('an expect step that saw nothing is EXPECTATION_NOT_MET', () => {
  const report = capture()
  applyExpectationEvidence(report)
  assert.deepEqual(report.findings, [
    {
      code: 'EXPECTATION_NOT_MET',
      basis: 'SCRIPTED_EXPECTATION',
      interval: 2,
      summary: 'Step 2 (expect ‘repairing’) saw no visible match in 15.0 s.',
    },
  ])
  assert.deepEqual(report.intervals[1].findings, ['EXPECTATION_NOT_MET'])
})

test('a damage that fails is not reported, and the file is left as it was', async (t) => {
  const directory = await installation({})
  const locked = join(directory, 'locked')
  await mkdir(locked)
  await writeFile(join(locked, 'api.dll'), 'original')
  // A read-only file on Windows, and a read-only folder elsewhere, refuse the removal.
  await chmod(join(locked, 'api.dll'), 0o444)
  await chmod(locked, 0o555)
  try {
    const damage = new FileFaults(directory)
    const failed = await damage.damage('locked/api.dll', 'remove', 0).then(
      () => false,
      () => true,
    )
    if (!failed) {
      // Puts the file back and removes the backup.
      await damage.finish()
      t.skip('this platform let the removal through')
      return
    }
    assert.deepEqual(await damage.finish(), { faults: [], paths: [] })
    assert.equal(await readFile(join(locked, 'api.dll'), 'utf8'), 'original')
  } finally {
    await chmod(locked, 0o755)
    await chmod(join(locked, 'api.dll'), 0o644).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
