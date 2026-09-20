// proxy/src/seed.ts
// Demo seed script — populates audit_status for the SPM demo
// Run: cd proxy && npx tsx src/seed.ts

import db from './db.js'
import { setStatus } from './status.js'

// Clear existing demo entries
db.exec(`DELETE FROM audit_status WHERE pkg IN ('lodash', 'express', 'chalk')`)

// PAID: lodash 4.17.21 is community-reviewed. The integrity below is the
// actual npm-registry integrity for this exact tarball — a seeded review is
// a real review (CLAUDE.md), and a row with no stored integrity is treated
// as UNREVIEWED (status.ts's isReviewedWithIntegrity()).
//
// `reviewer` carries the human reviewer's GitHub login, so the auditor's
// 50% share accrues against an identity the ledger and the earnings
// endpoint can find (`github:<login>`). `auditor_addr` records a different
// fact — the on-chain attesting address — and is not looked up by either.
setStatus(
  'lodash',
  '4.17.21',
  'COMMUNITY_REVIEWED',
  'AUDITOR_PLACEHOLDER_ADDR',
  'ATTEST_TXID_PLACEHOLDER',
  'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==',
  'REVIEWER_PLACEHOLDER_LOGIN',
)

// FREE: lodash 4.17.20 is unreviewed (demonstrates version bump resets status)
// No entry needed — missing row = UNREVIEWED by auto-reset rule

// FREE: express 4.21.2 is unreviewed (free passthrough demo)
// No entry needed — missing row = UNREVIEWED by auto-reset rule

console.log('Demo data seeded:')
console.log('  lodash@4.17.21 → COMMUNITY_REVIEWED (PAID)')
console.log('  lodash@4.17.20 → UNREVIEWED (FREE) — demonstrates version-bump reset')
console.log('  express@4.21.2 → UNREVIEWED (FREE) — demonstrates free passthrough')
console.log('\nNow start the proxy and try:')
console.log('  curl http://localhost:4873/api/v1/status/lodash/4.17.21')
console.log('  curl -I http://localhost:4873/lodash/-/lodash-4.17.21.tgz  # → 402')
console.log('  curl -I http://localhost:4873/lodash/-/lodash-4.17.20.tgz  # → passthrough')
