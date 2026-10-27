import { checkReadRecovery, findPageReads } from './browser-tools.mjs'
import {
  compareReportsTool,
  findSuspectsTool,
  verifyChangeTool,
} from './change-tools.mjs'
import { runCli } from './cli-tool.mjs'
import { closeNetworkTools, networkTools } from './network-tools.mjs'
import type { McpTool } from './server.mjs'

export const MCP_INSTRUCTIONS = `Recovery Probe shows what an app does when a data read fails. Use it to check a claim about error handling before you make it, and quote its results as they are.
- A passing check covers only the configured read and screen marker; it is not proof that the app is resilient.
- FAULT_NOT_TRIGGERED, BASELINE_FAILED and other inconclusive codes are not passes. Fix the setup and run again.
- When a check can't attach to the app or the IPC hook doesn't answer, run doctor --json through run_recovery_probe and follow its fixes.
- Findings such as LOCAL_FILES_REMOVED or DELAYED_UI_UPDATE, and suspects from find_suspects, are leads to investigate, not verdicts. EXPECTATION_NOT_MET is different: the app did not show what an expect step required.
- Before you say a change fixed something, compare reports of the same check from before and after it with compare_reports, and quote its verdict. A run that stopped early is never evidence of a fix.
- When the project has a verify plan (.recovery-probe/verify.json), call verify_change with baseline true before you change the code, and verify_change before you say the change is done. Do not call it done while the verdict is NOT_VERIFIED; resolve the reasons it gives.
- Use development or test apps and accounts only: checks reload pages and fail their reads.`

export const recoveryProbeTools: McpTool[] = [
  findPageReads,
  checkReadRecovery,
  ...networkTools,
  findSuspectsTool,
  compareReportsTool,
  verifyChangeTool,
  runCli,
]

/** Closes what the tools left running, such as the network proxy. */
export async function closeRecoveryProbeTools(): Promise<void> {
  await closeNetworkTools()
}
