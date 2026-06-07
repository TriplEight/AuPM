// proxy/src/seed.ts
// Demo seed script — populates audit_status for the SPM demo
// Run: cd proxy && npx tsx src/seed.ts

import { setStatus } from './status.js'
import db from './db.js'

// Clear existing demo entries
db.exec(`DELETE FROM audit_status WHERE pkg IN ('lodash', 'express', 'chalk')`)

// PAID: lodash 4.17.21 is community-reviewed
setStatus(
  'lodash',
  '4.17.21',
  'COMMUNITY_REVIEWED',
  'AUDITOR_PLACEHOLDER_ADDR',
  'ATTEST_TXID_PLACEHOLDER',
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
