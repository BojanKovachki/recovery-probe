import { selfCheck } from '../scenarios/self-check.mjs'
import { integer, text } from './args.mjs'
import type { McpTool } from './server.mjs'

function names(args: Record<string, unknown>) {
  const value = args.scenarios ?? []
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || !name.trim())
  )
    throw new Error('scenarios must be a list of registry scenario names')
  return value as string[]
}

export const selfCheckScenariosTool: McpTool = {
  name: 'self_check_scenarios',
  title: 'Check registered scenarios before relying on them',
  description:
    'Experimental. Checks scenarios from the project registry (recovery-probe.registry.json) before they are used for before/after verification. Without run it only looks: files, unfilled placeholders, and each configuration against the validators its command uses; nothing is started or contacted. With run true it runs each scenario that passes against the application running now, which the user declares as the reference build in reference; never pick that yourself. Each run injects the faults and performs the actions its configuration names. Each scenario ends configuration-error, execution-failed, incomplete, inconsistent, findings (on the reference build) or clean. Clean never means the app is correct, the scenario detects its defect, or a change is verified; report outcomes and guidance as they are.',
  inputSchema: {
    type: 'object',
    properties: {
      scenarios: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Registry scenario names. Default: every registered check.',
      },
      registry: {
        type: 'string',
        description:
          'The scenario registry, relative to the working directory. Default: recovery-probe.registry.json.',
      },
      run: {
        type: 'boolean',
        default: false,
        description:
          'Run the scenarios against the running application. Only when the user asked for it and named the reference build.',
      },
      reference: {
        type: 'string',
        description:
          'Required with run: the build the user says is running, such as a commit or version. Kept as given; not verified.',
      },
      runs: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Runs of each scenario with run. Default: 3.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  async run(args) {
    if (args.run !== undefined && typeof args.run !== 'boolean')
      throw new Error('run must be true or false')
    const reference = text(args, 'reference', false)
    if (args.run && !reference)
      throw new Error(
        'run needs reference: the build the user says the running application is',
      )
    if (!args.run && (reference || args.runs !== undefined))
      throw new Error('reference and runs go with run')
    return selfCheck({
      registry: text(args, 'registry', false),
      names: names(args),
      run: args.run
        ? { reference: reference!, runs: integer(args, 'runs', [1, 10]) }
        : undefined,
    })
  },
}
