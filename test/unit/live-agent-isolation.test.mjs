import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentArgs,
  agentEnv,
  BUILT_IN_TOOLS,
  attemptSettings,
  everythingUnder,
  mcpServers,
} from '../../evaluations/live-agent/harness/agent.mjs'
import { promptFor } from '../../evaluations/live-agent/harness/prompt.mjs'
import {
  seal,
  newKey,
  unseal,
} from '../../evaluations/live-agent/harness/seal.mjs'
import {
  attemptStart,
  hiddenFromDisk,
  loadPilot,
  loadTask,
  scenarioFiles,
} from '../../evaluations/live-agent/harness/tasks.mjs'
import { outsideReach } from '../../evaluations/live-agent/harness/transcript.mjs'

const hidden = await hiddenFromDisk()
const pilot = await loadPilot()
const checkNames = Object.keys(hidden)
  .filter((path) => path.startsWith('grading/checks/'))
  .flatMap((path) => [
    ...hidden[path].toString('utf8').matchAll(/^ {2}async '([\w-]+)'/gm),
  ])
  .map(([, name]) => name)

test('a workspace holds the task start and nothing of the grading or the reference', async () => {
  assert.ok(checkNames.length >= 10, 'the graders define their checks')
  for (const id of pilot.tasks) {
    const task = await loadTask(id)
    const scenarios = await scenarioFiles(task.app)
    for (const condition of pilot.conditions) {
      const tree = attemptStart(task, condition, hidden, scenarios)
      for (const [path, content] of Object.entries(tree)) {
        assert.ok(!/^(apps|grading)\//.test(path), `${id}: ${path}`)
        const text = content.toString('utf8')
        for (const name of checkNames)
          assert.ok(
            !text.includes(name),
            `${id} ${condition}: ${path} names ${name}`,
          )
      }
      // A defective file is the task's version, never the reference's.
      for (const [path, content] of Object.entries(task.overlay)) {
        assert.deepEqual(tree[path], content, `${id}: ${path}`)
        assert.notDeepEqual(tree[path], hidden[`apps/${task.app}/${path}`])
      }
    }
  }
})

test('condition B adds only the prepared scenarios, the same for every task of an app', async () => {
  for (const id of pilot.tasks) {
    const task = await loadTask(id)
    const scenarios = await scenarioFiles(task.app)
    const a = attemptStart(task, 'A', hidden, scenarios)
    const b = attemptStart(task, 'B', hidden, scenarios)
    const added = Object.keys(b).filter((path) => !(path in a))
    assert.deepEqual(added.sort(), Object.keys(scenarios).sort(), id)
    for (const path of Object.keys(a)) assert.deepEqual(a[path], b[path], id)
  }
})

test('both conditions get the same prompt, settings and limits; B names its extra tool only', () => {
  const a = promptFor('A')
  const b = promptFor('B')
  assert.ok(b.startsWith(a))
  const extra = b.slice(a.length)
  assert.match(extra, /Recovery Probe/)
  assert.doesNotMatch(
    extra,
    /refresh|retry|filter|ship|notification|sync|ORD-|HLT-|NTF-|SYN-/i,
  )

  const common = {
    model: 'm',
    effort: 'high',
    maxTurns: 9,
    settingsFile: 's',
    mcpFile: 'c',
  }
  const argsA = agentArgs({ ...common, condition: 'A' })
  const argsB = agentArgs({ ...common, condition: 'B' })
  const allowed = (args) => args[args.indexOf('--allowedTools') + 1]
  assert.equal(allowed(argsA), 'Bash,PowerShell')
  assert.equal(allowed(argsB), 'Bash,PowerShell,mcp__recovery-probe')
  const without = (args) =>
    args.filter((_, i) => i !== args.indexOf('--allowedTools') + 1)
  assert.deepEqual(without(argsA), without(argsB))
  // The prompt goes in on stdin: a search by command line must not find the session.
  for (const args of [argsA, argsB])
    assert.ok(!args.some((arg) => arg.includes('ISSUE.md')))
  assert.match(a, /stop only processes you started/)
  for (const flag of [
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
  ])
    assert.ok(argsA.includes(flag), flag)
  assert.equal(
    argsA[argsA.indexOf('--disallowedTools') + 1],
    'WebFetch,WebSearch',
  )
  assert.equal(argsA[argsA.indexOf('--effort') + 1], 'high')
  // Built-in tools are a coding agent's usual set; no scheduled or remote agents.
  const tools = argsA[argsA.indexOf('--tools') + 1].split(',')
  assert.deepEqual(BUILT_IN_TOOLS, tools)
  for (const tool of ['Read', 'Edit', 'PowerShell', 'Task'])
    assert.ok(tools.includes(tool), tool)
  for (const tool of ['CronCreate', 'RemoteTrigger', 'Workflow', 'WebFetch'])
    assert.ok(!tools.includes(tool), tool)
  assert.deepEqual(mcpServers('A', 'rp.mjs'), { mcpServers: {} })
  assert.deepEqual(Object.keys(mcpServers('B', 'rp.mjs').mcpServers), [
    'recovery-probe',
  ])
})

test('an attempt runs without paid-API credentials, session variables or the key', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    CLAUDECODE: '1',
    CLAUDE_CODE_SSE_PORT: '1234',
    RP_LIVE_EVAL_KEY: 'secret',
  }
  const a = agentEnv('A', '/tools/bin', base)
  const b = agentEnv('B', '/tools/bin', base)
  for (const env of [a, b]) {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDECODE',
      'CLAUDE_CODE_SSE_PORT',
      'RP_LIVE_EVAL_KEY',
    ])
      assert.equal(env[name], undefined, name)
    assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(env.HOME, '/home/x')
  }
  assert.equal(a.PATH, '/usr/bin')
  assert.ok(b.PATH.startsWith('/tools/bin'))
})

