// proxy/src/attest/ratelimit.test.ts
import { describe, expect, test } from 'vitest'
import { createRateLimiter } from './ratelimit.js'

describe('createRateLimiter', () => {
  test('allows attempts up to the cap, then rejects', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 })
    expect(limiter.attempt('1.2.3.4')).toBe(true)
    expect(limiter.attempt('1.2.3.4')).toBe(true)
    expect(limiter.attempt('1.2.3.4')).toBe(true)
    expect(limiter.attempt('1.2.3.4')).toBe(false)
  })

  test('tracks keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 })
    expect(limiter.attempt('a')).toBe(true)
    expect(limiter.attempt('b')).toBe(true)
    expect(limiter.attempt('a')).toBe(false)
    expect(limiter.attempt('b')).toBe(false)
  })

  test('resets once the window elapses', () => {
    let now = 0
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 }, () => now)
    expect(limiter.attempt('a')).toBe(true)
    expect(limiter.attempt('a')).toBe(false)
    now = 1001
    expect(limiter.attempt('a')).toBe(true)
  })
})
