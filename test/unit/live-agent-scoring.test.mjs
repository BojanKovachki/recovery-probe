import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unavailable } from '../../evaluations/live-agent/harness/attempt.mjs'
import { markdownSummary } from '../../evaluations/live-agent/harness/report.mjs'
import {
  aggregate,
  scoreAttempt,
} from '../../evaluations/live-agent/harness/score.mjs'
import {
  events,
  summarize,
} from '../../evaluations/live-agent/harness/transcript.mjs'

const APP_SOURCE = ['public/', 'data/', 'docs/', 'server.mjs', 'package.json']
const FIX = { kind: 'fix', required: ['keeps-orders'] }
const CONTROL = { kind: 'control', required: ['empty-state'] }
const CLARIFY = { kind: 'clarify', required: [] }

const pass = { pass: true }
const fail = { pass: false, detail: 'no' }
const grade = (required, regression = { other: pass }) => ({
  required,
  regression,
})
const attempt = (status, changedPaths = [], execution = {}) => ({
  report: status ? { status, summary: '' } : null,
  changedPaths,
  outsideReach: [],
  execution: { exitCode: 0, timedOut: false, error: null, ...execution },
})

test('a fix succeeds only when the required behavior holds without regressions', () => {
  const fixed = scoreAttempt(
    FIX,
    attempt('fixed', ['public/src/store.js']),
    grade({ 'keeps-orders': pass }),
    APP_SOURCE,
  )
  assert.equal(fixed.success, true)
  assert.equal(fixed.fixed, true)
  assert.equal(fixed.incorrectClaim, false)

  const regressed = scoreAttempt(
    FIX,
    attempt('fixed'),
    grade({ 'keeps-orders': pass }, { other: fail }),
    APP_SOURCE,
  )
  assert.equal(regressed.success, false)
  assert.equal(regressed.fixed, true)
  assert.deepEqual(regressed.regressions, ['other'])
  assert.equal(regressed.incorrectClaim, true, '"fixed" with a regression')

  const notFixed = scoreAttempt(
    FIX,
    attempt('fixed'),
    grade({ 'keeps-orders': fail }),
    APP_SOURCE,
  )
  assert.equal(notFixed.incorrectClaim, true)
  assert.equal(
    scoreAttempt(
      FIX,
      attempt('not_fixed'),
      grade({ 'keeps-orders': fail }),
      APP_SOURCE,
    ).incorrectClaim,
    false,
  )
  assert.equal(
    scoreAttempt(
      FIX,
      attempt('no_change_needed'),
      grade({ 'keeps-orders': fail }),
      APP_SOURCE,
    ).incorrectClaim,
    true,
    'calling a defective app fine',
  )
})

test('the control succeeds without source changes; claiming a fix there is incorrect', () => {
  const untouched = scoreAttempt(
    CONTROL,
    attempt('no_change_needed', ['notes.md']),
    grade({ 'empty-state': pass }),
    APP_SOURCE,
  )
  assert.equal(untouched.success, true)
  assert.equal(untouched.unnecessaryChange, false)

  const changed = scoreAttempt(
    CONTROL,
    attempt('fixed', [
      'public/src/notifications.js',
      'data/notifications.json',
    ]),
    grade({ 'empty-state': pass }),
    APP_SOURCE,
  )
  assert.equal(changed.success, false)
  assert.equal(changed.unnecessaryChange, true)
  assert.deepEqual(changed.sourceChanges, [
    'public/src/notifications.js',
    'data/notifications.json',
  ])
  assert.equal(changed.incorrectClaim, true)
})

test('the ambiguous task succeeds by asking, without regressions', () => {
  const asked = scoreAttempt(
    CLARIFY,
    attempt('needs_clarification'),
    grade({}),
    APP_SOURCE,
  )
  assert.equal(asked.success, true)
  assert.equal(asked.clarified, true)
  const guessed = scoreAttempt(
    CLARIFY,
    attempt('fixed', ['public/src/sync.js']),
    grade({}),
    APP_SOURCE,
  )
  assert.equal(guessed.success, false)
  assert.equal(guessed.incorrectClaim, true)
})

