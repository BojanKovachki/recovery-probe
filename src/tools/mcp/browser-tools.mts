import { join } from 'node:path'
import { FAULT_KINDS } from '../../core/faults.mjs'
import { integer, loadWeb, reportDirectory, text } from './args.mjs'
import type { McpTool } from './server.mjs'

export const findPageReads: McpTool = {
  name: 'find_page_reads',
  title: 'Find the reads behind a page',
  description:
    'Opens a page in headless Chromium and lists the JSON GET requests it makes while it loads. Use it to choose the endpoint for check_read_recovery. Only successful page fetch and XHR reads are seen; native, IPC and service-worker traffic is not.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Page of a development or test app.',
      },
      durationMs: {
        type: 'integer',
        minimum: 200,
        maximum: 30000,
        default: 5000,
        description: 'How long to watch after the page loads.',
      },
      storageState: {
        type: 'string',
        description:
          'Playwright storage state file of a signed-in test account.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args) {
    const { discoverWeb } = await loadWeb()
    return discoverWeb(
      {
        pageUrl: text(args, 'url')!,
        storageState: text(args, 'storageState', false),
      },
      { durationMs: integer(args, 'durationMs', [200, 30000]) },
    )
  },
}

export const checkReadRecovery: McpTool = {
  name: 'check_read_recovery',
  title: 'Check that a page recovers when a read fails',
  description:
    'Loads the page healthy, then fails one GET endpoint with each fault kind and checks that the ready marker comes back: by itself (recovery "automatic") or after clicking retrySelector ("retry"). Returns an outcome per fault, why the healthy baseline failed if it did, the text the screen showed under a fault it did not recover from, and the report folder, which includes fix-brief.md and reproduce.mjs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Page of a development or test app.',
      },
      endpoint: {
        type: 'string',
        description:
          'Origin and path of the GET read to fail, as find_page_reads lists it.',
      },
      readySelector: {
        type: 'string',
        description:
          'CSS selector of the one element that is visible only once that read has rendered its data. It must match exactly one element: for a list, choose its container or a single item, not a selector every item matches.',
      },
      readyText: {
        type: 'string',
        description: 'Text the ready element must contain.',
      },
      recovery: {
        type: 'string',
        enum: ['automatic', 'retry'],
        default: 'automatic',
      },
      retrySelector: {
        type: 'string',
        description: 'Required when recovery is "retry".',
      },
      faults: {
        type: 'array',
        items: { type: 'string', enum: FAULT_KINDS },
        description: `Which faults to apply; all of ${FAULT_KINDS.join(', ')} by default.`,
      },
      times: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        default: 1,
        description: 'How many consecutive requests each fault fails.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 200,
        maximum: 60000,
        default: 5000,
      },
      storageState: { type: 'string' },
    },
    required: ['url', 'endpoint', 'readySelector'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async run(args) {
    const { checkWeb } = await loadWeb()
    const { writeDesktopReport } = await import('../../reports/check.mjs')
    const scenario = {
      target: 'web',
      pageUrl: text(args, 'url')!,
      endpoint: text(args, 'endpoint')!,
      readySelector: text(args, 'readySelector')!,
      recovery: (text(args, 'recovery', false) ?? 'automatic') as
        'automatic' | 'retry',
      ...(args.readyText !== undefined
        ? { readyText: text(args, 'readyText') }
        : {}),
      ...(args.retrySelector !== undefined
        ? { retrySelector: text(args, 'retrySelector') }
        : {}),
      ...(args.faults !== undefined ? { faults: args.faults as string[] } : {}),
      ...(args.times !== undefined
        ? { times: integer(args, 'times', [1, 10]) }
        : {}),
      ...(args.timeoutMs !== undefined
        ? { timeoutMs: integer(args, 'timeoutMs', [200, 60000]) }
        : {}),
      ...(args.storageState !== undefined
        ? { storageState: text(args, 'storageState') }
        : {}),
    }
    const report = await checkWeb(scenario as Parameters<typeof checkWeb>[0])
    const directory = await reportDirectory('check')
    await writeDesktopReport(directory, report, scenario)
    return {
      ok: report.ok,
      results: report.results.map(
        ({ kind, outcome, code, reason, screenText, applied, recoveryMs }) => ({
          kind,
          outcome,
          code,
          ...(reason === undefined ? {} : { reason }),
          ...(screenText === undefined ? {} : { screenText }),
          applied,
          ...(recoveryMs === undefined ? {} : { recoveryMs }),
        }),
      ),
      limitation: report.limitation,
      report: join(directory, 'report.json'),
      fixBrief: join(directory, 'fix-brief.md'),
    }
  },
}
