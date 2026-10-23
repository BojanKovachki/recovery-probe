import { version } from '../core/package.mjs'
import { serveMcp } from '../tools/mcp/server.mjs'
import {
  recoveryProbeTools,
  closeRecoveryProbeTools,
  MCP_INSTRUCTIONS,
} from '../tools/mcp/tools.mjs'

const HELP = `recovery-probe mcp

Serves Recovery Probe to AI coding agents as MCP tools over stdio, so an agent can
check what an app shows when a read fails before it claims the app handles it.
Add it to your agent as an MCP server with the command: npx recovery-probe mcp
See docs/mcp.md for the config formats.`

export async function mcpMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  if (args.length) throw Error('Use recovery-probe mcp')
  try {
    await serveMcp({
      name: 'recovery-probe',
      version,
      instructions: MCP_INSTRUCTIONS,
      tools: recoveryProbeTools,
    })
  } finally {
    await closeRecoveryProbeTools()
  }
}