test('file reads are denied outside the attempt, and a tool call naming those places is flagged', () => {
  assert.equal(
    everythingUnder('C:\\Users\\x\\Projects\\repo'),
    '//c/Users/x/Projects/repo/**',
  )
  assert.equal(everythingUnder('/home/x/keys/'), '//home/x/keys/**')
  assert.deepEqual(attemptSettings(['//c/repo/**']).permissions.deny, [
    'Read(//c/repo/**)',
  ])

  const call = (name, input) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  })
  const flagged = outsideReach(
    [
      call('Read', { file_path: 'C:\\Temp\\ws\\public\\src\\store.js' }),
      call('Bash', {
        command:
          'cat C:/Users/x/Projects/repo/evaluations/live-agent/grading/rules.json',
      }),
      call('Bash', { command: 'ls ~/.claude/projects' }),
      call('Bash', { command: 'npm test' }),
    ],
    {
      workspace: 'C:\\Temp\\ws',
      watched: ['C:\\Users\\x\\Projects\\repo', '/.claude/'],
    },
  )
  assert.deepEqual(
    flagged.map((flag) => flag.tool),
    ['Bash', 'Bash'],
  )
})

test('sealed material is unreadable without its key', () => {
  const key = newKey()
  const tree = {
    'grading/rules.json': Buffer.from('{"secret": "quick-filter"}'),
  }
  const sealed = seal(tree, key)
  assert.ok(!sealed.includes(Buffer.from('quick-filter')))
  assert.deepEqual(unseal(sealed, key), tree)
  assert.throws(() => unseal(sealed, newKey()))
})

test('running a pilot loads nothing that is sealed while it runs', async () => {
  const harness = fileURLToPath(
    new URL('../../evaluations/live-agent/harness/', import.meta.url),
  )
  const loaded = new Set()
  async function follow(file) {
    if (loaded.has(file)) return
    loaded.add(file)
    const source = await readFile(file, 'utf8')
    for (const [, path] of source.matchAll(
      /^import\s[^;]*?from\s+'(\.[^']+)'/gms,
    ))
      await follow(resolve(dirname(file), path))
  }
  await follow(join(harness, 'pilot.mjs'))
  assert.ok(loaded.has(join(harness, 'attempt.mjs')))
  for (const file of loaded)
    assert.doesNotMatch(file, /[\\/](grading|apps)[\\/]|[\\/]grade\.mjs$/, file)
})
