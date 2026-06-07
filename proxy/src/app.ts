// proxy/src/app.ts
import { Hono } from 'hono'
import statusRouter from './routes/status.js'
import { proxyToNpm } from './proxy.js'

const app = new Hono()

app.route('/api/v1/status', statusRouter)

// Fallback: proxy everything else to npm
app.all('*', (c) => proxyToNpm(c))

export default app
