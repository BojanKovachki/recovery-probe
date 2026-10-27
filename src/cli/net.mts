import { readFile, writeFile } from 'node:fs/promises'
import { startNetworkFaultProxy } from '../transports/net/proxy.mjs'
import { validateNetworkRules } from '../transports/net/rules.mjs'
import type {
  NetworkConnectionEvent,
  NetworkFaultProxy,
  NetworkFaultRule,
} from '../transports/net/types.mjs'
import { untilStopped } from './until-stopped.mjs'
import { integerOption, parseOptions, text } from './args.mjs'

const USAGE =
  'recovery-probe net [--rules FILE] [--port N] [--duration MS] [--out FILE] [--json]'

const HELP = `${USAGE}

Runs a loopback HTTPS proxy that fails whole connections per host, for apps whose
native code (an SDK, a main process, a CLI) makes its own HTTPS requests. Start the
app with HTTPS_PROXY set to the printed URL. Rule windows count from the first
connection. Without --rules, connections pass until observe --network arms faults
from its steps. Stops on Ctrl+C or after --duration. See docs/net.md.`

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function describe(rule: NetworkFaultRule, index: number) {
  const parts = [`${index + 1}. ${rule.fault} ${rule.host}`]
  if (rule.fault === 'delay') parts.push(`by ${rule.delayMs} ms`)
  if (rule.fromMs) parts.push(`from ${seconds(rule.fromMs)}`)
  if (rule.untilMs !== undefined) parts.push(`until ${seconds(rule.untilMs)}`)
  if (rule.count) parts.push(`${rule.count} connection(s)`)
  if (rule.dropOpen) parts.push('dropping open connections')
  return `  ${parts.join(', ')}`
}

interface NetOptions {
  json?: true
  rules?: string
  port?: number
  duration?: number
  out?: string
}

function parseArgs(args: string[]): NetOptions {
  const { values } = parseOptions(args, {
    json: { type: 'boolean' },
    rules: { type: 'string' },
    out: { type: 'string' },
    port: { type: 'string' },
    duration: { type: 'string' },
  })
  return {
    ...(values['json'] ? { json: true as const } : {}),
    rules: text(values, 'rules'),
    out: text(values, 'out'),
    port: integerOption(values, 'port', [0, 65535]),
    duration: integerOption(values, 'duration', [0, Number.MAX_SAFE_INTEGER]),
  }
}

function hostCounts(events: NetworkConnectionEvent[]) {
  const hosts: Record<string, Record<string, number>> = {}
  for (const { host, outcome } of events) {
    hosts[host] ??= {}
    hosts[host][outcome] = (hosts[host][outcome] ?? 0) + 1
  }
  return hosts
}

export async function netMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  const rules = await readRules(options.rules)
  const proxy = await startNetworkFaultProxy({
    port: options.port,
    rules,
    armOnFirstConnection: true,
    control: true,
  })
  const printFaults = faultPrinter(proxy)
  let watch: NodeJS.Timeout | undefined
  if (!options.json) {
    printStart(proxy, rules)
    watch = setInterval(printFaults, 250)
  }
  await untilStopped(options.duration)
  clearInterval(watch)
  if (!options.json) printFaults()
  await proxy.close()
  const report = netReport(proxy, rules)
  if (options.out)
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`)
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else printSummary(report)
  process.exitCode = report.ok ? 0 : 2
}

async function readRules(path: string | undefined) {
  if (!path) return undefined
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  return validateNetworkRules(Array.isArray(parsed) ? parsed : parsed?.rules)
}

/** Prints the faulted connections since its last call. */
function faultPrinter(proxy: NetworkFaultProxy) {
  let printed = 0
  return () => {
    const events = proxy.events()
    for (const event of events.slice(printed))
      if (event.rule !== undefined)
        console.log(
          `  ${seconds(event.at).padStart(8)}  ${event.outcome.padEnd(6)} ${event.host}:${event.port}`,
        )
    printed = events.length
  }
}

function printStart(
  proxy: NetworkFaultProxy,
  rules: NetworkFaultRule[] | undefined,
) {
  console.log(`Recovery Probe network faults on ${proxy.url}

Start the app with:
  HTTPS_PROXY=${proxy.url}
  NO_PROXY=${proxy.env().NO_PROXY}

${
  rules
    ? `Rules, timed from the first connection:\n${rules.map(describe).join('\n')}`
    : `No rules: connections pass until observe --network ${proxy.url} arms some.`
}

Faulted connections:`)
}

function netReport(
  proxy: NetworkFaultProxy,
  rules: NetworkFaultRule[] | undefined,
) {
  const summary = proxy.summary()
  const events = proxy.events()
  // Rules armed through the control are judged by the run that armed them.
  const triggered = !rules || summary.rules.every((rule) => rule.applied > 0)
  return {
    tool: 'recovery-probe',
    mode: 'network faults',
    ok: triggered,
    code: triggered ? 'FAULTS_APPLIED' : 'FAULT_NOT_TRIGGERED',
    connections: summary.connections,
    rules: summary.rules,
    hosts: hostCounts(events),
    events,
    eventsDropped: summary.eventsDropped,
  }
}

function printSummary(report: ReturnType<typeof netReport>) {
  console.log(`\n${report.connections} connection(s) through the proxy`)
  report.rules.forEach((rule, index) =>
    console.log(
      `  rule ${index + 1}: ${rule.fault} ${rule.host} faulted ${rule.applied} of ${rule.matching} matching`,
    ),
  )
  if (!report.ok)
    console.log(
      '\nFAULT_NOT_TRIGGERED: a rule faulted no connection. Check that the app uses HTTPS_PROXY and the host names.',
    )
}
