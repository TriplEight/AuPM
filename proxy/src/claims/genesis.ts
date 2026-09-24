// proxy/src/claims/genesis.ts
//
// Genesis-id guard for the nightly job (SPEC.md §13.2, R3c). An operator
// .env with NETWORK=testnet but ALGOD_SERVER/INDEXER_URL pointed at
// MainNet makes the nightly job reconcile and credit against the wrong
// chain. This is a pure comparison: callers fetch each component's own
// genesis id (nightly-main.ts) and hand it in here.
//
// This mirrors scripts/rekey-payto.mjs's own assertNetworkMatchesGenesis
// (used by deploy-config.ts, claim.mjs, and rekey-payto.mjs itself) rather
// than importing it: that file is plain JS with no type declarations
// (proxy/tsconfig.json has no `allowJs`), and proxy/Dockerfile's image for
// the nightly job (`docker compose run --rm proxy pnpm nightly`) does not
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
