// Shared network selection for every operator script (Q10). NETWORK
// (env var or --network flag) picks the USDC asset id and the algod
// endpoint. A script that signs and sends a transaction on MainNet must
// call assertMainnetConfirmed() before it does — see the module banner
// on each caller for which of its actions that covers.
//
// scripts/ has no node_modules of its own; requireFromProxy anchors a CJS
// require() at the proxy workspace, which already depends on @x402-avm/avm
// (mirrors scripts/e2e.mjs and scripts/check-402.mjs).

import { createRequire } from 'node:module'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))

export const NETWORKS = ['testnet', 'mainnet']

/**
 * Reads the network from an explicit `--network <value>` CLI flag, falling
 * back to the NETWORK environment variable, then to "mainnet" — the same
 * default proxy/src/config.ts uses, so an unset NETWORK never silently
 * rehearses forever on either side of the system.
 *
 * @param {string[]} argv - process.argv.slice(2) or equivalent.
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env.
 * @returns {'testnet'|'mainnet'}
 */
export function parseNetworkFlag(argv, env = process.env) {
  const idx = argv.indexOf('--network')
  if (idx !== -1) {
    const value = argv[idx + 1]
    if (!value || !NETWORKS.includes(value)) {
      throw new Error(
        `--network must be one of ${NETWORKS.join(', ')}, got ${JSON.stringify(value)}`,
      )
    }
    return value
  }
  const fromEnv = env.NETWORK
  if (fromEnv) {
    if (!NETWORKS.includes(fromEnv)) {
      throw new Error(
        `NETWORK must be one of ${NETWORKS.join(', ')}, got ${JSON.stringify(fromEnv)}`,
      )
    }
    return fromEnv
  }
  return 'mainnet'
}

/**
 * The USDC ASA id for `network`, read from @x402-avm/avm — never
 * hardcoded here (CLAUDE.md: MainNet USDC ASA is 31566704, TestNet
 * 10458941, rehearsal only).
 *
 * @param {'testnet'|'mainnet'} network
 * @returns {string}
 */
export function usdcAssetId(network) {
  const { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } = requireFromProxy('@x402-avm/avm')
  return network === 'testnet' ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID
}

/**
 * The CAIP-2 network id for `network`, read from @x402-avm/avm.
 *
 * @param {'testnet'|'mainnet'} network
 * @returns {string}
 */
export function caip2NetworkId(network) {
  const { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } = requireFromProxy('@x402-avm/avm')
  return network === 'testnet' ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2
}

/**
 * The algod endpoint for `network`. ALGOD_SERVER/ALGOD_PORT/ALGOD_TOKEN in
 * `env` override the per-network default, matching every script that
 * already reads them this way (scripts/e2e.mjs, scripts/optin-usdc.mjs).
 *
 * @param {'testnet'|'mainnet'} network
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env.
 * @returns {{server: string, port: number, token: string}}
 */
export function algodEndpoint(network, env = process.env) {
  return {
    server:
      env.ALGOD_SERVER ??
      (network === 'testnet'
        ? 'https://testnet-api.algonode.cloud'
        : 'https://mainnet-api.algonode.cloud'),
    port: Number(env.ALGOD_PORT ?? 443),
    token: env.ALGOD_TOKEN ?? '',
  }
}

/**
 * The Algorand indexer endpoint for `network`. INDEXER_URL/INDEXER_TOKEN in
 * `env` override the per-network default (`.env.example`) — used by
 * scripts/record-review.mjs to read a confirmed review anchor. Mirrors
 * algodEndpoint's override shape, with its own single-purpose env vars, so
 * an indexer override never accidentally repoints the algod client too.
 *
 * @param {'testnet'|'mainnet'} network
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env.
 * @returns {{server: string, port: number, token: string}}
 */
export function indexerEndpoint(network, env = process.env) {
  return {
    server:
      env.INDEXER_URL ??
      (network === 'testnet'
        ? 'https://testnet-idx.algonode.cloud'
        : 'https://mainnet-idx.algonode.cloud'),
    port: Number(env.INDEXER_PORT ?? 443),
    token: env.INDEXER_TOKEN ?? '',
  }
}

/**
 * True when `argv` carries the `--confirm-mainnet` flag.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasConfirmMainnetFlag(argv) {
  return argv.includes('--confirm-mainnet')
}

/**
 * Refuses a MainNet action (anything that signs and sends a transaction)
 * unless the operator passed `--confirm-mainnet`. A no-op on TestNet: only
 * MainNet spends real funds against the leaderboard key.
 *
 * @param {'testnet'|'mainnet'} network
 * @param {string[]} argv
 * @throws {Error} when network is "mainnet" and --confirm-mainnet is absent.
 */
export function assertMainnetConfirmed(network, argv) {
  if (network === 'mainnet' && !hasConfirmMainnetFlag(argv)) {
    throw new Error(
      'refusing a MainNet action without --confirm-mainnet: re-run with --confirm-mainnet to proceed',
    )
  }
}
