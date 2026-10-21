import { readFile } from 'node:fs/promises'
import { serveMcp } from '../mcp-server.mjs'
import {
  recoveryProbeTools,
  closeRecoveryProbeTools,
  MCP_INSTRUCTIONS,
} from '../mcp-tools.mjs'

const HELP = `recovery-probe mcp

Serves Recovery Probe to AI coding agents as MCP tools over stdio, so an agent can
check what an app shows when a read fails before it claims the app handles it.
Add it to an agent, for example: claude mcp add recovery-probe -- npx recovery-probe mcp
See docs/mcp.md.`

export async function mcpMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  if (args.length) throw Error('Use recovery-probe mcp')
  const { version } = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
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
