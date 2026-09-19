// proxy/src/x402/server.ts
//
// Wires the GoPlausible facilitator, the AVM exact scheme, the paid route
// table, and the tarball free-tier hook into an x402HTTPResourceServer.
//
// The facilitator is mandatory (CLAUDE.md invariant 6). There is no local
// facilitator and no direct chain submission — the former proxy/src/settle.ts
// did that and was an authentication bypass; it is deleted, not repaired.

import { registerExactAvmScheme } from '@x402-avm/avm/exact/server'
import { x402HTTPResourceServer } from '@x402-avm/core/http'
import type { FacilitatorClient } from '@x402-avm/core/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402-avm/core/server'
import { CAIP2_NETWORK, FACILITATOR_URL, resolveFeePayer } from '../config.js'
import { buildRoutes } from './routes.js'
import { tarballFreeTierHook } from './tarball.js'

export type BootResult = {
  httpServer: x402HTTPResourceServer
  resourceServer: x402ResourceServer
  feePayer: string
}

/**
 * Build the resource server + HTTP server from an already-resolved fee
 * payer. Pure wiring, no I/O — used directly by tests with a stubbed
 * facilitator client.
 */
export function buildHttpServer(
  facilitatorClient: FacilitatorClient,
  feePayer: string,
): { httpServer: x402HTTPResourceServer; resourceServer: x402ResourceServer } {
  const resourceServer = new x402ResourceServer(facilitatorClient)
  registerExactAvmScheme(resourceServer)

  const routes = buildRoutes(feePayer)
  const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  httpServer.onProtectedRequest(tarballFreeTierHook)

  return { httpServer, resourceServer }
}

/**
 * Boot guard. Calls the facilitator's getSupported(), resolves the fee
 * payer for the configured network's "exact" scheme, logs it, and wires
 * the full HTTP resource server.
 *
 * WARNING: this performs a network call (getSupported()). Never invoke it
 * from module-load / import-time code that tests also import — call it
 * lazily, on first request, from proxy/src/app.ts.
 */
export async function boot(facilitatorClient?: FacilitatorClient): Promise<BootResult> {
  const client = facilitatorClient ?? new HTTPFacilitatorClient({ url: FACILITATOR_URL })
  const supported = await client.getSupported()
  const feePayer = resolveFeePayer(supported, CAIP2_NETWORK)
  // biome-ignore lint/suspicious/noConsole: boot-time diagnostic, required by spec (log the resolved feePayer)
  console.log(`[x402] resolved feePayer for ${CAIP2_NETWORK}: ${feePayer}`)

  const { httpServer, resourceServer } = buildHttpServer(client, feePayer)
  return { httpServer, resourceServer, feePayer }
}
