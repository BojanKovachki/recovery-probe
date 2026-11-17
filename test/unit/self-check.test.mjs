import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlanInputError } from '../../dist/tools/plan/changes.mjs'
import { planVerification } from '../../dist/tools/plan/plan.mjs'
import { selfCheck } from '../../dist/tools/scenarios/self-check.mjs'
import { selfCheckScenariosTool } from '../../dist/tools/mcp/self-check-tool.mjs'

const cli = fileURLToPath(
  new URL('../../bin/recovery-probe.mjs', import.meta.url),
)

/** An HTTP check configuration its own validator accepts. */
const httpConfig = (name, extra = {}) =>
  JSON.stringify({
    pageUrl: `http://127.0.0.1:9/${name}.html`,
    endpoint: `http://127.0.0.1:9/api/${name}`,
    readySelector: `#${name}`,
    recovery: 'automatic',
    ...extra,
  })

const entry = (name, check) => ({
  name,
  paths: [`src/${name}.js`],
  check,
  behavior: `What ${name} shows.`,
  expectation: `Requirement for ${name}.`,
  limits: `What ${name} leaves out.`,
})

const httpEntry = (name) =>
  entry(name, ['check', '--config', `checks/${name}.json`])

async function project(scenarios, files) {
  const root = await mkdtemp(join(tmpdir(), 'recovery-probe-self-check-'))
  for (const [path, text] of Object.entries({
    'recovery-probe.registry.json': JSON.stringify({ scenarios }),
    ...files,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

async function inside(root, run) {
  const previous = process.cwd()
  process.chdir(root)
  try {
    return await run()
  } finally {
    process.chdir(previous)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** A report whose embedded evidence is what the comparison reads. */
const report = ({
  complete = true,
  gaps = [],
  problems = [],
  findings = [],
  error = undefined,
}) =>
  JSON.stringify({
    schemaVersion: 1,
    mode: 'IPC action check',
    channel: 'items:read',
    error,
    findings,
    evidence: {
      schema: 'recovery-probe/evidence@1',
      workflow: 'action',
      complete,
      gaps,
      problems,
      outcomes: [],
      checked: [''],
    },
  })

/** Stands in for Recovery Probe: writes `reportOf(call)` as the run's report, or none for null. */
function runner(reportOf) {
  const calls = []
  return {
    calls,
    async run(args) {
      calls.push(args)
      const text = reportOf(calls.length)
      if (text === null)
        return {
          exitCode: 4,
          output: 'Cannot reach http://127.0.0.1:9222: connection refused\n',
        }
      const folder = args[args.indexOf('--out') + 1]
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'report.json'), text)
      return { exitCode: 0, output: 'checked\n' }
    },
  }
}

const byName = (result) =>
  Object.fromEntries(result.scenarios.map((s) => [s.name, s]))

test('the static preflight validates each check with its own validators and runs nothing', async () => {
  const good = httpConfig('good')
  const root = await project(
    [
      entry('good', [
        'check',
        '--config',
        'checks/good.json',
        '--cdp',
        'http://127.0.0.1:9222',
      ]),
      httpEntry('invalid'),
      httpEntry('placeholder'),
      httpEntry('missing'),
      httpEntry('broken'),
      httpEntry('list'),
      entry('outside', ['check', '--config', '../outside.json']),
      entry('unsupported', ['start', 'web', '--config', 'checks/good.json']),
      entry('steps', [
        'observe',
        '--config',
        'checks/observe.json',
        '--steps',
        'checks/observe-steps.json',
      ]),
      { ...httpEntry('malformed'), unexpected: true },
    ],
    {
      'checks/good.json': good,
      'checks/invalid.json': '{ "pageUrl": "http://127.0.0.1:9/" }',
      'checks/placeholder.json': httpConfig('placeholder', {
        pageUrl: '{{origin}}/placeholder.html',
      }),
      'checks/broken.json': '{ not json',
      'checks/list.json': '[]',
      'checks/malformed.json': httpConfig('malformed'),
      'checks/observe.json': JSON.stringify({
        transport: 'http',
        cdp: 'http://127.0.0.1:9222',
        pageUrl: 'http://127.0.0.1:9/items.html',
        endpoint: 'http://127.0.0.1:9/api/items',
        regionSelector: '#items-region',
        contentSelector: '#items li',
      }),
      'checks/observe-steps.json': '[{ "clik": "#refresh" }]',
    },
  )
  const fake = runner(() => {
    throw new Error('a static preflight must not run anything')
  })
  await inside(root, async () => {
    const result = await selfCheck({ runCommand: fake.run })
    assert.equal(result.mode, 'static')
    assert.equal(result.reference, null)
    const scenarios = byName(result)
    assert.deepEqual(Object.keys(scenarios), [
      'broken',
      'good',
      'invalid',
      'list',
      'malformed',
      'missing',
      'outside',
      'placeholder',
      'steps',
      'unsupported',
    ])
    assert.equal(scenarios.good.outcome, 'preflight-passed')
    assert.deepEqual(scenarios.good.preflight, {
      errors: [],
      unresolved: [],
      requires: [
        'an app or browser with a debugging port at http://127.0.0.1:9222',
      ],
      inputs: [
        {
          path: 'checks/good.json',
          sha256: createHash('sha256').update(good).digest('hex'),
        },
      ],
    })
    const errors = (name) => scenarios[name].preflight.errors
    assert.deepEqual(errors('invalid'), [
      'checks/invalid.json: endpoint is required',
    ])
    assert.deepEqual(errors('missing'), ['checks/missing.json does not exist'])
    assert.deepEqual(errors('broken'), ['checks/broken.json is not valid JSON'])
    assert.deepEqual(errors('list'), [
      'checks/list.json must hold a JSON object',
    ])
    assert.match(errors('outside')[0], /\.\.\/outside\.json/)
    assert.match(errors('unsupported')[0], /This reruns a check/)
    assert.match(errors('steps')[0], /^checks\/observe-steps\.json: /)
    assert.deepEqual(errors('malformed'), ['unsupported field: unexpected'])
    assert.deepEqual(errors('placeholder'), [])
    assert.deepEqual(scenarios.placeholder.preflight.unresolved, [
      '{{origin}} in checks/placeholder.json',
    ])
    for (const name of Object.keys(scenarios).filter((n) => n !== 'good')) {
      assert.equal(scenarios[name].outcome, 'configuration-error', name)
      assert.ok(scenarios[name].guidance.length, name)
    }
    assert.deepEqual(fake.calls, [])
    assert.ok(
      !existsSync('.recovery-probe'),
      'a static preflight writes nothing',
    )
  })
})

test('an HTTP check is validated as the command runs it: attached, or in its own Chromium', async () => {
  const launched = {
    pageUrl: 'http://127.0.0.1:9/a.html',
    endpoint: 'http://127.0.0.1:9/api/a',
    readySelector: '#a',
  }
  const root = await project(
    [
      httpEntry('launched'),
      httpEntry('attached'),
      entry('flagged', [
        'check',
        '--config',
        'checks/launched.json',
        '--cdp',
        'http://127.0.0.1:9333',
      ]),
      httpEntry('folder'),
    ],
    {
      'checks/launched.json': JSON.stringify(launched),
      'checks/attached.json': JSON.stringify({
        ...launched,
        cdp: 'http://127.0.0.1:9222',
      }),
      'checks/folder.json/keep': '',
    },
  )
  await inside(root, async () => {
    const scenarios = byName(await selfCheck({}))
    // In its own Chromium, recovery is automatic unless configured.
    assert.equal(scenarios.launched.outcome, 'preflight-passed')
    assert.match(
      scenarios.launched.preflight.requires[0],
      /^the page at http:\/\/127\.0\.0\.1:9\/a\.html, which the check opens/,
    )
    // Attached, by the config or the command line, it retries and needs a retry selector.
    assert.deepEqual(scenarios.attached.preflight.errors, [
      'checks/attached.json: retrySelector is required for retry recovery',
    ])
    assert.deepEqual(scenarios.flagged.preflight.errors, [
      'checks/launched.json: retrySelector is required for retry recovery',
    ])
    assert.deepEqual(scenarios.folder.preflight.errors, [
      'checks/folder.json is not a readable file',
    ])
  })
})

test('a run classifies each scenario from its repeated runs, without hiding a finding', async () => {
  const names = [
    'clean',
    'findings',
    'flaky',
    'gap',
    'unreachable',
    'erroring',
    'early',
  ]
  const root = await project(
    names.map(httpEntry),
    Object.fromEntries(names.map((n) => [`checks/${n}.json`, httpConfig(n)])),
  )
  const defect = { code: 'EXPECTATION_NOT_MET', severity: 'defect' }
  const reports = {
    clean: () => report({}),
    findings: () => report({ problems: [defect] }),
    flaky: (run) =>
      report({
        problems: run % 2 ? [] : [{ ...defect, scope: 'http-error' }],
      }),
    gap: () =>
      report({ complete: false, gaps: ['CONTENT_MARKER_NOT_OBSERVED'] }),
    unreachable: () => null,
    erroring: () =>
      report({
        complete: false,
        error: 'Nothing answered on http://127.0.0.1:9222. Start the app.',
        gaps: ['error: Nothing answered on http://127.0', 'capture incomplete'],
      }),
    early: () =>
      report({
        problems: [{ code: 'CONTENT_BEFORE_READ', severity: 'lead' }],
        findings: [
          {
            code: 'CONTENT_BEFORE_READ',
            basis: 'NO_READ_OBSERVED_IN_INTERVAL',
          },
        ],
      }),
  }
  const fake = runner((call) => {
    const name = names.toSorted()[Math.floor((call - 1) / 3)]
    return reports[name](((call - 1) % 3) + 1)
  })
  await inside(root, async () => {
    const result = await selfCheck({
      run: { reference: ' abc1234 ' },
      runCommand: fake.run,
    })
    assert.equal(result.mode, 'runtime')
    assert.deepEqual(result.reference, { label: 'abc1234', declaredBy: 'user' })
    assert.equal(result.runs, 3)
    assert.equal(fake.calls.length, 21)
    assert.deepEqual(fake.calls[0], [
      'check',
      '--config',
      'checks/clean.json',
      '--out',
      join('.recovery-probe', 'self-check', 'runs', 'clean', 'run-1'),
    ])
    const scenarios = byName(result)
    const outcomes = Object.fromEntries(
      names.map((name) => [name, scenarios[name].outcome]),
    )
    assert.deepEqual(outcomes, {
      clean: 'clean',
      findings: 'findings',
      flaky: 'inconsistent',
      gap: 'incomplete',
      unreachable: 'execution-failed',
      erroring: 'execution-failed',
      early: 'findings',
    })
    assert.match(
      scenarios.clean.guidance[0],
      /does not show that the app is correct.*or that any change is verified/,
    )
    assert.deepEqual(
      scenarios.findings.runs.map((run) => run.problems),
      [1, 2, 3].map(() => [defect]),
    )
    assert.deepEqual(scenarios.flaky.differences, [
      {
        kind: 'problem',
        code: 'EXPECTATION_NOT_MET (http-error)',
        presentIn: [2],
        absentIn: [1, 3],
      },
    ])
    assert.deepEqual(scenarios.flaky.runs[1].problems, [
      { ...defect, scope: 'http-error' },
    ])
    assert.match(
      scenarios.gap.guidance[0],
      /no sample saw the content marker.*less than one sampling interval/,
    )
    assert.equal(
      scenarios.unreachable.runs[0].error,
      'Cannot reach http://127.0.0.1:9222: connection refused',
    )
    assert.match(scenarios.unreachable.guidance.at(-1), /It needs the page at/)
    assert.equal(
      scenarios.erroring.runs[0].error,
      'Nothing answered on http://127.0.0.1:9222. Start the app.',
    )
    assert.match(
      scenarios.erroring.guidance[0],
      /^Run\(s\) 1, 2, 3 failed: Nothing answered/,
    )
    assert.ok(
      scenarios.erroring.runs[0].report,
      'the failed run keeps its report',
    )
    assert.deepEqual(scenarios.early.runs[0].contentBeforeRead, [
      'NO_READ_OBSERVED_IN_INTERVAL',
    ])
    assert.match(
      scenarios.early.guidance[0],
      /CONTENT_BEFORE_READ, a lead.*cannot verify a fix/,
    )
    assert.match(
      scenarios.early.guidance[1],
      /capture begins after the content loaded.*not the read.*does not show which applies/,
    )
    const saved = JSON.parse(
      await readFile('.recovery-probe/self-check/report.json', 'utf8'),
    )
    assert.deepEqual(saved, JSON.parse(JSON.stringify(result)))
    const markdown = await readFile(
      '.recovery-probe/self-check/report.md',
      'utf8',
    )
    assert.match(markdown, /as declared by you: \*\*abc1234\*\*/)
    assert.match(markdown, /### flaky: inconsistent/)
    assert.ok(existsSync('.recovery-probe/self-check/runs/flaky/run-2.log'))
  })
})

test('a run checks only the named scenarios that pass, and names the unknown ones', async () => {
  const root = await project([httpEntry('items'), httpEntry('broken')], {
    'checks/items.json': httpConfig('items'),
    'checks/broken.json': '{}',
  })
  const fake = runner(() => report({}))
  await inside(root, async () => {
    const result = await selfCheck({
      names: ['broken', 'items', 'nowhere'],
      run: { reference: 'v1', runs: 2 },
      runCommand: fake.run,
    })
    assert.deepEqual(result.unknown, ['nowhere'])
    assert.equal(byName(result).broken.outcome, 'configuration-error')
    assert.deepEqual(byName(result).broken.runs, [])
    assert.equal(byName(result).items.outcome, 'clean')
    assert.equal(fake.calls.length, 2)
  })
})

test('run settings are bounded and the reference is required', async () => {
  const root = await project([httpEntry('items')], {
    'checks/items.json': httpConfig('items'),
  })
  const fake = runner(() => report({}))
  await inside(root, async () => {
    for (const run of [
      { reference: 'v1', runs: 0 },
      { reference: 'v1', runs: 11 },
      { reference: 'v1', runs: 1.5 },
      { reference: '  ' },
    ])
      await assert.rejects(
        selfCheck({ run, runCommand: fake.run }),
        PlanInputError,
      )
    await assert.rejects(
      selfCheck({ registry: 'nowhere.json', runCommand: fake.run }),
      /No registry at nowhere\.json/,
    )
    assert.deepEqual(fake.calls, [])
  })
})

test('the self-check folder never follows a symbolic link out of the project', async (t) => {
  const root = await project([httpEntry('items')], {
    'checks/items.json': httpConfig('items'),
  })
  const outside = await mkdtemp(join(tmpdir(), 'self-check-outside-'))
  const fake = runner(() => report({}))
  try {
    await inside(root, async () => {
      try {
        await symlink(
          outside,
          join(root, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
      } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code))
          return t.skip('symlink privilege unavailable')
        throw error
      }
      for (const directory of ['linked', 'linked/self-check', '../elsewhere'])
        await assert.rejects(
          selfCheck({
            run: { reference: 'v1', directory },
            runCommand: fake.run,
          }),
          PlanInputError,
        )
      // A link where the report goes stops the self-check before anything runs.
      await mkdir(join(root, 'out'))
      await symlink(
        outside,
        join(root, 'out', 'report.json'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await assert.rejects(
        selfCheck({
          run: { reference: 'v1', directory: 'out' },
          runCommand: fake.run,
        }),
        /must not traverse a symbolic link: out\/report\.json/,
      )
      assert.deepEqual(fake.calls, [])
    })
    assert.ok(!existsSync(join(outside, '.gitignore')))
    assert.ok(!existsSync(join(outside, 'self-check')))
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('the planner shows a saved self-check, its changed inputs, and keeps every check', async () => {
  const root = await project([httpEntry('items'), httpEntry('profile')], {
    'src/items.js': 'export const items = 1\n',
    'src/profile.js': 'export const profile = 1\n',
    'checks/items.json': httpConfig('items'),
    'checks/profile.json': httpConfig('profile'),
  })
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  await inside(root, async () => {
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'start')
    const defect = { code: 'EXPECTATION_NOT_MET', severity: 'defect' }
    await selfCheck({
      run: { reference: 'main', runs: 1 },
      runCommand: runner((call) =>
        report({ problems: call === 1 ? [] : [defect] }),
      ).run,
    })
    await writeFile('src/items.js', 'export const items = 2\n')
    await writeFile('src/profile.js', 'export const profile = 2\n')
    const plan = () => planVerification({ base: 'main' })
    const first = await plan()
    assert.deepEqual(
      first.checks.map((check) => check.name),
      ['items', 'profile'],
    )
    const statusOf = (report, name) =>
      report.checks.find((check) => check.name === name).scenarios[0].selfCheck
    assert.equal(statusOf(first, 'items').outcome, 'clean')
    assert.equal(statusOf(first, 'items').inputsChanged, false)
    assert.equal(statusOf(first, 'profile').outcome, 'findings')
    const requests = (report) =>
      report.needsInput.filter((request) => request.kind === 'self-check')
    assert.deepEqual(
      requests(first).map((request) => request.entry),
      ['profile'],
    )
    assert.match(requests(first)[0].message, /had the outcome findings/)
    assert.ok(
      first.limits.some((limit) => /not that the running app/.test(limit)),
    )

    await writeFile('checks/items.json', httpConfig('items', { times: 2 }))
    const second = await plan()
    assert.equal(statusOf(second, 'items').inputsChanged, true)
    assert.match(
      requests(second).find((request) => request.entry === 'items').message,
      /changed since the self-check/,
    )
    assert.equal(second.checks.length, 2)

    // A saved report the planner can't use is left out, never fatal.
    await writeFile(
      '.recovery-probe/self-check/report.json',
      '{ "kind": "scenario-self-check", "mode": "runtime", "scenarios": {} }',
    )
    const third = await plan()
    assert.equal(statusOf(third, 'items'), undefined)
    assert.equal(third.checks.length, 2)
  })
})

test('registry entries that cannot be checked are reported, and fail the selection they concern', async () => {
  const root = await project(
    [
      httpEntry('good'),
      httpEntry('other'),
      'not an entry',
      httpEntry('bad name!'),
      { ...httpEntry('paths'), paths: ['../outside.js'] },
      httpEntry('good'),
      { ...httpEntry('checkless'), check: 'check --config checks/good.json' },
    ],
    {
      'checks/good.json': httpConfig('good'),
      'checks/other.json': httpConfig('other'),
    },
  )
  await inside(root, async () => {
    const all = await selfCheck({})
    assert.equal(all.passed, false)
    assert.deepEqual(
      all.scenarios.map((s) => [s.name, s.outcome]),
      [
        ['good', 'preflight-passed'],
        ['other', 'preflight-passed'],
      ],
    )
    assert.deepEqual(
      all.invalidEntries.map(({ entry, selected }) => [entry, selected]),
      [
        ['scenarios[2]', true],
        ['bad name!', true],
        ['paths', true],
        ['good', true],
        ['checkless', true],
      ],
    )
    assert.deepEqual(all.invalidEntries.map((e) => e.message).slice(2), [
      '../outside.js is not a relative path inside the project',
      'the name good is used twice',
      'check must be a list of Recovery Probe arguments',
    ])
    // Named, only the entries that carry a selected name count.
    const other = await selfCheck({ names: ['other'] })
    assert.equal(other.passed, true)
    assert.ok(other.invalidEntries.every((e) => !e.selected))
    const good = await selfCheck({ names: ['good'] })
    assert.equal(good.passed, false, 'its duplicate concerns it')
    const checkless = await selfCheck({ names: ['checkless'] })
    assert.equal(checkless.passed, false)
    assert.deepEqual(checkless.unknown, [], 'it is in the registry, invalid')

    const printed = spawnSync(process.execPath, [cli, 'self-check'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(printed.status, 2)
    assert.match(printed.stdout, /Result: needs review/)
    assert.match(
      printed.stdout,
      /Registry entries that could not be checked:\n {2}- scenarios\[2\]: must be an object/,
    )
  })
})

test('a command line its command would reject fails the preflight with the same message', async () => {
  const commands = {
    unknown: ['check', '--config', 'checks/good.json', '--bogus-flag', 'yes'],
    foreign: ['observe', '--config', 'checks/observe.json', '--cdp', 'x'],
    'no-value': ['check', '--config', 'checks/good.json', '--cdp'],
    stray: ['check', '--config', 'checks/good.json', '--headed', 'yes'],
    page: ['discover', '--config', 'checks/good.json', '--page', '5000'],
  }
  const root = await project(
    Object.entries(commands).map(([name, check]) => entry(name, check)),
    {
      'checks/good.json': httpConfig('good'),
      'checks/observe.json': '{}',
    },
  )
  await inside(root, async () => {
    const scenarios = byName(await selfCheck({}))
    for (const [name, command] of Object.entries(commands)) {
      assert.equal(scenarios[name].outcome, 'configuration-error', name)
      const [error] = scenarios[name].preflight.errors
      const real = spawnSync(process.execPath, [cli, ...command], {
        cwd: root,
        encoding: 'utf8',
      })
      assert.equal(real.status, 3, `${name}: ${real.stderr}`)
      assert.equal(real.stderr.trim(), `Recovery Probe: ${error}`, name)
    }
  })
})

test('the CLI and the MCP tool take the same choices and report the same result', async () => {
  const root = await project([httpEntry('items'), httpEntry('broken')], {
    'checks/items.json': httpConfig('items'),
    'checks/broken.json': '{}',
  })
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'self-check', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
  await inside(root, async () => {
    for (const args of [['--run'], ['--runs', '2'], ['--reference', 'v1']]) {
      const usage = run(...args)
      assert.equal(usage.status, 3, args.join(' '))
      assert.match(usage.stderr, /--reference|--run/)
    }
    const passed = run('items', '--json')
    assert.equal(passed.status, 0, passed.stderr)
    const fromCli = JSON.parse(passed.stdout)
    assert.equal(byName(fromCli).items.outcome, 'preflight-passed')
    const all = run()
    assert.equal(all.status, 2)
    assert.match(all.stdout, /### broken: configuration error: not run/)
    assert.match(all.stdout, /Static preflight only/)

    const tool = (args) =>
      selfCheckScenariosTool.run(args, {
        signal: new AbortController().signal,
      })
    await assert.rejects(tool({ run: true }), /run needs reference/)
    for (const args of [{ reference: 'v1' }, { runs: 2 }])
      await assert.rejects(tool(args), /reference and runs go with run/)
    const fromTool = /** @type {Record<string, unknown>} */ (
      await tool({ scenarios: ['items'] })
    )
    assert.deepEqual(
      { ...fromTool, at: '' },
      { ...fromCli, at: '' },
      'the same static result',
    )
    assert.ok(!existsSync('.recovery-probe'))
  })
})
