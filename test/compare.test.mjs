import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compareRuns, compareReports, runEvidence } from '../dist/compare.mjs'

const action = (findings, extra = {}) => ({
  schemaVersion: 1,
  mode: 'IPC action check',
  channel: 'contacts:add',
  findings: findings.map(([classification, kind]) => ({
    classification,
    kind,
  })),
  ok: true,
  limitation: 'One scripted action.',
  ...extra,
})
const discovery = (findings, extra = {}) => ({
  schemaVersion: 2,
  mode: 'experimental IPC discovery',
  channel: 'rooms:list',
  findings: findings.map(([classification, kind, fault]) => ({
    classification,
    kind,
    fault,
  })),
  ...extra,
})
const observation = (codes, extra = {}) => ({
  schemaVersion: 1,
  mode: 'fault-free observation',
  target: 'downloads:list',
  status: 'complete',
  captureComplete: true,
  coverage: { gaps: [], scope: 'One renderer.' },
  findings: codes.map((code) => ({ code, kind: 'observation' })),
  ...extra,
})
const check = (rows, extra = {}) => ({
  schemaVersion: 1,
  mode: 'desktop renderer recovery',
  endpoint: 'http://127.0.0.1:3000/api/profile',
  results: rows.map(([kind, outcome, code]) => ({ kind, outcome, code })),
  ...extra,
})
const compare = (before, after, labels) =>
  compareRuns(
    before.map((report) => runEvidence(report)),
    after.map((report) => runEvidence(report)),
    labels,
  )
const changes = (comparison) =>
  comparison.changes.map(
    (c) => `${c.status} ${c.code}${c.scope ? ` ${c.scope}` : ''}`,
  )

test('shows problems a change removed', () => {
  const result = compare(
    [
      action([
        ['SILENT_FAILURE', 'suspected-defect'],
        ['DUPLICATE_SUBMIT', 'suspected-defect'],
      ]),
    ],
    [
      action([
        ['FEEDBACK_SHOWN', 'observation'],
        ['SINGLE_SUBMIT', 'observation'],
      ]),
    ],
  )
  assert.equal(result.verdict, 'IMPROVED')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(changes(result), [
    'GONE SILENT_FAILURE',
    'GONE DUPLICATE_SUBMIT',
  ])
  assert.deepEqual(result.outcomes.after, ['FEEDBACK_SHOWN', 'SINGLE_SUBMIT'])
})

test('never reads a run that stopped early as a fix', () => {
  const before = discovery([['CONTENT_LOSS', 'suspected-defect', 'rejection']])
  for (const after of [
    discovery([], {
      error: 'BASELINE_UNSTABLE: automatic text comparison is unsuitable',
    }),
    discovery([['INCOMPLETE_EXPERIMENT', 'inconclusive', 'rejection']]),
    discovery([['RECOVERED', 'observation', 'rejection']], {
      failedControl: {},
    }),
  ]) {
    const result = compare([before], [after])
    assert.equal(result.verdict, 'INCONCLUSIVE')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(changes(result), ['UNVERIFIED CONTENT_LOSS rejection'])
    assert.match(result.summary, /no run after the change completed/)
  }
  // A problem still counts as found in a run that stopped early.
  const stillThere = compare(
    [before],
    [
      discovery([['CONTENT_LOSS', 'suspected-defect', 'rejection']], {
        error: 'CLEANUP_FAILED',
      }),
    ],
  )
  assert.equal(stillThere.verdict, 'UNCHANGED')
  assert.equal(stillThere.exitCode, 2)
})

