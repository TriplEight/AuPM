---
name: aupm-x402-flow
description: >
  How AuPM does the x402 402->pay->retry round-trip on Algorand with the
  @x402-avm packages. Use for the proxy routes, the MCP/CLI payer, payment
  requirements, headers, Bazaar discovery, and facilitator settlement.
---
# x402 on Algorand for AuPM

## Packages (scoped — exact names)
`@x402-avm/core`, `@x402-avm/avm`, `@x402-avm/hono` (server middleware),
`@x402-avm/fetch` (client auto-handles 402), `@x402-avm/extensions` (Bazaar discovery).
All pinned to the same version, currently 2.6.1. NOT `@x402/*`.

From `@x402-avm/avm` import `ALGORAND_MAINNET_CAIP2` and `USDC_MAINNET_ASA_ID`
("31566704"). TestNet equivalents exist for rehearsal, selected by the `NETWORK`
environment variable.

## Server: paid route configuration
```
scheme: "exact"
network: ALGORAND_MAINNET_CAIP2
payTo: PAY_TO_ADDRESS               // fixed for the whole competition
price: "$0.001"                     // USD string, or a DynamicPrice function (lockfile)
maxTimeoutSeconds: 120
extra: {
  asset: USDC_MAINNET_ASA_ID,       // WARNING: never omit. A missing asset may resolve to ALGO.
  feePayer: <read from facilitator getSupported() at boot>,
  tag: "x402-global-challenge",     // attribution, written at settlement, not retroactive
}
```
CAUTION: the facilitator client method is `getSupported()`, not `supported()`.

Price: 1,000 microUSDC per reviewed package on every route (SPEC §11.2, ADR 0008).
The lockfile route uses a `DynamicPrice` function: 1,000 × reviewed entries, no cap, no
discount. `@x402-avm/core` 2.6.1 resolves a function price per request, and the Hono
adapter implements `getBody()`. A lockfile with zero reviewed packages is free.

Gate logic (SPEC §10.4, ADR 0006):
- Status below `COMMUNITY_REVIEWED` means passthrough, free, on every route.
- Reviewed tarball: free unless the request sends `X-AuPM-Donate: 1`. npm cannot pay a 402.
- Attestation routes: standard x402 for reviewed content, so Bazaar agents can pay.
  `X-AuPM-Donate: 0` gets a free partial attestation (pre-middleware).

The free tier must never require a wallet. Grant it with the `onProtectedRequest` hook,
which returns `{ grantAccess: true }`. A static route config alone always demands payment.

## Bazaar discovery
Attach `declareDiscoveryExtension` per route. It always returns its result under the key
`bazaar`, so spread it into the route's `extensions` field. No separate registration call
is needed. WARNING: a malformed declaration fails silently. Payments still settle, but
the catalog row never appears. Assert `validateDiscoveryExtension(decl.bazaar).valid`
in a unit test.

## Client (agent / CLI)
AuPM clients send `X-AuPM-Donate: 1` with the donation opt-in and `X-AuPM-Donate: 0`
without it. Spend cap: 1,000 microUSDC × the lockfile entries sent (1,000 for one package),
USDC only.

On 402, decode the requirements and pay with `wrapFetchWithPayment` from
`@x402-avm/fetch`. The payment is a **plain USDC asset transfer to payTo**. The
facilitator adds its own fee-payer transaction and submits the group.

WARNING: do not build a group of `[axfer, appcall pay(...)]`. The facilitator validates
a 2-transaction shape and rejects that group. No configuration flag changes this.

Retry the request once with the payment header. CAUTION: never retry a 402 more than
once. Retry storms are classified as `DEV` traffic and are discarded.

## Settlement (server)
`HTTPFacilitatorClient({ url: FACILITATOR_URL })` plus `registerExactAvmScheme` on the
resource server. The facilitator is MANDATORY and performs verification and settlement.

WARNING: there is no direct-submit fallback and no local facilitator. Never add a code
path that submits a payment group with algosdk. The former `proxy/src/settle.ts` did
that and was an authentication bypass. It is deleted, not repaired.

Revenue is never split per payment. USDC accrues at `payTo`. The nightly job credits it
to PaymentRouter in numbered batches (MVP 40 auditor / 60 ops); payees claim.

Verified in the installed middleware, so add no workaround:
- A failed settlement discards the handler body.
- A handler status of 400 or higher skips settlement entirely.

## Money rule
All on-chain amounts are integer micro-unit strings. Never use floats.
