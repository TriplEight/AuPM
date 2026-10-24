// proxy/src/claims/auditor-main.ts
//
// The operator CLI that adds the review address of an auditor and lists the auditors. It needs
// no key and no network. The logic sits in auditor-cli.ts; this file wires the real dependencies.
//
// Run with: pnpm -C proxy auditor add <github:login> <address>
//           pnpm -C proxy auditor list

import { createInterface } from 'node:readline/promises'
import db from '../db.js'
import { runAuditorCli } from './auditor-cli.js'
import { addAuditor, getAuditorReviewAddress, listAuditors } from './ledger.js'

async function main(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runAuditorCli(process.argv.slice(2), {
      addAuditor,
      getAuditorReviewAddress,
      listAuditors,
      prompt: (question) => rl.question(question),
      now: () => Date.now(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } finally {
    rl.close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error('aupm-auditor: failed —', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
