// Runs one attempt with the Claude Code CLI in print mode. Both conditions get the same
// settings: no CLAUDE.md, auto memory, hooks, skills or user settings; no web tools; file
// reads denied in the evaluation's checkout, the key folder and Claude's own files. Condition
// B adds the Recovery Probe MCP server and command, and nothing else.
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { REPORT_SCHEMA } from './prompt.mjs'

/** The Claude Code CLI of `version`: CLAUDE_CODE_CLI, or the VS Code extension's binary. */
export function claudeCli(version) {
  let path = process.env.CLAUDE_CODE_CLI
  if (!path) {
    const extensions = join(homedir(), '.vscode', 'extensions')
    const folder = readdirSync(extensions).find((name) =>
      name.startsWith(`anthropic.claude-code-${version}-`),
    )
    if (!folder)
      throw new Error(
        `No Claude Code ${version} in ${extensions}; set CLAUDE_CODE_CLI to its binary`,
      )
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
    path = join(extensions, folder, 'resources', 'native-binary', binary)
  }
  const reported = execFileSync(path, ['--version'], {
    encoding: 'utf8',
  }).trim()
  if (!reported.startsWith(`${version} `))
    throw new Error(`${path} is Claude Code ${reported}, not ${version}`)
  return path
}

/** A permission rule's path for everything under `directory`: `//c/Users/x/**` for C:\Users\x. */
export function everythingUnder(directory) {
  const path = directory
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase())
    .replace(/^\/+|\/+$/g, '')
  return `//${path}/**`
}

/** Settings of every attempt: reads denied outside the attempt's business, hooks off. */
export function attemptSettings(deniedReads) {
  return {
    permissions: { deny: deniedReads.map((path) => `Read(${path})`) },
    disableAllHooks: true,
  }
}

/** The MCP servers of a condition: none for A, Recovery Probe for B. */
export function mcpServers(condition, recoveryProbeBin) {
  return {
    mcpServers:
      condition === 'B'
        ? {
            'recovery-probe': {
              command: process.execPath,
              args: [recoveryProbeBin, 'mcp'],
            },
          }
        : {},
  }
}

// A coding agent's usual built-in tools: shells, files, search, subagents and background
// tasks. Account features such as scheduled or remote agents are left out of both conditions.
export const BUILT_IN_TOOLS = [
  'Bash',
  'PowerShell',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Task',
  'TaskStop',
  'ToolSearch',
]

export function agentArgs({
  condition,
  model,
  effort,
  maxTurns,
  settingsFile,
  mcpFile,
}) {
  return [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--tools',
    BUILT_IN_TOOLS.join(','),
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--max-turns',
    String(maxTurns),
    '--setting-sources',
    'project',
    '--settings',
    settingsFile,
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--disable-slash-commands',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    condition === 'B'
      ? 'Bash,PowerShell,mcp__recovery-probe'
      : 'Bash,PowerShell',
    '--disallowedTools',
    'WebFetch,WebSearch',
    '--permission-prompts',
    'none',
    '--json-schema',
    JSON.stringify(REPORT_SCHEMA),
  ]
}

/**
 * The attempt's environment: the harness's, without credentials for paid API use or this
 * session's Claude variables, with CLAUDE.md and auto memory off and the app's port set.
 * Condition B also finds the `recovery-probe` command on the PATH.
 * @returns {Record<string, string>}
 */
export function agentEnv(condition, toolsBin, base = process.env) {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([name]) => !/^(ANTHROPIC|CLAUDE|RP_LIVE_EVAL)/i.test(name),
    ),
  )
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return {
    ...env,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    PORT: '4173',
    ...(condition === 'B'
      ? { [pathKey ?? 'PATH']: `${toolsBin}${delimiter}${env[pathKey] ?? ''}` }
      : {}),
  }
}

export function killTree(pid) {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    else process.kill(-pid, 'SIGKILL')
  } catch {}
}

/**
 * Runs the CLI until it exits or `timeoutMs` passes; `onStart` gets its process id. The transcript
 * stays in memory, to be sealed.
 */
export async function runAgent({
  cli,
  args,
  prompt,
  env,
  cwd,
  timeoutMs,
  onStart,
}) {
  const child = spawn(cli, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  if (child.pid) onStart?.(child.pid)
  // The prompt goes in on stdin: a process search by command line must not find the session.
  child.stdin.end(prompt)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, timeoutMs)
  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      resolve(null)
    })
    child.on('close', resolve)
  })
  clearTimeout(timer)
  return { exitCode, timedOut, stdout, stderr }
}
