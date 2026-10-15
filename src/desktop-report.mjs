import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { escapeHtml, renderTemplate } from './report-template.mjs'

export function desktopReportHtml(report, target = 'desktop') {
  const results = report.results
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.kind)}</td><td class="${escapeHtml(row.outcome)}">${escapeHtml(row.outcome.toUpperCase())}</td><td>${escapeHtml(row.code)}</td><td>${row.applied}</td><td>${row.successfulResponsesAfterFault}</td><td>${row.retryClicked ? 'Yes' : 'No'}</td></tr>`,
    )
    .join('')
  const screenshots = report.results
    .filter((row) => row.screenshot && /^[a-z0-9-]+\.png$/.test(row.screenshot))
    .map(
      (row) =>
        `<figure><figcaption>${escapeHtml(row.kind)} — ${escapeHtml(row.code)}</figcaption><img alt="Renderer at the end of the recovery check" src="${escapeHtml(row.screenshot)}"></figure>`,
    )
    .join('')
  return renderTemplate('desktop', {
    target,
    targetLabel: target.toUpperCase(),
    heading: report.ok
      ? 'Selected recovery checks passed'
      : 'Recovery needs investigation',
    endpoint: report.endpoint,
    recovery: report.recovery,
    timeoutMs: report.timeoutMs,
    generatedAt: report.generatedAt,
    results,
    finalReset: report.finalReset,
    limitation: report.limitation,
    reproduceWhere:
      target === 'web'
        ? 'against the configured development URL'
        : 'while your development app is on the same screen',
    screenshots,
  })
}
export async function writeDesktopReport(directory, report, config) {
  const dir = resolve(directory)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const failures = report.results
    .filter((r) => r.outcome !== 'pass')
    .map(
      (r) =>
        `- ${r.kind}: ${r.code}; injected=${r.applied}; later successful responses=${r.successfulResponsesAfterFault}; retry clicked=${r.retryClicked}`,
    )
    .join('\n')
  const brief = `# Recovery investigation\n\nThis is a test observation, not an automatic diagnosis or a source-code fix.\n\nSelected GET endpoint: ${JSON.stringify(report.endpoint)}\nRecovery mode: ${report.recovery}\nDeadline: ${report.timeoutMs} ms\nFinal reload reset: ${report.finalReset}\n\n## Observations\n\n${failures || 'All configured fault checks passed.'}\n\n## Instructions for a coding agent with authorized source access\n\n1. Read scenario.json and report.json. Validate that readySelector and optional readyText/busySelector prove this endpoint loaded, and that retrySelector identifies the intended action.\n2. Reproduce with node reproduce.mjs from this directory against the same development screen and test account. Treat BASELINE_FAILED, FAULT_NOT_TRIGGERED, and RETRY_ACTION_UNAVAILABLE as inconclusive, not app defects.\n3. Find the selected request and its recovery state transitions in the source. Check loading/in-flight flags, errors, retry handlers, cancellation and stale responses. These are hypotheses, not established causes.\n4. If an app defect is reproduced, propose the smallest source patch with an explanation. Preserve error reporting and authentication; do not mask the failure or weaken the assertion to make the test pass.\n5. Rerun the same scenario and the application's relevant tests. Compare the before/after reports. Obtain review before merging or deploying a patch.\n\nThis report contains local endpoint paths and may include optional screenshots. It has not been sent to an AI service.\n`
  const reproduction =
    config.target === 'web'
      ? `import { readFile } from 'node:fs/promises';\nimport { checkWeb } from 'recovery-probe/web';\nconst config = JSON.parse(await readFile(new URL('./scenario.json', import.meta.url), 'utf8'));\nconst report = await checkWeb(config);\nconsole.log(JSON.stringify(report, null, 2));\nprocess.exitCode = report.ok ? 0 : 1;\n`
      : `import { readFile } from 'node:fs/promises';\nimport { connectDesktop, selectDesktopPage, checkDesktop } from 'recovery-probe/desktop';\nconst config = JSON.parse(await readFile(new URL('./scenario.json', import.meta.url), 'utf8'));\nconst browser = await connectDesktop(config.cdp);\ntry {\n  const report = await checkDesktop(selectDesktopPage(browser, config), config);\n  console.log(JSON.stringify(report, null, 2));\n  process.exitCode = report.ok ? 0 : 1;\n} finally { await browser.close(); }\n`
  for (const [name, value] of Object.entries({
    'report.json': JSON.stringify(report, null, 2) + '\n',
    'scenario.json': JSON.stringify(config, null, 2) + '\n',
    'report.html': desktopReportHtml(
      report,
      config.target === 'web' ? 'web' : 'desktop',
    ),
    'fix-brief.md': brief,
    'reproduce.mjs': reproduction,
  })) {
    await writeFile(join(dir, name), value, { mode: 0o600 })
  }
  return dir
}
