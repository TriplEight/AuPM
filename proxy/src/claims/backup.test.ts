// proxy/src/claims/backup.test.ts
//
// Exercises backupDatabase against a real temp SQLite file and a real
// temp directory — no algod, indexer, or chain call is anywhere near this
// module, so nothing here is mocked.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { backupDatabase } from './backup.js'

let dbPath: string
let db: BetterSqlite3.Database
let backupDir: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `spm-backup-test-${randomUUID()}.db`)
  db = new BetterSqlite3(dbPath)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
  backupDir = path.join(os.tmpdir(), `spm-backup-dir-${randomUUID()}`)
})

afterEach(() => {
  db.close()
  fs.rmSync(dbPath, { force: true })
  fs.rmSync(backupDir, { recursive: true, force: true })
})

describe('backupDatabase', () => {
  test('writes a dated copy into backupDir with the same row data', () => {
    const now = new Date('2026-09-23T03:17:00.000Z')
    const backupPath = backupDatabase(db, backupDir, now)

    expect(backupPath.startsWith(backupDir)).toBe(true)
    expect(fs.existsSync(backupPath)).toBe(true)

    const copy = new BetterSqlite3(backupPath, { readonly: true })
    const rows = copy.prepare('SELECT v FROM t').all() as { v: string }[]
    copy.close()
    expect(rows).toEqual([{ v: 'hello' }])
  })

  test('leaves no leftover temp file in backupDir', () => {
    backupDatabase(db, backupDir)
    const entries = fs.readdirSync(backupDir)
    expect(entries.every((name) => !name.endsWith('.tmp'))).toBe(true)
  })

  test('an empty BACKUP_DIR throws before touching the database', () => {
    expect(() => backupDatabase(db, '')).toThrow(/BACKUP_DIR is not set/)
  })

  test('a backupDir that collides with an existing file throws', () => {
    const blockedDir = path.join(os.tmpdir(), `spm-backup-blocked-${randomUUID()}`)
    fs.writeFileSync(blockedDir, 'not a directory')
    try {
      expect(() => backupDatabase(db, blockedDir)).toThrow()
    } finally {
      fs.rmSync(blockedDir, { force: true })
    }
  })
})
