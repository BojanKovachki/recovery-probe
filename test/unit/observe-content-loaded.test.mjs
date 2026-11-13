import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentLoaded } from '../../dist/workflows/observe/sample.mjs'
import { contentLoadedSummary } from '../../dist/workflows/observe/summaries.mjs'
import { fake } from '../helpers/fake.mjs'

/**
 * A sample at `fromMs` with content fingerprint `content` and its images.
 * @returns {import('../../dist/workflows/observe/report.mjs').TimelineEvent}
 */
const sample = (
  fromMs,
  { content = 'a', total = 2, loaded = 2, failed = 0, shown = true } = {},
) =>
  fake({
    fromMs,
    toMs: fromMs + 50,
    ui: {
      visible: true,
      contentCount: shown ? 1 : 0,
      content: fake({ textFingerprint: content }),
      contentImages: { total, loaded, failed, truncated: false },
    },
  })

test('contentLoaded starts at the latest stretch of unchanged, fully loaded content', () => {
  /** @type {[ReturnType<typeof sample>, number | null][]} */
  const samples = [
    [sample(0, { shown: false }), null],
    [sample(100, { loaded: 1 }), null], // An image is still loading.
    [sample(200), 200],
    [sample(300), 200], // Unchanged.
    [sample(400, { content: 'b', total: 3, loaded: 3 }), 400], // More content, already loaded.
    [sample(500, { content: 'b', total: 3, loaded: 2, failed: 1 }), 400], // A failed image is settled.
    [sample(600, { content: 'c', total: 4, loaded: 3, failed: 0 }), null], // A new image is loading.
  ]
  /** @type {ReturnType<typeof contentLoaded>} */
  let current = null
  let previous
  for (const [event, expectedFromMs] of samples) {
    current = contentLoaded(current, event, previous)
    assert.equal(current?.fromMs ?? null, expectedFromMs, `at ${event.fromMs}`)
    previous = event
  }
})

test('the interval summary tells content that never showed from content still loading', () => {
  /** @param {Partial<import('../../dist/workflows/observe/report.mjs').ObservationInterval>} interval */
  const summary = (interval) =>
    contentLoadedSummary(
      fake({ startMs: 1000, firstContent: null, ...interval }),
    )
  assert.equal(summary({}), null)
  assert.equal(summary({ contentLoaded: null }), 'content not shown')
  assert.equal(
    summary({
      contentLoaded: null,
      firstContent: { fromMs: 1100, toMs: 1150 },
    }),
    'content not fully loaded',
  )
  assert.equal(
    summary({
      contentLoaded: { fromMs: 1600, toMs: 1650, images: 3, failedImages: 1 },
    }),
    'content fully loaded at 600–650 ms (3 images, 1 failed)',
  )
})
