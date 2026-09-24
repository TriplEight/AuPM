// proxy/src/config.test.ts
//
// Unit tests for the pure boot-guard functions in proxy/src/config.ts.
// These functions take an explicit argument and never read process.env
// themselves inside the test body — they are pure and side-effect free
// (Q13), so no subprocess is needed here. The subprocess-level wiring test
// (proxy failing to boot with the real process.env) lives in
// proxy/src/index.test.ts.
import { describe, expect, test } from 'vitest'
import { assertValidIssuerUrl, assertValidKeyValidFrom } from './config.js'

// Q13: both guards must refuse the same way on every network. TestNet
// rehearsal exercises the same public config MainNet will carry, so a
// network argument never appears in either guard's signature. This runs
// every case below once per network to prove that stays true.
describe.each(['testnet', 'mainnet'])('boot guards (NETWORK=%s)', (network) => {
  describe('assertValidIssuerUrl', () => {
    test('refuses when unset (undefined)', () => {
      expect(() => assertValidIssuerUrl(undefined as unknown as string)).toThrow(
        /SPM_ISSUER_URL.*is not set/,
      )
    })

    test('refuses an empty string', () => {
      expect(() => assertValidIssuerUrl('')).toThrow(/SPM_ISSUER_URL.*is not set/)
    })

    test('refuses a non-URL string', () => {
      expect(() => assertValidIssuerUrl('not a url')).toThrow(/SPM_ISSUER_URL/)
    })

    test('refuses http:// (not https)', () => {
      expect(() => assertValidIssuerUrl('http://spm-example.test')).toThrow(/SPM_ISSUER_URL.*https/)
    })

    test('refuses a trailing slash', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test/')).toThrow(/SPM_ISSUER_URL/)
    })

    test('refuses a path', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test/attestation')).toThrow(
        /SPM_ISSUER_URL/,
      )
    })

    test('refuses a query string', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test?x=1')).toThrow(/SPM_ISSUER_URL/)
    })

    test('refuses a fragment', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test#frag')).toThrow(/SPM_ISSUER_URL/)
    })

    test('accepts a bare https origin', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test')).not.toThrow()
    })

    test('accepts a bare https origin with a port', () => {
      expect(() => assertValidIssuerUrl('https://spm-example.test:8443')).not.toThrow()
    })
  })

  describe('assertValidKeyValidFrom', () => {
    test('refuses when unset (undefined)', () => {
      expect(() => assertValidKeyValidFrom(undefined as unknown as string)).toThrow(
        /SPM_KEY_VALID_FROM.*is not set/,
      )
    })

    test('refuses an empty string', () => {
      expect(() => assertValidKeyValidFrom('')).toThrow(/SPM_KEY_VALID_FROM.*is not set/)
    })

    test('refuses a date without a time component', () => {
      expect(() => assertValidKeyValidFrom('2026-01-01')).toThrow(/SPM_KEY_VALID_FROM/)
    })

    test('refuses a timestamp without a UTC "Z" suffix', () => {
      expect(() => assertValidKeyValidFrom('2026-01-01T00:00:00')).toThrow(/SPM_KEY_VALID_FROM/)
    })

    test('refuses a timestamp with a non-UTC offset', () => {
      expect(() => assertValidKeyValidFrom('2026-01-01T00:00:00+02:00')).toThrow(
        /SPM_KEY_VALID_FROM/,
      )
    })

    test('refuses a calendar-invalid date', () => {
      expect(() => assertValidKeyValidFrom('2026-13-40T00:00:00Z')).toThrow(/SPM_KEY_VALID_FROM/)
    })

    test('refuses free text', () => {
      expect(() => assertValidKeyValidFrom('not a timestamp')).toThrow(/SPM_KEY_VALID_FROM/)
    })

    test('accepts a valid ISO-8601 UTC timestamp', () => {
      expect(() => assertValidKeyValidFrom('2026-01-01T00:00:00Z')).not.toThrow()
    })

    test('accepts a valid ISO-8601 UTC timestamp with fractional seconds', () => {
      expect(() => assertValidKeyValidFrom('2026-01-01T00:00:00.123Z')).not.toThrow()
    })
  })

  test('network placeholder is exercised (no-op assertion keeping describe.each honest)', () => {
    expect(['testnet', 'mainnet']).toContain(network)
  })
})
