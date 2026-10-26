import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

// Per-run data rather than structure: samples over time and content fingerprint counts.
const VOLATILE = new Set(['timeline', 'distributions'])

// Reads are keyed by endpoint, whose port changes from run to run.
const fieldName = (key) => (key.includes('://') ? '<url>' : key)

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The fields all of `objects` have, each with its values. */
function commonFields(objects) {
  const fields = new Map()
  for (const key of Object.keys(objects[0] ?? {}))
    if (objects.every((object) => Object.hasOwn(object, key)))
      fields.set(fieldName(key), [
        ...(fields.get(fieldName(key)) ?? []),
        ...objects.map((object) => object[key]),
      ])
  return fields
}

/**
 * The field paths of a report. Array elements are merged and keep only the fields all
 * of them have, since optional fields depend on timing.
 */
export function reportPaths(report) {
  const paths = new Set()
  const visit = (values, path) => {
    paths.add(path)
    for (const [key, fieldValues] of commonFields(values.filter(isObject)))
      if (VOLATILE.has(key)) paths.add(`${path}.${key}`)
      else visit(fieldValues, `${path}.${key}`)
    const items = values.filter(Array.isArray).flat()
    if (items.length) visit(items, `${path}[]`)
  }
  visit([report], '$')
  return [...paths].sort()
}

/**
 * Fails when a report lacks a field listed in test/fixtures/report-shapes/NAME.json, so
 * restructuring a workflow cannot drop or rename one unnoticed. With
 * UPDATE_REPORT_SHAPES=1 the file keeps only the paths this run also produced; delete
 * it first to record new fields.
 */
export async function assertReportShape(report, name) {
  const file = new URL(
    `../fixtures/report-shapes/${name}.json`,
    import.meta.url,
  )
  const paths = reportPaths(report)
  const recorded = await readFile(file, 'utf8').then(JSON.parse, () => null)
  if (process.env.UPDATE_REPORT_SHAPES) {
    const kept = recorded
      ? recorded.filter((path) => paths.includes(path))
      : paths
    await writeFile(file, JSON.stringify(kept, null, 2) + '\n')
    return
  }
  assert.ok(
    recorded,
    `No recorded shape for ${name}; run with UPDATE_REPORT_SHAPES=1`,
  )
  const missing = recorded.filter((path) => !paths.includes(path))
  assert.deepEqual(
    missing,
    [],
    `The ${name} report lacks fields it used to have. If that is intended, rerun with UPDATE_REPORT_SHAPES=1 and review the fixture diff.`,
  )
}
