// proxy/src/routes/status.ts
import { Hono } from 'hono'
import { getStatusOrUnreviewed } from '../status.js'

const router = new Hono()

// Scoped packages: /api/v1/status/@scope/pkg/version
// npm encodes @ as %40; Hono decodes path params automatically
router.get('/:scope/:pkg/:version', (c) => {
  const { scope, pkg, version } = c.req.param()
  const fullPkg = `${scope}/${pkg}`
  return c.json(getStatusOrUnreviewed(fullPkg, version))
})

// Unscoped packages: /api/v1/status/pkg/version
router.get('/:pkg/:version', (c) => {
  const { pkg, version } = c.req.param()
  return c.json(getStatusOrUnreviewed(pkg, version))
})

export default router
