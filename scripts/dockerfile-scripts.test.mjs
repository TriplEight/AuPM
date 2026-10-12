// The server image copies a fixed list of scripts (proxy/Dockerfile). Each copied script must
// find every relative import in the image, or record-review.mjs fails with
// ERR_MODULE_NOT_FOUND on the server. This test reads the Dockerfile and the imports.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(scriptsDir)

function copiedScripts() {
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'proxy/Dockerfile'), 'utf8')
  const copies = [...dockerfile.matchAll(/^COPY scripts\/(\S+\.mjs) scripts\/\1$/gm)]
  return copies.map((match) => match[1])
}

function relativeImports(file) {
  const source = fs.readFileSync(path.join(scriptsDir, file), 'utf8')
  const imports = [...source.matchAll(/^import [^;]*? from '\.\/([^']+\.mjs)'/gms)]
  return imports.map((match) => match[1])
}

test('the Dockerfile copies record-review.mjs', () => {
  assert.ok(copiedScripts().includes('record-review.mjs'))
})

test('every relative import of a copied script is copied too', () => {
  const copied = new Set(copiedScripts())
  for (const file of copied) {
    for (const imported of relativeImports(file)) {
      assert.ok(
        copied.has(imported),
        `${file} imports ./${imported}, which proxy/Dockerfile does not copy`,
      )
    }
  }
})

test('every copied script is in the image workflow paths', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/image.yml'), 'utf8')
  for (const file of copiedScripts()) {
    assert.ok(workflow.includes(`- scripts/${file}`), `image.yml paths miss scripts/${file}`)
  }
})
