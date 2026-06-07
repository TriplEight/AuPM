// proxy/src/app.ts
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from '@x402-avm/avm'
import statusRouter from './routes/status.js'
import { proxyToNpm } from './proxy.js'
import { getStatusOrUnreviewed, isFree } from './status.js'
import { settle } from './settle.js'

type AppVariables = {
  paymentHeader?: string
  settlementTxid?: string
}

const app = new Hono<{ Variables: AppVariables }>()

app.route('/api/v1/status', statusRouter)

function isTarball(path: string): boolean {
  return path.includes('/-/') && path.endsWith('.tgz')
}

function parseTarballPath(urlPath: string): { pkg: string; version: string } {
  // Examples:
  //   /lodash/-/lodash-4.17.21.tgz      → pkg=lodash, ver=4.17.21
  //   /@scope/pkg/-/pkg-1.0.0.tgz       → pkg=@scope/pkg, ver=1.0.0
  const parts = urlPath.replace(/^\//, '').split('/-/')
  const pkg = (parts[0] ?? '').replace(/%40/g, '@')
  const filename = parts[1] ?? ''
  // Extract version: everything after the last hyphen before .tgz that looks like semver
  const match = filename.match(/^.+?-(\d+\.\d+\.\d+.*)\.tgz$/)
  const version = match?.[1] ?? 'unknown'
  return { pkg, version }
}

// x402 gate middleware
app.use('*', async (c, next) => {
  if (!isTarball(c.req.path)) return next()

  const { pkg, version } = parseTarballPath(c.req.path)
  const row = getStatusOrUnreviewed(pkg, version)

  if (isFree(row.status)) return next()

  // Paid tier — check for payment header (PAYMENT-SIGNATURE = USDC, X-PAYMENT = EURD bridge)
  const paymentHeader = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT')
  if (!paymentHeader) {
    const accepts: object[] = [
      {
        scheme: 'exact',
        network: ALGORAND_TESTNET_CAIP2,
        payTo: process.env['SPLIT_APP_ADDRESS'] ?? '',
        asset: String(USDC_TESTNET_ASA_ID),
        maxAmountRequired: '1000',
        maxTimeoutSeconds: 60,
        extra: {
          name: 'USDC',
          decimals: 6,
          appMethod: 'pay',
          args: [pkg, version],
        },
      },
    ]
    // EURD bonus: advertise Quantoz bridge path when configured
    const eurdAsaId = process.env['EURD_MAINNET_ASA_ID']
    const eurdPayTo = process.env['EURD_PAY_TO']
    if (eurdAsaId && eurdPayTo) {
      accepts.push({
        scheme: 'exact',
        network: 'algorand:mainnet',
        payTo: eurdPayTo,
        asset: eurdAsaId,
        maxAmountRequired: '1', // 1 atomic EURD = €0.01 (2 decimals)
        maxTimeoutSeconds: 120,
        extra: { name: 'EURD', decimals: 2 },
      })
    }
    return c.json({ x402Version: 2, accepts }, 402)
  }

  // Has payment header — settle the payment before proxying
  const result = await settle(paymentHeader)
  if (!result.success) {
    return c.json({ error: result.error }, 402 as ContentfulStatusCode)
  }
  c.set('settlementTxid', result.txid)
  return next()
})

// Proxy handler
app.all('*', async (c) => {
  const response = await proxyToNpm(c)
  const txid = c.get('settlementTxid') as string | undefined
  if (txid) {
    const headers = new Headers(response.headers)
    headers.set('X-AUDIT-ATTESTATION', txid)
    return new Response(response.body, { status: response.status, headers })
  }
  return response
})

export default app
