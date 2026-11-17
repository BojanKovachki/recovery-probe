// The verification-planner evaluation. Each case starts a synthetic project in a temporary Git
// repository: its base is committed, its change applied to the working tree. The planner sees only
// that repository. When it proposes a plan, the baseline is recorded from a checkout of the base
// and the same checks then run against the change. expected.json, which the planner never sees,
// scores the result.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { readRunEvidence } from '../../dist/tools/compare/reports.mjs'
import { freePort, listen } from './ports.mjs'

export const fixtures = fileURLToPath(
  new URL('../fixtures/plan-evaluation/', import.meta.url),
)
const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)
const git = (cwd, args) => promisify(execFile)('git', args, { cwd })

/** The data the synthetic app's reads answer with. */
const API = {
  '/api/profile': { name: 'Synthetic Example' },
  '/api/items': ['Alpha', 'Beta', 'Gamma'],
  '/api/jobs': [
    { id: 'export', name: 'Export', state: 'Running' },
    { id: 'backup', name: 'Backup', state: 'Queued' },
  ],
  '/api/jobs/status': [{ id: 'export', state: 'Done' }],
  '/api/inbox': [],
}

/**
 * Serves the synthetic app from whichever checkout `root` names, read on every request. A read
 * with scripted answers gets them in turn, one per request, starting over after the last.
 */
export async function startApp() {
  let root = ''
  let scripted = {}
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Cache-Control', 'no-store')
    if (path in API) {
      const turn = scripted[path]
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify(
          turn ? turn.answers[turn.calls++ % turn.answers.length] : API[path],
        ),
      )
      return
    }
    const file = path.startsWith('/src/')
      ? join(root, path)
      : join(root, 'public', path)
    try {
      const body = await readFile(file)
      response.writeHead(200, {
        'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  const origin = `http://127.0.0.1:${await listen(server)}`
  const port = await freePort()
  const browser = await chromium.launch({
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ],
  })
  const pages = await Promise.all(
    ['items', 'jobs'].map(() => browser.newPage()),
  )
  return {
    origin,
    cdp: `http://127.0.0.1:${port}`,
    /** A debugging address nothing answers on. */
    closed: `http://127.0.0.1:${await freePort()}`,
    /** Serves `directory` and reloads the open pages, as restarting the app would. */
    async serve(directory, answers = {}) {
      root = directory
      scripted = Object.fromEntries(
        Object.entries(answers).map(([path, list]) => [
          path,
          { answers: list, calls: 0 },
        ]),
      )
      await Promise.all(
        ['items', 'jobs'].map((name, i) =>
          pages[i].goto(`${origin}/${name}.html`),
        ),
      )
    },
    async close() {
      await browser.close()
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
    },
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
}

/** Copies `from`, when it exists, over `to`, filling the app's address into the check configurations. */
export async function overlay(from, to, app) {
  if (!existsSync(from)) return
  for (const file of await filesUnder(from)) {
    const text = (await readFile(join(from, file), 'utf8'))
      .replaceAll('{{origin}}', app.origin)
      .replaceAll('{{cdp}}', app.cdp)
      .replaceAll('{{closed}}', app.closed)
    await mkdir(dirname(join(to, file)), { recursive: true })
    await writeFile(join(to, file), text)
  }
}

/** Runs the CLI in `cwd`; resolves with its exit code and output. */
export function recoveryProbe(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ exitCode, output }))
  })
}

/** Whether a baseline run of any planned check found a problem. */
async function defectBeforeChange(verifyDir, plan) {
  for (const check of plan.checks)
    for (let run = 1; run <= plan.runs; run++) {
      const report = join(
        verifyDir,
        'before',
        check.name,
        `run-${run}`,
        'report.json',
      )
      try {
        if ((await readRunEvidence(report)).problems.length) return true
      } catch {
        // No report: that run could not reproduce anything.
      }
    }
  return false
}

