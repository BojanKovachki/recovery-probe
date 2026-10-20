import { readFile, writeFile } from 'node:fs/promises'
import {
  startNetworkFaultProxy,
  validateNetworkRules,
} from '../dist/net-fault.mjs'

const USAGE =
  'recovery-probe net [--rules FILE] [--port N] [--duration MS] [--out FILE] [--json]'

const HELP = `${USAGE}

Runs a loopback HTTPS proxy that fails whole connections per host, for apps whose
native code (an SDK, a main process, a CLI) makes its own HTTPS requests. Start the
app with HTTPS_PROXY set to the printed URL. Rule windows count from the first
connection. Without --rules, connections pass until observe --network arms faults
from its steps. Stops on Ctrl+C or after --duration. See docs/net.md.`

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

function describe(rule, index) {
  const parts = [`${index + 1}. ${rule.fault} ${rule.host}`]
  if (rule.fault === 'delay') parts.push(`by ${rule.delayMs} ms`)
  if (rule.fromMs) parts.push(`from ${seconds(rule.fromMs)}`)
  if (rule.untilMs !== undefined) parts.push(`until ${seconds(rule.untilMs)}`)
  if (rule.count) parts.push(`${rule.count} connection(s)`)
  if (rule.dropOpen) parts.push('dropping open connections')
  return `  ${parts.join(', ')}`
}

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--json') options.json = true
    else if (
      ['--rules', '--port', '--duration', '--out'].includes(arg) &&
      value &&
      !value.startsWith('--')
    ) {
      options[arg.slice(2)] = value
      i++
    } else throw Error(`Use ${USAGE}`)
  }

  for (const key of ['port', 'duration'])
    if (options[key] !== undefined) {
      options[key] = Number(options[key])
      if (!Number.isInteger(options[key]) || options[key] < 0)
        throw Error(`--${key} must be a whole number`)
    }
  return options
}

/** Waits for Ctrl+C, a termination signal or the duration, whichever comes first. */
function untilStopped(duration) {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer)
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    const timer =
      duration === undefined ? undefined : setTimeout(stop, duration)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

function hostCounts(events) {
  const hosts = {}
  for (const { host, outcome } of events) {
    hosts[host] ??= {}
    hosts[host][outcome] = (hosts[host][outcome] ?? 0) + 1
  }
  return hosts
}

export async function netMain(args) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const options = parseArgs(args)
  let rules
  if (options.rules) {
    const parsed = JSON.parse(await readFile(options.rules, 'utf8'))
    rules = validateNetworkRules(Array.isArray(parsed) ? parsed : parsed?.rules)
  }
  const proxy = await startNetworkFaultProxy({
    port: options.port,
    rules,
    armOnFirstConnection: true,
    control: true,
  })

  let printed = 0
  const printFaults = () => {
    const events = proxy.events()
    for (const event of events.slice(printed))
      if (event.rule !== undefined)
        console.log(
          `  ${seconds(event.at).padStart(8)}  ${event.outcome.padEnd(6)} ${event.host}:${event.port}`,
        )
    printed = events.length
  }

  let watch
  if (!options.json) {
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
    watch = setInterval(printFaults, 250)
  }

  await untilStopped(options.duration)
  clearInterval(watch)
  if (!options.json) printFaults()
  await proxy.close()

  const summary = proxy.summary()
  const events = proxy.events()
  // Rules armed through the control are judged by the run that armed them.
  const triggered = !rules || summary.rules.every((rule) => rule.applied > 0)
  const report = {
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

  if (options.out)
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`)
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`\n${summary.connections} connection(s) through the proxy`)
    summary.rules.forEach((rule, index) =>
      console.log(
        `  rule ${index + 1}: ${rule.fault} ${rule.host} faulted ${rule.applied} of ${rule.matching} matching`,
      ),
    )
    if (!triggered)
      console.log(
        '\nFAULT_NOT_TRIGGERED: a rule faulted no connection. Check that the app uses HTTPS_PROXY and the host names.',
      )
  }
  process.exitCode = triggered ? 0 : 2
}
