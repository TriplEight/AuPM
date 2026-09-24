import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertBalanceAtLeastMinClaim,
  assertSignerIsMappedAddress,
  balanceBoxName,
  buildClaimCallRefs,
  decodeBoxAddress,
  decodeBoxUint64,
  identityBoxName,
  MIN_CLAIM,
  MIN_CLAIM_FEE,
  resolveOuterFee,
} from './claim.mjs'
import { assertMainnetConfirmed, parseNetworkFlag } from './network.mjs'
import { assertNetworkMatchesGenesis } from './rekey-payto.mjs'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = requireFromProxy('algosdk')

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRootEnvPath = path.join(scriptsDir, '..', '.env')
const claimModuleHref = pathToFileURL(path.join(scriptsDir, 'claim.mjs')).href

// The root .env path is fixed (derived from each module's own real file
// location), and node:test runs each test file in its own process, so this
// test and rekey-payto.test.mjs's identical one could otherwise race on the
// same file. An exclusive lock directory (mkdir is atomic) serializes them.
const envFileLockPath = path.join(scriptsDir, '..', '.env.test-lock')

async function withEnvFileLock(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(envFileLockPath)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (attempt > 400) throw new Error(`timed out waiting for ${envFileLockPath}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmdirSync(envFileLockPath)
  }
}

// R3a Result 2: the module must never read the root .env just because a
// caller imports it — only main() (the CLI entry path) may. A regression
// here would make scripts/verify.sh inherit a real donor key through this
// module's own import chain (claim.mjs's own former top-level load).
test('importing claim.mjs does not load the root .env or mutate process.env', async () => {
  await withEnvFileLock(async () => {
    const marker = 'SPM_TEST_ENV_MUTATION_MARKER'
    const hadEnvFile = fs.existsSync(repoRootEnvPath)
    const originalContent = hadEnvFile ? fs.readFileSync(repoRootEnvPath, 'utf8') : null
    fs.writeFileSync(repoRootEnvPath, `${marker}=leaked\n`, { flag: 'a' })
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import(${JSON.stringify(claimModuleHref)}).then(() => ` +
            `process.stdout.write(process.env.${marker} ?? ''))`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`)
      assert.equal(
        result.stdout.trim(),
        '',
        `importing claim.mjs must never load the root .env (leaked: ${JSON.stringify(result.stdout)})`,
      )
    } finally {
      if (hadEnvFile) fs.writeFileSync(repoRootEnvPath, originalContent)
      else fs.rmSync(repoRootEnvPath, { force: true })
    }
  })
})

test('assertBalanceAtLeastMinClaim refuses a balance below MIN_CLAIM', () => {
  assert.throws(() => assertBalanceAtLeastMinClaim(MIN_CLAIM - 1), /below MIN_CLAIM/)
})

test('assertBalanceAtLeastMinClaim passes at exactly MIN_CLAIM', () => {
  assert.doesNotThrow(() => assertBalanceAtLeastMinClaim(MIN_CLAIM))
})

test('assertBalanceAtLeastMinClaim passes above MIN_CLAIM', () => {
  assert.doesNotThrow(() => assertBalanceAtLeastMinClaim(MIN_CLAIM + 1))
})

test('assertSignerIsMappedAddress refuses an unmapped identity', () => {
  assert.throws(() => assertSignerIsMappedAddress(null, 'SIGNER_ADDR'), /not mapped to any address/)
})

test('assertSignerIsMappedAddress refuses a signer that is not the mapped address', () => {
  assert.throws(
    () => assertSignerIsMappedAddress('MAPPED_ADDR', 'OTHER_ADDR'),
    /not the address mapped to this identity/,
  )
})

test('assertSignerIsMappedAddress passes when the signer is the mapped address', () => {
  assert.doesNotThrow(() => assertSignerIsMappedAddress('SAME_ADDR', 'SAME_ADDR'))
})

test('resolveOuterFee raises a fee below MIN_CLAIM_FEE up to the floor', () => {
  assert.equal(resolveOuterFee(1_000), MIN_CLAIM_FEE)
})

test('resolveOuterFee leaves a fee at exactly MIN_CLAIM_FEE unchanged', () => {
  assert.equal(resolveOuterFee(MIN_CLAIM_FEE), MIN_CLAIM_FEE)
})

test('resolveOuterFee leaves a fee above MIN_CLAIM_FEE unchanged', () => {
  assert.equal(resolveOuterFee(5_000), 5_000)
})

test('identityBoxName and balanceBoxName encode the literal prefix, not ARC-4 length-prefixed', () => {
  assert.deepEqual(identityBoxName('ops'), new TextEncoder().encode('id:ops'))
  assert.deepEqual(balanceBoxName('ops'), new TextEncoder().encode('bal:ops'))
})

test('decodeBoxUint64 decodes the 8-byte big-endian value the contract writes', () => {
  const bytes = algosdk.encodeUint64(250_000)
  assert.equal(decodeBoxUint64(bytes, algosdk), 250_000)
})

test('decodeBoxAddress decodes the raw 32-byte public key back to its address string', () => {
  const account = algosdk.generateAccount()
  const addressBytes = algosdk.decodeAddress(account.addr.toString()).publicKey
  assert.equal(decodeBoxAddress(addressBytes, algosdk), account.addr.toString())
})

test('buildClaimCallRefs carries exactly the two boxes, one account and one asset claim() needs', () => {
  const refs = buildClaimCallRefs('github:alice', 'PAYTO_ADDR', 31566704n)
  assert.deepEqual(refs.boxes, [
    { appIndex: 0, name: identityBoxName('github:alice') },
    { appIndex: 0, name: balanceBoxName('github:alice') },
  ])
  assert.deepEqual(refs.accounts, ['PAYTO_ADDR'])
  assert.deepEqual(refs.assets, [31566704n])
})

// claim.mjs's main() runs this exact sequence (parseNetworkFlag then
// assertMainnetConfirmed) before it reads any mnemonic or touches algod —
// mirrors rekey-payto.test.mjs's own equivalent coverage.
test('a MainNet run refuses without --confirm-mainnet', () => {
  const argv = ['ops', 'OPS_CLAIM_MNEMONIC', '--network', 'mainnet']
  const network = parseNetworkFlag(argv)
  assert.throws(() => assertMainnetConfirmed(network, argv), /--confirm-mainnet/)
})

test('a MainNet run proceeds past the guard with --confirm-mainnet', () => {
  const argv = ['ops', 'OPS_CLAIM_MNEMONIC', '--network', 'mainnet', '--confirm-mainnet']
  const network = parseNetworkFlag(argv)
  assert.doesNotThrow(() => assertMainnetConfirmed(network, argv))
})

// claim.mjs's main() checks the connected algod's genesis id against
// --network right after building the algod client, the same guard
// scripts/rekey-payto.mjs uses (imported directly, not duplicated).
test('a TestNet run refuses against a MainNet algod', () => {
  assert.throws(
    () => assertNetworkMatchesGenesis('testnet', 'mainnet-v1.0'),
    /does not match NETWORK=testnet/,
  )
})

test('a TestNet run proceeds when the algod genesis id matches', () => {
  assert.doesNotThrow(() => assertNetworkMatchesGenesis('testnet', 'testnet-v1.0'))
})
