import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const server = JSON.parse(await readFile('server.json', 'utf8'))
assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`)
assert.equal(server.version, pkg.version)
assert.equal(server.name, pkg.mcpName)
assert.equal(server.packages.length, 1)
assert.equal(server.packages[0].identifier, pkg.name)
assert.equal(server.packages[0].version, pkg.version)
assert.deepEqual(server.packages[0].packageArguments, [
  { type: 'positional', value: 'mcp' },
])
assert.equal(server.packages[0].transport.type, 'stdio')
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
  { signal: AbortSignal.timeout(30000) },
)
assert.equal(response.status, 200, 'Publish and verify npm before tagging')
const published = await response.json()
assert.equal(published.version, pkg.version)
assert.equal(published.mcpName, server.name)
console.log(`Verified ${pkg.name}@${pkg.version} for ${server.name}`)
