export type {
  NetworkFault,
  NetworkFaultRule,
  NetworkOutcome,
  NetworkConnectionEvent,
  NetworkRuleSummary,
  NetworkFaultSummary,
  NetworkFaultProxy,
  NetworkFaultControl,
} from './transports/net/types.mjs'
export { hostMatches, validateNetworkRules } from './transports/net/rules.mjs'
export { startNetworkFaultProxy } from './transports/net/proxy.mjs'
export { connectNetworkFaults } from './transports/net/client.mjs'
