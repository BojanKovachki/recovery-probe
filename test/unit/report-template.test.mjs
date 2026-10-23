import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { escapeHtml, renderTemplate } from '../../dist/report-template.mjs'

const templates = new URL('../../dist/report-templates/', import.meta.url)

test('text slots are escaped and markup slots are inserted as built', () => {
  const ipc = renderTemplate('ipc', {
    heading: '<b>heading</b>',
    limitation: `"quoted" & 'single'`,
    finalReset: 'healthy',
    evidence: '{}',
  })
  assert.match(ipc, /<h1>&lt;b&gt;heading&lt;\/b&gt;<\/h1>/)
  assert.match(ipc, /&quot;quoted&quot; &amp; &#39;single&#39;/)
  const refresh = renderTemplate('refresh', {
    limitation: '',
    results: '<p>built</p>',
    evidence: '{}',
  })
  assert.match(refresh, /<p>built<\/p>/)
})

test('a missing slot fails instead of leaving a placeholder', () => {
  assert.throws(
    () => renderTemplate('ipc', { heading: 'x' }),
    /ipc needs a value for limitation/,
  )
  assert.equal(escapeHtml(undefined), '')
})

test('every template placeholder is well formed', () => {
  for (const file of readdirSync(templates)) {
    const source = readFileSync(new URL(file, templates), 'utf8')
    const slots = Object.fromEntries(
      [...source.matchAll(/\{\{\{?(\w+)\}?\}\}/g)].map(([, slot]) => [
        slot,
        'value',
      ]),
    )
    const html = renderTemplate(file.replace(/\.html$/, ''), slots)
    assert.doesNotMatch(html, /\{\{|\}\}/, file)
  }
})
