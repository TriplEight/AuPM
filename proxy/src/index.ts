// proxy/src/index.ts
//
// Production entrypoint. Boots the facilitator connection before the port
// ever opens: the spec requires the server to refuse to boot when the
// facilitator's supported kinds lack MainNet "exact" (see boot() in
// proxy/src/x402/server.ts). serve() runs only after boot() resolves.
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { buildRealNightlyDeps } from './claims/nightly-wiring.js'
import { startNightlyScheduler } from './claims/scheduler.js'
import {
  assertValidIssuerUrl,
  assertValidKeyValidFrom,
  assertValidPayTo,
  FACILITATOR_URL,
} from './config.js'
import { boot } from './x402/server.js'

const PORT = Number(process.env.PORT ?? 4873)

type NightlyMode = 'on' | 'off'

/**
 * Boot guard (pure function, no I/O). SPM_NIGHTLY controls only the
 * in-process nightly scheduler (item N1, ADR 0009) — unset or "on" runs
 * it, "off" disables it and logs one line instead. Any other value refuses
 * to boot, the same fail-fast style as assertValidPayTo and the other
 * guards below: a typo here must never silently disable the schedule.
 */
function resolveNightlyMode(value: string | undefined): NightlyMode {
  if (value === undefined || value === 'on') return 'on'
  if (value === 'off') return 'off'
  throw new Error(
    `x402 boot guard: SPM_NIGHTLY must be "on" or "off" (got ${JSON.stringify(value)}); ` +
      'unset it or set it to "on" to run the nightly scheduler, or "off" to disable it',
  )
}

async function main(): Promise<void> {
  // Local boot guards: cheap, no I/O — checked before the facilitator boot
  // guard's network call. payTo is the leaderboard key (CLAUDE.md invariant
  // 1); SPM_ISSUER_URL and SPM_KEY_VALID_FROM are published on every signed
  // attestation and cannot be corrected after the fact (SPEC.md 12).
  // A missing or malformed value must stop boot here, not surface as an
  // unpayable 402 or a bad attestation to a real caller. A separate
  // try/catch keeps this failure's log free of the facilitator, which was
  // never contacted.
  let nightlyMode: NightlyMode
  try {
    assertValidPayTo()
    assertValidIssuerUrl()
    assertValidKeyValidFrom()
    nightlyMode = resolveNightlyMode(process.env.SPM_NIGHTLY)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // WARNING: never call serve() here. An invalid payTo must stop the
    // process before the port binds, not fail a paying caller's first
    // request.
    console.error(`[x402] boot failed: ${reason}`)
    process.exit(1)
    return
  }

  try {
    const { httpServer } = await boot()
    const app = createApp(httpServer)

    serve({ fetch: app.fetch, port: PORT }, () => {
      console.log(`SPM proxy listening on http://localhost:${PORT}`)
    })

    // The in-process nightly scheduler (item N1, ADR 0009): daily at 03:17
    // UTC, plus a start-up catch-up run when the last successful run is
    // more than 24 hours old or none exists. Never awaited — a slow or
    // failing run must never delay the port opening above, and
    // runNightlyWithLease itself never throws (item N1.3).
    if (nightlyMode === 'off') {
      console.log('spm-nightly: scheduler off (SPM_NIGHTLY=off)')
    } else {
      startNightlyScheduler(buildRealNightlyDeps())
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // WARNING: never call serve() here. A misconfigured facilitator must
    // stop the process before the port binds, not fail a paying caller's
    // first request.
    console.error(`[x402] boot failed: facilitator ${FACILITATOR_URL} refused to boot: ${reason}`)
    process.exit(1)
  }
}

void main()
