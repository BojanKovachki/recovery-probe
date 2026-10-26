import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE_SCHEMA,
  evidenceOf,
  kindOf,
  withEvidence,
} from '../../dist/reports/evidence.mjs'
import { compareRuns, runEvidence } from '../../dist/tools/compare.mjs'

const check = (mode, outcome) => ({
  mode,
  endpoint: 'http://127.0.0.1:3000/api/profile',
  results: [
    {
      kind: 'http-error',
      outcome,
      code: outcome === 'pass' ? 'RECOVERED' : 'RECOVERY_NOT_OBSERVED',
    },
  ],
})
const discovery = (findings) => ({
  mode: 'experimental IPC discovery',
  channel: 'files:read',
  findings: findings.map(([id, classification, kind]) => ({
    id,
    fault: 'rejection',
    classification,
    kind,
  })),
})
const compare = (before, after) =>
  compareRuns([runEvidence(before)], [runEvidence(after)])

test('reports name what they ran, from their evidence or their older mode', () => {
  assert.deepEqual(kindOf({ mode: 'HTTP discovery' }), {
    workflow: 'discover',
    transport: 'http',
  })
  assert.deepEqual(
    kindOf({ mode: 'fault-free observation', transport: 'ipc' }),
    { workflow: 'observe', transport: 'ipc' },
  )
  assert.equal(kindOf({ mode: 'something else' }), undefined)
  const written = withEvidence(check('desktop renderer recovery', 'fail'), {
    workflow: 'check',
    transport: 'http',
  })
  assert.equal(written.evidence.schema, EVIDENCE_SCHEMA)
  assert.deepEqual(written.evidence.problems, [
    { code: 'RECOVERY_NOT_OBSERVED', scope: 'http-error', severity: 'defect' },
  ])
  assert.equal(written.evidence.target, 'http://127.0.0.1:3000/api/profile')
  const unknown = { variant: 'broken' }
  assert.equal(withEvidence(unknown), unknown)
})

test('compare reads the evidence a report carries', () => {
  const report = {
    ...check('desktop renderer recovery', 'pass'),
    evidence: {
      ...evidenceOf(check('desktop renderer recovery', 'pass')),
      problems: [{ code: 'FROM_EVIDENCE', severity: 'lead' }],
    },
  }
  assert.deepEqual(runEvidence(report).problems, [
    { code: 'FROM_EVIDENCE', severity: 'lead' },
  ])
})

test('checks over the same transport compare, whatever their old label', () => {
  const result = compare(
    check('desktop renderer recovery', 'fail'),
    check('attached browser recovery', 'pass'),
  )
  assert.equal(result.verdict, 'IMPROVED')
  const refresh = {
    mode: 'refresh experiment',
    trigger: { name: 'online' },
    findings: [],
  }
  assert.deepEqual(
    compare(
      refresh,
      withEvidence(refresh, { workflow: 'refresh', transport: 'http' }),
    ).mismatch,
    [],
  )
  assert.equal(
    compare(
      check('IPC renderer recovery', 'pass'),
      check('web recovery', 'pass'),
    ).verdict,
    'NOT_COMPARABLE',
  )
})

test('experiments that fail the same fault in different ways stay apart', () => {
  const result = compare(
    discovery([
      ['rejection-1', 'RECOVERED', 'observation'],
      ['rejection-2', 'SILENT_EMPTY', 'suspected-defect'],
    ]),
    discovery([
      ['rejection-1', 'SILENT_EMPTY', 'suspected-defect'],
      ['rejection-2', 'RECOVERED', 'observation'],
    ]),
  )
  assert.deepEqual(
    result.changes.map((c) => `${c.status} ${c.code} ${c.scope}`).sort(),
    ['GONE SILENT_EMPTY rejection-2', 'NEW SILENT_EMPTY rejection-1'],
  )
})

test('an expect step the app did not meet is a failed check; other observation findings are leads', () => {
  const observation = (codes) => ({
    mode: 'observation with file faults',
    transport: 'ipc',
    status: 'complete',
    captureComplete: true,
    coverage: { gaps: [] },
    findings: codes.map((code) => ({ code, interval: 2 })),
  })
  assert.deepEqual(
    evidenceOf(
      observation([
        'EXPECTATION_NOT_MET',
        'LOCAL_FILE_NOT_REPAIRED',
        'DELAYED_UI_UPDATE',
      ]),
    ).problems,
    [
      { code: 'EXPECTATION_NOT_MET', severity: 'defect' },
      { code: 'LOCAL_FILE_NOT_REPAIRED', severity: 'lead' },
      { code: 'DELAYED_UI_UPDATE', severity: 'lead' },
    ],
  )
  const fixed = compare(
    observation(['EXPECTATION_NOT_MET', 'LOCAL_FILE_NOT_REPAIRED']),
    observation([]),
  )
  assert.equal(fixed.verdict, 'IMPROVED')
})
