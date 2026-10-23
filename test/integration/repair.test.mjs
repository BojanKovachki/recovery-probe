import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  prepareRepair,
  generateRepair,
  verifyRepair,
} from '../../dist/tools/repair/run.mjs'
import { fixture, mockProvider, fixtureProposal } from '../helpers/repair.mjs'
const exec = promisify(execFile)

test(
  'web: real failure → mocked model proposal → real passing rerun, original untouched',
  { timeout: 60000 },
  async () => {
    const f = await fixture()
    const run = join(f.directory, 'run')
    try {
      const before = await prepareRepair(f.config, run, {
        allowExecution: true,
      })
      assert.equal(before.reproduced, true, JSON.stringify(before.before))
      assert.ok(
        before.before.results.every(
          (row) => row.outcome === 'fail' && row.applied === 1,
        ),
      )
      let called = 0
      await generateRepair(run, {
        allowSourceUpload: true,
        apiKey: 'mock-key',
        fetchImpl: async (...args) => {
          called++
          return mockProvider(...args)
        },
      })
      assert.equal(called, 1)
      assert.equal(
        await readFile(join(run, 'checkout/src/app.js'), 'utf8'),
        f.original,
        'proposal alone does not edit source',
      )
      await assert.rejects(verifyRepair(run), /allow-execution/)
      const result = await verifyRepair(run, { allowExecution: true })
      assert.equal(result.status, 'verified-candidate', JSON.stringify(result))
      assert.equal(result.testsPassed, true)
      const after = JSON.parse(await readFile(join(run, 'after.json'), 'utf8'))
      assert.ok(
        after.results.every(
          (row) =>
            row.outcome === 'pass' &&
            row.applied === 1 &&
            row.successfulResponsesAfterFault > 0,
        ),
      )
      assert.match(
        await readFile(join(run, 'candidate.patch'), 'utf8'),
        /busy = false/,
      )
      assert.equal(
        await readFile(join(f.repo, 'src/app.js'), 'utf8'),
        f.original,
      )
      assert.equal(
        (await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout,
        '',
      )
      assert.equal(
        (await exec('git', ['remote'], { cwd: join(run, 'checkout') })).stdout,
        '',
      )
      await assert.rejects(
        verifyRepair(run, { allowExecution: true }),
        /new run/,
      )
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test(
  'a multi-line proposal applies when Git converts line endings on checkout',
  { timeout: 60000 },
  async () => {
    const f = await fixture()
    const run = join(f.directory, 'run')
    // Git for Windows checks out CRLF by default; a global setting reproduces it anywhere.
    const gitConfig = join(f.directory, 'gitconfig')
    await writeFile(gitConfig, '[core]\n\tautocrlf = true\n')
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = gitConfig
    try {
      await prepareRepair(f.config, run, { allowExecution: true })
      assert.equal(
        await readFile(join(run, 'checkout/src/app.js'), 'utf8'),
        f.original,
        'the checkout holds the committed bytes',
      )
      await writeFile(
        join(run, 'proposal.json'),
        JSON.stringify({
          ...fixtureProposal,
          edits: [
            {
              path: 'src/app.js',
              find: '  } catch {\n    // BUG: the loading flag prevents the scheduled retry.',
              replace: '  } catch {\n    busy = false;',
            },
          ],
        }),
      )
      const result = await verifyRepair(run, { allowExecution: true })
      assert.equal(result.status, 'verified-candidate', JSON.stringify(result))
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test(
  'a harmless but ineffective patch is never called verified',
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    const run = join(f.directory, 'run')
    f.config.scenario.faults = ['http-error']
    try {
      await prepareRepair(f.config, run, { allowExecution: true })
      await writeFile(
        join(run, 'proposal.json'),
        JSON.stringify({
          ...fixtureProposal,
          edits: [
            {
              path: 'src/app.js',
              find: '// BUG: the loading flag prevents the scheduled retry.',
              replace: '// Still broken.',
            },
          ],
        }),
      )
      const result = await verifyRepair(run, { allowExecution: true })
      assert.equal(result.status, 'not-verified')
      assert.equal(result.scenarioPassed, false)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test(
  'invalid baseline never creates an upload bundle',
  { timeout: 15000 },
  async () => {
    const f = await fixture()
    try {
      f.config.scenario.readySelector = '#absent'
      f.config.scenario.timeoutMs = 200
      const run = join(f.directory, 'run')
      assert.equal(
        (await prepareRepair(f.config, run, { allowExecution: true }))
          .reproduced,
        false,
      )
      await assert.rejects(readFile(join(run, 'repair-request.json')), {
        code: 'ENOENT',
      })
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test(
  'passing the scenario but failing an existing regression is not verified',
  { timeout: 30000 },
  async () => {
    const f = await fixture()
    const run = join(f.directory, 'run')
    f.config.scenario.faults = ['http-error']
    f.config.tests = [
      [
        process.execPath,
        '-e',
        "const fs=require('node:fs');if(!fs.readFileSync('src/app.js','utf8').includes('// BUG:'))process.exit(1)",
      ],
    ]
    try {
      await prepareRepair(f.config, run, { allowExecution: true })
      await generateRepair(run, {
        allowSourceUpload: true,
        apiKey: 'mock-key',
        fetchImpl: mockProvider,
      })
      const result = await verifyRepair(run, { allowExecution: true })
      assert.equal(result.scenarioPassed, true)
      assert.equal(result.testsPassed, false)
      assert.equal(result.status, 'not-verified')
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test('dirty repositories and source symlinks are rejected', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.repo, 'uncommitted.txt'), 'user work')
    await assert.rejects(
      prepareRepair(f.config, join(f.directory, 'dirty'), {
        allowExecution: true,
      }),
      /clean committed/,
    )
    await rm(join(f.repo, 'uncommitted.txt'))
    // Commit the symlink through the index, so no symlink rights are needed on Windows.
    const link = exec('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo })
    link.child.stdin.end('app.js')
    const blob = (await link).stdout.trim()
    await exec(
      'git',
      ['update-index', '--add', '--cacheinfo', `120000,${blob},src/link.js`],
      { cwd: f.repo },
    )
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=f@example.test',
        'commit',
        '-qm',
        'symlink',
      ],
      { cwd: f.repo },
    )
    // Check it out as this platform would: a symlink, or a plain file on Windows.
    await exec('git', ['checkout', '--', 'src/link.js'], { cwd: f.repo })
    await assert.rejects(
      prepareRepair(
        { ...f.config, sourceFiles: ['src/link.js'] },
        join(f.directory, 'link'),
        { allowExecution: true },
      ),
      /symlinks/,
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('output cannot enter the original repository through a symlink or dot-prefix path', async () => {
  const f = await fixture()
  try {
    const alias = join(f.directory, 'alias')
    // A junction needs no symlink rights on Windows; other platforms ignore the type.
    await symlink(f.repo, alias, 'junction')
    for (const destination of [
      join(alias, 'new', 'run'),
      join(f.repo, '..private', 'run'),
    ]) {
      await assert.rejects(
        prepareRepair(f.config, destination, { allowExecution: true }),
        /outside the source/,
      )
    }
    assert.equal(
      (await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout,
      '',
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
