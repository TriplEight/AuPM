// Vitest setup file for proxy, mcp and cli.
//
// A developer shell often exports the variables from .env (direnv, or
// `set -a; . .env`). Tests that expect a variable to be unset, and modules
// that read process.env when they load (mcp/src/donor.ts reads NETWORK),
// then see real values and fail. This file deletes every key that
// .env.example names before any test module loads. A test that needs a
// value sets it itself. Subprocess tests spread process.env, so they
// inherit the cleared environment.
import { readFileSync } from 'node:fs'

const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const keyPattern = /^#?\s*([A-Z][A-Z0-9_]*)=/gm

for (const [, key] of envExample.matchAll(keyPattern)) {
  delete process.env[key]
}
