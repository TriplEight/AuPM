// proxy/src/claims/genesis.ts
//
// Genesis-id guard for the nightly job (SPEC.md §13.2, R3c). An operator
// .env with NETWORK=testnet but ALGOD_SERVER/INDEXER_URL pointed at
// MainNet makes the nightly job reconcile and credit against the wrong
// chain. assertGenesisMatchesNetwork is a pure comparison; fetchGenesisId
// is the (injectable, testable) HTTP read nightly-main.ts wires with the
// real `fetch` — kept here rather than in nightly-main.ts (which is never
// imported by a test) so the fetch-and-parse logic, including the
// dedicated missing/empty "genesis-id" error, has its own coverage
// (genesis.test.ts) against the real response shapes.
//
// This mirrors scripts/rekey-payto.mjs's own assertNetworkMatchesGenesis
// (used by deploy-config.ts, claim.mjs, and rekey-payto.mjs itself) rather
// than importing it: that file is plain JS with no type declarations
// (proxy/tsconfig.json has no `allowJs`), and proxy/Dockerfile's image for
// the nightly job (`docker compose run --rm spm pnpm nightly`) does not
// copy scripts/rekey-payto.mjs in — only scripts/record-review.mjs,
// scripts/review-anchor.mjs, and scripts/network.mjs. A second, small,
// independently tested copy of the same pure comparison is safer here than
// a cross-package import that would fail typecheck or be absent at runtime.

const GENESIS_ID: Readonly<Record<'mainnet' | 'testnet', string>> = {
  mainnet: 'mainnet-v1.0',
  testnet: 'testnet-v1.0',
}

export type ChainComponent = 'algod' | 'indexer'

/**
 * Refuses when `component`'s reported genesis id does not match `network`.
 * Pure: no network I/O — nightly-main.ts fetches genesisId itself, so this
 * stays unit-testable with a fabricated id (genesis.test.ts).
 *
 * The thrown message names NETWORK, the endpoint URL queried, the genesis
 * id `component` returned, and the env var that points `component` at the
 * wrong chain — an operator with, say, NETWORK=testnet and
 * ALGOD_SERVER=https://mainnet-api.algonode.cloud gets a message that says
 * exactly what to fix instead of a downstream "reconcile found 0 inflows"
 * or a false credit against the wrong chain's indexer.
 */
export function assertGenesisMatchesNetwork(
  component: ChainComponent,
  network: string,
  genesisId: string,
  endpointUrl: string,
  envVar: string,
): void {
  const expected = GENESIS_ID[network as 'mainnet' | 'testnet']
  if (genesisId !== expected) {
    throw new Error(
      `${component} genesis id "${genesisId}" from ${endpointUrl} does not match ` +
        `NETWORK=${network} (expected "${expected ?? '(unknown NETWORK)'}"); fix ${envVar} ` +
        '(or NETWORK) — refusing to reconcile or credit against a possibly wrong chain',
    )
  }
}

/**
 * Fetches `"genesis-id"` off `${endpointUrl}${path}`'s JSON response. A
 * missing or empty value is its own error, never returned as "" for a
 * caller to compare against a network (R3c fix attempt 1: the indexer's
 * `/health` carries no genesis-id at all — checked against the live
 * indexers — and a bare "" read as the genesis id produced a confusing
 * mismatch message instead of naming the real problem, the wrong endpoint
 * path). `fetchImpl` defaults to the real `fetch`; nightly-main.ts's own
 * tests (there are none — see this module's banner) never need it, but
 * genesis.test.ts injects a stub to exercise every branch without a real
 * algod or indexer.
 */
export async function fetchGenesisId(
  endpointUrl: string,
  path: string,
  token: string,
  tokenHeader: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(new URL(path, endpointUrl), {
    headers: token ? { [tokenHeader]: token } : {},
  })
  if (!res.ok) {
    throw new Error(`genesis check: GET ${endpointUrl}${path} returned HTTP ${res.status}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const value = body['genesis-id']
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`genesis check: GET ${endpointUrl}${path} returned no "genesis-id"`)
  }
  return value
}
