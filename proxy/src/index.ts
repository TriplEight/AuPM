// proxy/src/index.ts
import { serve } from '@hono/node-server'
import app from './app.js'

const PORT = Number(process.env['PORT'] ?? 4873)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`SPM proxy listening on http://localhost:${PORT}`)
})