test('counts repeated runs, and only complete ones as showing a problem gone', () => {
  const before = [1, 2, 3].map(() => observation(['DELAYED_UI_UPDATE']))
  const result = compare(
    before,
    [1, 2, 3].map(() => observation([])),
  )
  assert.equal(result.verdict, 'IMPROVED')
  assert.deepEqual(result.changes[0].before, { found: 3, runs: 3, checked: 3 })
  assert.deepEqual(result.changes[0].after, { found: 0, runs: 3, checked: 3 })

  const gap = observation([], { coverage: { gaps: ['HIDDEN_DOCUMENT'] } })
  const partial = compare(before, [observation([]), gap])
  assert.equal(partial.verdict, 'IMPROVED')
  assert.equal(partial.changes[0].after.checked, 1)
  assert.equal(compare(before, [gap]).verdict, 'INCONCLUSIVE')
  assert.equal(
    compare(before, [observation([], { status: 'stopped' })]).verdict,
    'INCONCLUSIVE',
  )
})

test('compares check rows per fault', () => {
  const before = check([
    ['http-error', 'fail', 'RECOVERY_NOT_OBSERVED'],
    ['connection-failure', 'pass', 'RECOVERED'],
  ])
  const fixed = compare(
    [before],
    [
      check([
        ['http-error', 'pass', 'RECOVERED'],
        ['connection-failure', 'pass', 'RECOVERED'],
      ]),
    ],
  )
  assert.equal(fixed.verdict, 'IMPROVED')
  assert.deepEqual(changes(fixed), ['GONE RECOVERY_NOT_OBSERVED http-error'])
  // The fault that failed before was not triggered after: no evidence for it.
  const untriggered = compare(
    [before],
    [
      check([
        ['http-error', 'inconclusive', 'FAULT_NOT_TRIGGERED'],
        ['connection-failure', 'pass', 'RECOVERED'],
      ]),
    ],
  )
  assert.equal(untriggered.verdict, 'INCONCLUSIVE')
  assert.deepEqual(changes(untriggered), [
    'UNVERIFIED RECOVERY_NOT_OBSERVED http-error',
  ])
  assert.deepEqual(untriggered.after[0].gaps, [
    'FAULT_NOT_TRIGGERED (http-error)',
  ])
})

test('reports new problems, and exits 1 only for a new defect', () => {
  const clean = action([['FEEDBACK_SHOWN', 'observation']])
  const defect = compare(
    [clean],
    [action([['SILENT_FAILURE', 'suspected-defect']])],
  )
  assert.equal(defect.verdict, 'REGRESSED')
  assert.equal(defect.exitCode, 1)
  const lead = compare(
    [clean],
    [action([['UNCLEAR_FEEDBACK', 'decision-needed']])],
  )
  assert.equal(lead.verdict, 'REGRESSED')
  assert.equal(lead.exitCode, 2)
  const mixed = compare(
    [action([['SILENT_FAILURE', 'suspected-defect']])],
    [action([['DUPLICATE_SUBMIT', 'suspected-defect']])],
  )
  assert.equal(mixed.verdict, 'MIXED')
  assert.equal(mixed.exitCode, 1)
  const partly = compare(
    [
      action([
        ['SILENT_FAILURE', 'suspected-defect'],
        ['DUPLICATE_SUBMIT', 'suspected-defect'],
      ]),
    ],
    [action([['DUPLICATE_SUBMIT', 'suspected-defect']])],
  )
  assert.equal(partly.verdict, 'PARTLY_IMPROVED')
  assert.equal(partly.exitCode, 2)
  assert.deepEqual(changes(partly), [
    'STILL DUPLICATE_SUBMIT',
    'GONE SILENT_FAILURE',
  ])
})

test('says when neither side showed a problem', () => {
  const result = compare([observation([])], [observation([])])
  assert.equal(result.verdict, 'UNCHANGED')
  assert.equal(result.exitCode, 0)
  assert.match(result.summary, /no evidence of a fix/)
})

