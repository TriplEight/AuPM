// proxy/src/index.ts
//
// Production entrypoint. Boots the facilitator connection before the port
// ever opens: the spec requires the server to refuse to boot when the
// facilitator's supported kinds lack MainNet "exact" (see boot() in
// proxy/src/x402/server.ts). serve() runs only after boot() resolves.
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import {
  assertValidIssuerUrl,
  assertValidKeyValidFrom,
  assertValidPayTo,
  FACILITATOR_URL,
} from './config.js'
import { boot } from './x402/server.js'

const PORT = Number(process.env.PORT ?? 4873)

async function main(): Promise<void> {
  // Local boot guards: cheap, no I/O — checked before the facilitator boot
  // guard's network call. payTo is the leaderboard key (CLAUDE.md invariant
  // 1); SPM_ISSUER_URL and SPM_KEY_VALID_FROM are published on every signed
  // attestation and cannot be corrected after the fact (SPEC.md 12).
  // A missing or malformed value must stop boot here, not surface as an
  // unpayable 402 or a bad attestation to a real caller. A separate
  // try/catch keeps this failure's log free of the facilitator, which was
  // never contacted.
  try {
    assertValidPayTo()
    assertValidIssuerUrl()
    assertValidKeyValidFrom()
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
