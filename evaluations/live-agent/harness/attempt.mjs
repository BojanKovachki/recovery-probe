// One attempt: a fresh workspace with the task's starting code, a fresh agent session, and the
// artifacts it leaves. The workspace and the session's files are removed afterwards.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentArgs,
  agentEnv,
  attemptSettings,
  killTree,
  mcpServers,
  runAgent,
} from './agent.mjs'
import { attemptStart, loadTask, scenarioFiles } from './tasks.mjs'
import { events, outsideReach, summarize } from './transcript.mjs'
import { createWorkspace, finalChanges } from './workspace.mjs'

// The temporary folder's long path: Claude Code asks before using an 8.3 short name such as
// BOJANK~1, and nobody can answer in print mode.
const TEMP = realpathSync.native(tmpdir())

// The app's port and the debugging port of condition B's observe checks.
export const PORTS = [4173, 9222]

/** Processes listening on `ports` (Windows `netstat`, elsewhere `lsof`). */
export function listeners(ports) {
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
      }).split('\n')
      return lines
        .map((line) => line.trim().split(/\s+/))
        .filter(
          ([, local, , state]) =>
            state === 'LISTENING' &&
            ports.some((port) => local?.endsWith(`:${port}`)),
        )
        .map((columns) => Number(columns.at(-1)))
    }
    return execFileSync(
      'lsof',
      ports.flatMap((port) => ['-ti', `tcp:${port}`]),
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/** Ends what an attempt left listening on its ports. */
export function freePorts(ports = PORTS) {
  for (const pid of new Set(listeners(ports))) if (pid) killTree(pid)
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/** The session's init event, which shows the tools, MCP servers and model it really had. */
const initOf = (all) => {
  const init = all.find(
    (event) => event.type === 'system' && event.subtype === 'init',
  )
  return init
    ? {
        model: init.model,
        permissionMode: init.permissionMode,
        tools: init.tools,
        mcpServers: init.mcp_servers,
        claudeCodeVersion: init.claude_code_version,
      }
    : null
}

/**
 * Runs `attempt` and returns its artifacts as files: attempt.json, transcript.jsonl,
 * final.diff and stderr.txt. `context` holds the pilot, the unsealed hidden tree, the CLI, the
 * tools, the app's node_modules template and the paths watched for reach outside.
 */
export async function runAttempt(attempt, context) {
  const { pilot, hidden, cli, tools, nodeModules, watched } = context
  const task = await loadTask(attempt.task)
  const workspace = join(TEMP, 'rp-live-eval-ws', randomUUID())
  const control = await mkdtemp(join(TEMP, 'rp-live-eval-ctl-'))
  freePorts()
  try {
    const scenarios =
      attempt.condition === 'B' ? await scenarioFiles(task.app) : {}
    const startCommit = await createWorkspace(
      workspace,
      attemptStart(task, attempt.condition, hidden, scenarios),
    )
    await cp(nodeModules[task.app], join(workspace, 'node_modules'), {
      recursive: true,
    })
    const settingsFile = join(control, 'settings.json')
    const mcpFile = join(control, 'mcp.json')
    await writeFile(settingsFile, json(attemptSettings(watched.deniedReads)))
    await writeFile(
      mcpFile,
      json(mcpServers(attempt.condition, tools.recoveryProbeBin)),
    )
    const startedAt = new Date()
    const outcome = await runAgent({
      cli,
      args: agentArgs({
        condition: attempt.condition,
        model: pilot.agent.model,
        effort: pilot.agent.effort,
        maxTurns: pilot.agent.maxTurns,
        settingsFile,
        mcpFile,
      }),
      env: agentEnv(attempt.condition, tools.toolsBin),
      cwd: workspace,
      timeoutMs: pilot.agent.minutes * 60000,
    })
    const endedAt = new Date()
    const all = events(outcome.stdout)
    const { report, resultSubtype, metrics } = summarize(all)
    const changes = finalChanges(workspace, startCommit)
    const record = {
      ...attempt,
      startCommit,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      agent: pilot.agent,
      recoveryProbe: attempt.condition === 'B' ? pilot.recoveryProbe : null,
      init: initOf(all),
      execution: {
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        resultSubtype,
        error: outcome.exitCode === null ? 'the CLI did not start' : null,
      },
      report,
      metrics: { ...metrics, wallMs: endedAt - startedAt },
      changedPaths: changes.paths,
      outsideReach: outsideReach(all, {
        workspace,
        watched: watched.marks,
      }),
    }
    return {
      'attempt.json': json(record),
      'transcript.jsonl': outcome.stdout,
      'final.diff': changes.diff,
      'stderr.txt': outcome.stderr,
    }
  } finally {
    freePorts()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10 })
    await rm(control, { recursive: true, force: true, maxRetries: 10 })
  }
}

/**
 * Whether the session failed because the model service would not serve it. A usage limit or an
 * overload says nothing about the agent, so the attempt is run again rather than counted.
 */
export function unavailable(record, artifacts) {
  if (record.execution.exitCode === 0 && record.report) return false
  return /usage limit|rate.?limit|limit reached|\b429\b|\b529\b|overloaded/i.test(
    `${artifacts['stderr.txt']}\n${artifacts['transcript.jsonl'].slice(-4000)}`,
  )
}
