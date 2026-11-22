import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordBaseline,
  verifyChange,
  verifyPlan,
} from '../../dist/tools/verify.mjs'

/** The fields verify reported before claims were added; plan mode must keep them as they were. */
export const OLD_FIELDS = [
  'verdict',
  'exitCode',
  'reasons',
  'checks',
  'suspects',
  'directory',
  'markdown',
]

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
  })

const action = (classification, kind) =>
  JSON.stringify({
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: 'contacts:add',
    findings: [{ classification, kind }],
  })

const runner = (reports) => async (args) => {
  const folder = args[args.indexOf('--out') + 1]
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'report.json'), reports.shift())
  return { exitCode: 0, output: 'checked\n' }
}

const plan = (config = 'a.json') =>
  verifyPlan({
    base: 'main',
    runs: 2,
    checks: [{ name: 'add', command: ['action', '--config', config] }],
  })

const twice = (classification, kind) => [
  action(classification, kind),
  action(classification, kind),
]

/**
 * Runs one fixed sequence of verifications in a new repository: a fix, a regression, an
 * incomplete run, a changed check and a new suspect. Each result is reduced to `fields`,
 * with the repository's path replaced by <root>, so runs on any machine compare equal.
 */
export async function goldenSequence(fields = OLD_FIELDS) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-probe-golden-')),
  )
  git(root, 'init', '-q', '-b', 'main')
  await mkdir(join(root, 'src'))
  const store = 'export const a = 1\nexport const b = 2\n'
  await writeFile(join(root, 'src', 'store.ts'), store)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'start')
  const previous = process.cwd()
  process.chdir(root)
  try {
    const directory = join(root, '.recovery-probe', 'verify')
    const verify = (reports, config) =>
      verifyChange({
        plan: plan(config),
        directory,
        runCommand: runner(reports),
      })
    await recordBaseline({
      plan: plan(),
      directory,
      runCommand: runner(twice('SILENT_FAILURE', 'suspected-defect')),
    })
    const results = [
      await verify(twice('FEEDBACK_SHOWN', 'observation')),
      await verify(twice('DUPLICATE_SUBMIT', 'suspected-defect')),
      await verify([
        action('FEEDBACK_SHOWN', 'observation'),
        action('FAULT_NOT_TRIGGERED', 'inconclusive'),
      ]),
      await verify(twice('FEEDBACK_SHOWN', 'observation'), 'b.json'),
    ]
    await writeFile(
      join(root, 'src', 'store.ts'),
      `${store}export const rows = async () => (await load()) ?? []\n`,
    )
    results.push(await verify(twice('FEEDBACK_SHOWN', 'observation')))
    return results.map((result) => normalized(result, fields, root))
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

function normalized(result, fields, root) {
  const picked = Object.fromEntries(fields.map((key) => [key, result[key]]))
  let text = JSON.stringify(picked)
  for (const path of [root, root.split('\\').join('/')])
    text = text.split(JSON.stringify(path).slice(1, -1)).join('<root>')
  return JSON.parse(text.split('\\\\').join('/'))
}