test('refuses to compare different checks', () => {
  const other = compare(
    [action([['SILENT_FAILURE', 'suspected-defect']])],
    [action([], { channel: 'contacts:remove' })],
  )
  assert.equal(other.verdict, 'NOT_COMPARABLE')
  assert.equal(other.exitCode, 2)
  assert.match(other.summary, /contacts:add and contacts:remove/)
  assert.equal(
    compare([observation([])], [action([])]).verdict,
    'NOT_COMPARABLE',
  )
  assert.throws(
    () => runEvidence({ variant: 'broken' }, 'ci.json'),
    /ci.json is not a Recovery Probe report/,
  )
})

test('writes a Markdown block for a pull request', () => {
  const { markdown } = compare(
    [action([['SILENT_FAILURE', 'suspected-defect']])],
    [action([['FEEDBACK_SHOWN', 'observation']])],
    { before: 'main', after: 'this branch' },
  )
  assert.match(markdown, /IPC action check · `contacts:add`/)
  assert.ok(markdown.includes('| Problem | main | this branch | Change |'))
  assert.ok(
    markdown.includes(
      '| `SILENT_FAILURE`, suspected defect | 1 of 1 run | none in 1 complete run | gone |',
    ),
  )
  assert.ok(
    markdown.includes(
      'Other outcomes: main none; this branch `FEEDBACK_SHOWN`.',
    ),
  )
  assert.ok(markdown.includes('**Improved:** 1 problem gone'))
  assert.ok(markdown.includes('Covers only this check. One scripted action.'))
})

test('reads report folders and runs from the command line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-compare-'))
  const cli = fileURLToPath(
    new URL('../bin/recovery-probe.mjs', import.meta.url),
  )
  const run = (args) =>
    promisify(execFile)(process.execPath, [cli, 'compare', ...args], {
      cwd: root,
    }).then(
      (result) => ({ code: 0, ...result }),
      (error) => ({
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      }),
    )
  try {
    await mkdir(join(root, 'before'))
    await writeFile(
      join(root, 'before', 'report.json'),
      JSON.stringify(action([['SILENT_FAILURE', 'suspected-defect']])),
    )
    // An action report without conclusive findings is not a complete run.
    await writeFile(join(root, 'after.json'), JSON.stringify(action([])))
    assert.equal(
      (await compareReports([join(root, 'before')], [join(root, 'after.json')]))
        .verdict,
      'INCONCLUSIVE',
    )
    await writeFile(
      join(root, 'after.json'),
      JSON.stringify(action([['FEEDBACK_SHOWN', 'observation']])),
    )
    const text = await run(['--before', 'before', '--after', 'after.json'])
    assert.equal(text.code, 0)
    assert.match(text.stdout, /IMPROVED: 1 problem gone/)
    const markdown = await run([
      '--before',
      'before',
      '--after',
      'after.json',
      '--markdown',
      '--after-label',
      'fix',
    ])
    assert.ok(markdown.stdout.includes('| Problem | before | fix | Change |'))
    // A folder of run folders stands for repeated runs.
    for (const [side, findings] of [
      ['main', [['SILENT_FAILURE', 'suspected-defect']]],
      ['branch', [['FEEDBACK_SHOWN', 'observation']]],
    ])
      for (const name of ['run-1', 'run-2']) {
        await mkdir(join(root, side, name), { recursive: true })
        await writeFile(
          join(root, side, name, 'report.json'),
          JSON.stringify(action(findings)),
        )
      }
    const repeated = await compareReports(
      [join(root, 'main')],
      [join(root, 'branch')],
    )
    assert.equal(repeated.verdict, 'IMPROVED')
    assert.deepEqual(repeated.changes[0].before, {
      found: 2,
      runs: 2,
      checked: 2,
    })
    await mkdir(join(root, 'empty'))
    await assert.rejects(
      compareReports([join(root, 'empty')], [join(root, 'branch')]),
      /No report.json in/,
    )
    const regressed = await run(['--before', 'after.json', '--after', 'before'])
    assert.equal(regressed.code, 1)
    const oneSide = await run(['--before', 'before'])
    assert.equal(oneSide.code, 2)
    assert.match(oneSide.stderr, /Give reports on both sides/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
