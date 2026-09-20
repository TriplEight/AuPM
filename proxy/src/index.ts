// proxy/src/index.ts
//
// Production entrypoint. Boots the facilitator connection before the port
// ever opens: the spec requires the server to refuse to boot when the
// facilitator's supported kinds lack MainNet "exact" (see boot() in
// proxy/src/x402/server.ts). serve() runs only after boot() resolves.
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { FACILITATOR_URL } from './config.js'
import { boot } from './x402/server.js'

const PORT = Number(process.env.PORT ?? 4873)

async function main(): Promise<void> {
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
