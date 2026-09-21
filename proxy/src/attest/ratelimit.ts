// proxy/src/attest/ratelimit.ts
//
// Per-IP rate limiter for the free lockfile path (a lockfile with zero
// reviewed packages). That path is unpriced but not free to run: it still
// costs a parse, roughly 500 status lookups, and a signature. Cap it per IP
// so it cannot be used as an unpriced signing oracle (SPEC.md §6.3).

/** A rate limiter keyed by an arbitrary string (the caller's IP here). */
export interface RateLimiter {
  /** Returns true when `key` is still within its window's cap; false past it. */
  attempt(key: string): boolean
}

export interface RateLimiterConfig {
  windowMs: number
  max: number
}

/** Default cap for the free lockfile path: 20 requests per IP per hour. */
export const DEFAULT_FREE_LOCKFILE_RATE_LIMIT: RateLimiterConfig = {
  windowMs: 60 * 60 * 1000,
  max: 20,
}

// A key is pruned from the map once every PRUNE_INTERVAL calls, not on
// every call — a full-map sweep on every request would cost O(distinct
// keys) each time. This still bounds growth to at most PRUNE_INTERVAL
// extra, stale keys between sweeps, so memory never grows for as long as
// the process runs (WARNING this fixes: an unpruned map grows one entry
// per distinct caller forever).
const PRUNE_INTERVAL = 200

/**
 * Builds an in-memory sliding-window rate limiter. `now` is injectable so
 * tests can control time without real sleeps, and `config` is injectable so
 * tests can use a small cap instead of waiting for 20 real attempts.
 */
export function createRateLimiter(
  config: RateLimiterConfig = DEFAULT_FREE_LOCKFILE_RATE_LIMIT,
  now: () => number = Date.now,
): RateLimiter {
  const hits = new Map<string, number[]>()
  let callsSincePrune = 0

  function pruneExpired(nowMs: number): void {
    const windowStart = nowMs - config.windowMs
    for (const [key, timestamps] of hits) {
      const recent = timestamps.filter((t) => t > windowStart)
      if (recent.length === 0) hits.delete(key)
      else hits.set(key, recent)
    }
  }

  return {
    attempt(key: string): boolean {
      const nowMs = now()
      callsSincePrune += 1
      if (callsSincePrune >= PRUNE_INTERVAL) {
        callsSincePrune = 0
        pruneExpired(nowMs)
      }
      const windowStart = nowMs - config.windowMs
      const recent = (hits.get(key) ?? []).filter((t) => t > windowStart)
      if (recent.length >= config.max) {
        hits.set(key, recent)
        return false
      }
      recent.push(nowMs)
      hits.set(key, recent)
      return true
    },
  }
}
