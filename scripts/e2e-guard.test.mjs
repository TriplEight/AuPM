import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertSqliteWriteAllowed } from './e2e-guard.mjs'

const TMP = os.tmpdir()

test('refuses when SQLITE_PATH is unset', () => {
  assert.throws(() => assertSqliteWriteAllowed(undefined, TMP), /SQLITE_PATH is not set/)
})

test('refuses when SQLITE_PATH is an empty or blank string', () => {
  assert.throws(() => assertSqliteWriteAllowed('', TMP), /SQLITE_PATH is not set/)
  assert.throws(() => assertSqliteWriteAllowed('   ', TMP), /SQLITE_PATH is not set/)
})

test('refuses a real deployment path like /data/audit.db', () => {
  assert.throws(() => assertSqliteWriteAllowed('/data/audit.db', TMP), /not inside a throwaway/)
})

test('refuses a relative path (resolves outside the throwaway directory)', () => {
  assert.throws(() => assertSqliteWriteAllowed('audit.db', TMP), /not inside a throwaway/)
})

test('allows a path inside os.tmpdir()', () => {
  const p = path.join(TMP, 'aupm_verify_123.db')
  assert.doesNotThrow(() => assertSqliteWriteAllowed(p, TMP))
})

test('allows a path inside a nested subdirectory of the throwaway directory', () => {
  const p = path.join(TMP, 'aupm-e2e-abc123', 'audit.db')
  assert.doesNotThrow(() => assertSqliteWriteAllowed(p, TMP))
})

test('refuses a path that escapes the throwaway directory via ".."', () => {
  const p = path.join(TMP, '..', 'x.db')
  assert.throws(() => assertSqliteWriteAllowed(p, TMP), /not inside a throwaway/)
})

test('refuses the throwaway directory itself, not a file inside it', () => {
  assert.throws(() => assertSqliteWriteAllowed(TMP, TMP), /not inside a throwaway/)
})