/** Plans the case's change and, when there is a plan, records a baseline from the base and verifies. */
async function runCase(id, app, temp, runs) {
  const repo = join(temp, 'repo')
  await overlay(join(fixtures, 'project'), repo, app)
  await overlay(join(fixtures, 'cases', id, 'base'), repo, app)
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'evaluation@example.invalid'])
  await git(repo, ['config', 'user.name', 'Evaluation'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'Base'])
  await overlay(join(fixtures, 'cases', id, 'change'), repo, app)

  const planned = await recoveryProbe(
    [
      'plan',
      '--changed-since',
      'main',
      '--runs',
      String(runs),
      '--write',
      '.recovery-probe/verify.json',
      '--json',
    ],
    repo,
  )
  const plan = JSON.parse(planned.output)
  const result = { id, planExitCode: planned.exitCode, plan, verify: null }
  if (!plan.candidatePlan) return result

  const base = join(temp, 'base')
  const verifyDir = join(temp, 'verify')
  const planFile = join(repo, '.recovery-probe', 'verify.json')
  await git(repo, ['worktree', 'add', '-q', '--detach', base, 'main'])
  await app.serve(base)
  const baseline = await recoveryProbe(
    ['verify', '--baseline', '--plan', planFile, '--out', verifyDir],
    base,
  )
  await app.serve(repo)
  const verified = await recoveryProbe(
    ['verify', '--plan', planFile, '--out', verifyDir],
    repo,
  )
  result.verify = {
    baselineOutput: baseline.output,
    output: verified.output,
    exitCode: verified.exitCode,
    summary: JSON.parse(
      await readFile(join(verifyDir, 'summary.json'), 'utf8'),
    ),
    defectBeforeChange: await defectBeforeChange(verifyDir, plan.candidatePlan),
  }
  return result
}

const names = (list, key) => [...new Set(list.map((item) => item[key]))].sort()
const same = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** How a case's actual result compares with what expected.json says it should be. */
export function score(result, expected) {
  const { plan, verify } = result
  const selected = names(plan.checks, 'name')
  const actual = {
    selected,
    irrelevantSelected: selected.filter(
      (name) => !expected.relevant.includes(name),
    ),
    suggested: names(plan.suggestions, 'entry'),
    questions: names(
      plan.needsInput.filter((item) => item.kind === 'question'),
      'entry',
    ),
    uncovered: names(plan.uncovered, 'path'),
    defectBeforeChange: verify ? verify.defectBeforeChange : null,
    verdict: verify ? verify.summary.verdict : null,
  }
  const checks = {
    relevantSelected: expected.relevant.every((name) =>
      selected.includes(name),
    ),
    noIrrelevantSelected: actual.irrelevantSelected.length === 0,
    suggestions: same(actual.suggested, expected.suggested),
    questions: same(actual.questions, expected.questions),
    uncovered: same(actual.uncovered, expected.uncovered),
    defectBeforeChange:
      actual.defectBeforeChange === expected.defectBeforeChange,
    verdict: actual.verdict === expected.verdict,
    noFalseVerified: !(
      actual.verdict === 'VERIFIED' && expected.verdict !== 'VERIFIED'
    ),
  }
  return {
    id: result.id,
    actual,
    checks,
    passed: Object.values(checks).every(Boolean),
  }
}

/** Runs every case, or the given ones, and scores each against expected.json. */
export async function evaluatePlanner(ids, { runs = 1 } = {}) {
  const expected = JSON.parse(
    await readFile(join(fixtures, 'expected.json'), 'utf8'),
  )
  const app = await startApp()
  const results = []
  try {
    for (const id of ids ?? Object.keys(expected)) {
      const temp = await mkdtemp(join(tmpdir(), 'rp-plan-eval-'))
      try {
        const result = await runCase(id, app, temp, runs)
        results.push({ ...score(result, expected[id]), result })
      } finally {
        await rm(temp, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  } finally {
    await app.close()
  }
  return results
}
