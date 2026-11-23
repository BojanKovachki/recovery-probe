// Phase 1: the verifier alone. Each case's fixed patches go through verify with the case's
// policy, in an arm B workspace with no agent, and are scored against their expected outcome.
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from '../../../dist/tools/process.mjs'
import { sessionFolder } from './attempt.mjs'
import { caseEnvironment } from './grading.mjs'
import { git, prepareSession } from './workspace.mjs'

/**
 * @typedef {{ patch: string, expected: { verdict: string, exitCode: number,
 *   reasons?: Record<string, string> } }} FixedPatch
 */

/** What verify said about one patch, and whether it's what the case expects. */
async function scorePatch({ testCase, patch, grading, run, cli }) {
  const folder = sessionFolder(run, `phase1-${testCase.id}-${patch.patch}`)
  await rm(folder, { recursive: true, force: true })
  try {
    const { workspace } = await prepareSession({
      testCase,
      arm: 'B',
      folder,
      grading,
      cli,
    })
    await git(workspace, 'apply', join(testCase.folder, 'phase1', patch.patch))
    const result = await runCommand(
      [
        process.execPath,
        cli,
        'verify',
        '--policy',
        'recovery-probe.policy.json',
        '--base',
        'main',
      ],
      workspace,
      30 * 60 * 1000,
      { env: caseEnvironment(testCase) },
    )
    const summary = join(workspace, '.recovery-probe', 'verify', 'summary.json')
    if (!existsSync(summary))
      return {
        patch: patch.patch,
        passed: false,
        error: `no summary: ${result.output.slice(-500)}`,
      }
    const { verdict, exitCode, claims } = JSON.parse(
      await readFile(summary, 'utf8'),
    )
    const reasons = Object.fromEntries(
      claims.map((claim) => [claim.id, claim.reason]),
    )
    const expectedReasons = Object.entries(patch.expected.reasons ?? {})
    const passed =
      verdict === patch.expected.verdict &&
      exitCode === patch.expected.exitCode &&
      expectedReasons.every(([id, reason]) => reasons[id] === reason)
    return {
      patch: patch.patch,
      passed,
      actual: { verdict, exitCode, reasons },
      expected: patch.expected,
    }
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Every case's fixed patches, scored; a case without phase1.json has nothing to score. */
export async function runPhase1({ cases, grading, run, cli }) {
  const results = []
  for (const testCase of cases) {
    const file = join(testCase.folder, 'phase1.json')
    /** @type {FixedPatch[]} */
    const patches = existsSync(file)
      ? JSON.parse(await readFile(file, 'utf8'))
      : []
    if (!patches.length)
      results.push({
        case: testCase.id,
        patch: null,
        passed: false,
        error: 'no phase1.json',
      })
    for (const patch of patches) {
      const scored = await scorePatch({
        testCase,
        patch,
        grading,
        run,
        cli,
      }).catch((error) => ({
        patch: patch.patch,
        passed: false,
        error: error.message,
      }))
      results.push({ case: testCase.id, ...scored })
    }
  }
  return results
}
