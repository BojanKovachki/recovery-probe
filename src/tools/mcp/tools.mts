import { checkReadRecovery, findPageReads } from './browser-tools.mjs'
import {
  compareReportsTool,
  findSuspectsTool,
  verifyChangeTool,
} from './change-tools.mjs'
import { runCli } from './cli-tool.mjs'
import { closeNetworkTools, networkTools } from './network-tools.mjs'
import { planVerificationTool } from './plan-tool.mjs'
import { selfCheckScenariosTool } from './self-check-tool.mjs'
import type { McpTool } from './server.mjs'

export const MCP_INSTRUCTIONS = `Recovery Probe shows what an app does when a data read fails. Use it to check a claim about error handling before you make it, and quote its results as they are.
- A passing check covers only the configured read and screen marker; it is not proof that the app is resilient.
- FAULT_NOT_TRIGGERED, BASELINE_FAILED and other inconclusive codes are not passes. Fix the setup and run again.
- When a check can't attach to the app or the IPC hook doesn't answer, run doctor --json through run_recovery_probe and follow its fixes.
- Findings such as LOCAL_FILES_REMOVED or DELAYED_UI_UPDATE, and suspects from find_suspects, are leads to investigate, not verdicts. EXPECTATION_NOT_MET is different: the app did not show what an expect step required.
- Before you say a change fixed something, compare reports of the same check from before and after it with compare_reports, and quote its verdict. A run that stopped early is never evidence of a fix.
- When the project has a scenario registry (recovery-probe.registry.json), call plan_verification for the change before you record a baseline. It proposes checks; it never verifies anything. Report its uncovered files and needsInput as they are: no matching check does not mean a change is safe, and do not invent an expectation, selector or endpoint to fill a gap.
- self_check_scenarios without run only validates scenarios. Use run only when the user asks and names the running build as the reference; it injects faults. Its outcomes are about the scenarios on that build: clean never means the app is correct or a change is verified.
- When the project has a verify plan (.recovery-probe/verify.json), call verify_change with baseline true before you change the code, and verify_change before you say the change is done. Do not call it done while the verdict is NOT_VERIFIED; resolve the reasons it gives. A baseline run after the code already changed is not a before-change baseline: record it from a checkout of the base instead.
- Use development or test apps and accounts only: checks reload pages and fail their reads.`

export const recoveryProbeTools: McpTool[] = [
  findPageReads,
  checkReadRecovery,
  ...networkTools,
  findSuspectsTool,
  compareReportsTool,
  planVerificationTool,
  selfCheckScenariosTool,
  verifyChangeTool,
  runCli,
]

/** Closes what the tools left running, such as the network proxy. */
export async function closeRecoveryProbeTools(): Promise<void> {
  await closeNetworkTools()
}
