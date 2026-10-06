// proxy/src/routes/health.ts
//
// GET /api/v1/health (item N1.6, ADR 0009): free, unauthenticated, never
// gated — mirrors routes/status.ts. Reports the nightly job's last run and
// last success. Returns 200 when the last successful run started at most
// HEALTHY_SUCCESS_MAX_AGE_MS ago, else 503 — an operator's monitoring
// polls this instead of reading server logs. The body also carries the
// release `version` and `commit` of the running image (build-info.ts).

import { Hono } from 'hono'
import { type BuildInfo, buildInfo } from '../build-info.js'
import {
  getLastNightlyRun,
  getLastSuccessfulNightlyRun,
  type NightlyRunRow,
} from '../claims/schema.js'

export const HEALTHY_SUCCESS_MAX_AGE_MS = 26 * 60 * 60 * 1000

type NightlyRunView = {
  startedAt: number
  endedAt: number | null
  result: NightlyRunRow['result']
  error: string | null
  batchSeq: number | null
  creditTxid: string | null
}

function toRunView(run: NightlyRunRow): NightlyRunView {
  return {
    startedAt: run.started_at,
    endedAt: run.ended_at,
    result: run.result,
    error: run.error,
    batchSeq: run.batch_seq,
    creditTxid: run.credit_txid,
  }
}

export function createHealthRouter(info: BuildInfo): Hono {
  const router = new Hono()
  router.get('/', (c) => {
    const lastRun = getLastNightlyRun()
    const lastSuccess = getLastSuccessfulNightlyRun()
    const healthy =
      lastSuccess !== undefined && Date.now() - lastSuccess.started_at <= HEALTHY_SUCCESS_MAX_AGE_MS

    return c.json(
      {
        version: info.version,
        commit: info.commit,
        lastRun: lastRun ? toRunView(lastRun) : null,
        lastSuccess: lastSuccess ? toRunView(lastSuccess) : null,
      },
      healthy ? 200 : 503,
    )
  })

  return router
}

export default createHealthRouter(buildInfo)
