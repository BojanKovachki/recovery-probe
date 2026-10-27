import { startNetworkFaultProxy } from '../../transports/net/proxy.mjs'
import { validateNetworkRules } from '../../transports/net/rules.mjs'
import type { NetworkFaultProxy } from '../../transports/net/types.mjs'
import { integer } from './args.mjs'
import type { McpTool } from './server.mjs'

let proxy: NetworkFaultProxy | undefined

const ruleSchema = {
  type: 'object',
  properties: {
    host: {
      type: 'string',
      description: 'api.example.com, *.example.com or *.',
    },
    fault: { type: 'string', enum: ['refuse', 'reset', 'stall', 'delay'] },
    delayMs: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 1 },
    fromMs: { type: 'integer', minimum: 0 },
    untilMs: { type: 'integer', minimum: 1 },
    dropOpen: { type: 'boolean' },
  },
  required: ['host', 'fault'],
  additionalProperties: false,
}

export const networkTools: McpTool[] = [
  {
    name: 'start_network_faults',
    title: 'Start a network fault proxy',
    description:
      "Starts a loopback HTTPS proxy for an app's own connections (an SDK, a main process, a CLI or a test run). Start the app or tests with the returned environment; connections pass until set_network_faults arms rules. Faults apply to whole connections per host: HTTPS stays end to end.",
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 0, maximum: 65535 } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    async run(args) {
      proxy ??= await startNetworkFaultProxy({
        port: integer(args, 'port', [0, 65535]),
      })
      return { url: proxy.url, env: proxy.env() }
    },
  },
  {
    name: 'set_network_faults',
    title: 'Arm or remove network faults',
    description:
      'Replaces the armed rules, or removes them all with restore: true. Windows count from this call. Set dropOpen on a rule so clients that keep connections open have to reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: { type: 'array', items: ruleSchema },
        restore: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args) {
      if (!proxy) throw new Error('Call start_network_faults first')
      if (args.restore === true) {
        proxy.disarm()
        return { armed: [] }
      }
      const rules = validateNetworkRules(args.rules)
      proxy.arm(rules)
      return { armed: rules }
    },
  },
  {
    name: 'network_fault_summary',
    title: 'Show what the network faults did',
    description:
      'Reports how many connections went through the proxy and, for the armed rules, how many each matched and faulted. A rule that faulted nothing means the app did not use the proxy or the host name is wrong.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run() {
      if (!proxy) throw new Error('Call start_network_faults first')
      return proxy.summary()
    },
  },
  {
    name: 'stop_network_faults',
    title: 'Stop the network fault proxy',
    description:
      'Removes every fault, closes the proxy and returns its final summary.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run() {
      if (!proxy) return { stopped: false }
      const closing = proxy
      proxy = undefined
      await closing.close()
      return { stopped: true, ...closing.summary() }
    },
  },
]

/** Closes the network proxy, if a tool started it. */
export async function closeNetworkTools(): Promise<void> {
  if (proxy) {
    const closing = proxy
    proxy = undefined
    await closing.close()
  }
}
