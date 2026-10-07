import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The published aupm-mcp manifest uses publishConfig.exports. An entry that
// points at ./src/*.ts ships a path that is not in the tarball, and every
// importer of that subpath fails at startup (aupm-cli 0.4.0).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcpDir = path.join(repoRoot, 'mcp')
const manifest = JSON.parse(readFileSync(path.join(mcpDir, 'package.json'), 'utf8'))
const devExports = manifest.exports
const publishExports = manifest.publishConfig.exports

test('every aupm-mcp subpath export has a published export', () => {
  assert.deepEqual(Object.keys(publishExports).sort(), Object.keys(devExports).sort())
})

for (const [subpath, target] of Object.entries(publishExports)) {
  test(`published export ${subpath} points at built files in dist`, () => {
    assert.equal(typeof target, 'object', `${subpath} must give types and default`)
    const stem = subpath.slice(2)
    assert.equal(target.default, `./dist/${stem}.js`)
    assert.equal(target.types, `./dist/${stem}.d.ts`)
    assert.equal(devExports[subpath], `./src/${stem}.ts`)
    assert.ok(existsSync(path.join(mcpDir, 'src', `${stem}.ts`)), `src/${stem}.ts must exist`)
  })
}