test('a timed-out attempt stays in the results without a claim', () => {
  const timedOut = scoreAttempt(
    FIX,
    attempt(null, ['public/src/store.js'], { timedOut: true, exitCode: null }),
    grade({ 'keeps-orders': pass }),
    APP_SOURCE,
  )
  assert.equal(timedOut.execution, 'timed-out')
  assert.equal(timedOut.status, null)
  assert.equal(timedOut.incorrectClaim, false)
  assert.equal(timedOut.success, true, 'its code is graded as it was left')
  assert.equal(
    scoreAttempt(
      FIX,
      attempt(null, [], { exitCode: 1 }),
      grade({ 'keeps-orders': fail }),
      APP_SOURCE,
    ).execution,
    'failed',
  )
})

test('results are counted per task and condition, with medians of what was measured', () => {
  const scored = (task, condition, success, minutes, calls = 0) => ({
    task,
    condition,
    metrics: {
      durationMs: minutes * 60000,
      wallMs: minutes * 60000,
      turns: 10,
      costUsd: 1,
      outputTokens: 100,
      recoveryProbeCalls: calls,
    },
    score: scoreAttempt(
      FIX,
      attempt(success ? 'fixed' : 'not_fixed'),
      grade({ 'keeps-orders': success ? pass : fail }),
      APP_SOURCE,
    ),
  })
  const summary = aggregate([
    scored('t', 'A', true, 4),
    scored('t', 'A', false, 8),
    scored('t', 'B', true, 6, 3),
  ])
  const a = summary.find((row) => row.condition === 'A')
  assert.equal(a.attempts, 2)
  assert.equal(a.successes, 1)
  assert.equal(a.medianMinutes, 6)
  assert.equal(
    summary.find((row) => row.condition === 'B').medianRecoveryProbeCalls,
    3,
  )

  const markdown = markdownSummary(
    {
      id: 'p',
      tasks: ['t'],
      repetitions: 2,
      agent: { version: '1', model: 'm', minutes: 20, maxTurns: 5 },
      recoveryProbe: 'x',
    },
    [{ id: '01-t-A1', order: 1, ...scored('t', 'A', true, 4) }],
    summary,
  )
  assert.match(markdown, /not conclusive statistical evidence/)
  assert.match(markdown, /\| t \| A \| 1\/2 \|/)
})

test('a transcript gives the final report, its cost and the tools used', () => {
  const lines = [
    { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__recovery-probe__self_check_scenarios',
            input: {},
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 120000,
      num_turns: 7,
      total_cost_usd: 0.42,
      usage: { input_tokens: 10, output_tokens: 20 },
      structured_output: { status: 'fixed', summary: 'Kept the rows.' },
    },
  ]
  const { report, metrics, resultSubtype } = summarize(
    events(
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`,
    ),
  )
  assert.deepEqual(report, { status: 'fixed', summary: 'Kept the rows.' })
  assert.equal(resultSubtype, 'success')
  assert.equal(metrics.turns, 7)
  assert.equal(metrics.costUsd, 0.42)
  assert.equal(metrics.toolCalls, 2)
  assert.equal(metrics.recoveryProbeCalls, 1)
  assert.deepEqual(metrics.tools, {
    Bash: 1,
    'mcp__recovery-probe__self_check_scenarios': 1,
  })
})

test('a session the model service refused is run again; an agent that failed is kept', () => {
  const artifacts = (stderr, transcript = '') => ({
    'stderr.txt': stderr,
    'transcript.jsonl': transcript,
  })
  const record = (exitCode, report = null) => ({
    execution: { exitCode },
    report,
  })
  assert.equal(
    unavailable(record(1), artifacts('API Error: 429 rate_limit_error')),
    true,
  )
  assert.equal(
    unavailable(
      record(1),
      artifacts('', '{"type":"result","result":"Claude usage limit reached"}'),
    ),
    true,
  )
  assert.equal(unavailable(record(1), artifacts('Error: ENOENT')), false)
  assert.equal(
    unavailable(
      record(0, { status: 'fixed' }),
      artifacts('rate limit mentioned in a log'),
    ),
    false,
  )
})
