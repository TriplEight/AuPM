// proxy/src/routes/reviews.ts
//
// GET /api/v1/reviews?reviewer=<login>: free, unauthenticated, never gated.
// Lists the review records stored for one GitHub login, read from the SQLite
// status store. A field that a row lacks is null, never fabricated.

import { Hono } from 'hono'
import { getReviewsByReviewer } from '../db.js'

// GitHub login rules: 1-39 characters, alphanumeric or single hyphens, no
// leading or trailing hyphen.
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

const router = new Hono()

router.get('/', (c) => {
  const raw = c.req.query('reviewer') ?? ''
  const login = raw.replace(/^github:/i, '')
  if (!GITHUB_LOGIN.test(login)) {
    return c.json(
      { error: 'reviewer is missing or malformed; pass a GitHub login, e.g. ?reviewer=alice' },
      400,
    )
  }
  const reviews = getReviewsByReviewer.all(login).map((row) => ({
    name: row.pkg,
    version: row.version,
    status: row.status,
    scope: row.review_scope,
    anchorTxid: row.anchor_txid,
    reviewedAt: row.ts === null ? null : new Date(row.ts).toISOString(),
  }))
  return c.json({ reviewer: `github:${login.toLowerCase()}`, reviews })
})

export default router
