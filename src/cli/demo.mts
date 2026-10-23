import type { Values } from './args.mjs'
import { runBrowserCheck } from './runner.mjs'

export const usage = `recovery-probe demo [--out DIR] [--json]

Runs two versions of a small app in headless Chromium. Both load fine; only the
fixed one survives a 503, a dropped connection and a broken JSON response. Exits
with 0 only when it sees exactly that.

Options:
  --out DIR   a new folder for report.json
  --json      print the report as JSON`

export const options = {
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const

export const run = (values: Values) => runBrowserCheck('demo', values)
