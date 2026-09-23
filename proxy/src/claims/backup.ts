// proxy/src/claims/backup.ts
//
// Nightly backup step (SPEC.md §13.2 step 2). `VACUUM INTO` a dated copy
// of the SQLite file, then move it into BACKUP_DIR — the off-host storage
// the operator mounts there. A failed backup must stop the nightly job
// before it credits anything: nightly.ts lets any error from
// `backupDatabase` propagate uncaught, out of `runNightly`, before the
// credit step ever runs.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * `VACUUM INTO` a dated copy of `db`'s file into `backupDir`, via a
 * same-directory temp file and an atomic rename — so a reader of
 * `backupDir` never sees a partially written backup. Returns the final
 * backup file path.
 *
 * WARNING: throws on any failure — an unset or unwritable `backupDir`, a
 * `VACUUM INTO` error, or a failed rename. The caller must treat a thrown
 * error here as "stop before credit, exit non-zero" (SPEC.md §13.2).
 */
export function backupDatabase(
  db: BetterSqlite3.Database,
  backupDir: string,
  now: Date = new Date(),
): string {
  if (!backupDir) {
    throw new Error('backupDatabase: BACKUP_DIR is not set')
  }
  fs.mkdirSync(backupDir, { recursive: true })

  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const finalPath = path.join(backupDir, `audit-${stamp}.db`)
  const tempPath = path.join(backupDir, `.audit-${stamp}-${randomUUID()}.db.tmp`)

  // The filename is a bound parameter, not string-interpolated SQL — SQLite
  // accepts a bound parameter in a VACUUM INTO's filename clause.
  db.prepare('VACUUM INTO ?').run(tempPath)
  fs.renameSync(tempPath, finalPath)

  return finalPath
}
