// proxy/src/claims/push.ts
//
// Reports one nightly run to an Uptime Kuma Push monitor: a single GET with
// `status` and `msg` query parameters. The push is best effort. It makes one
// attempt, never retries, and never throws. The push URL carries the monitor
// token, so no log line or error text may contain it.

export type PushStatus = 'up' | 'down'

/** Longest message sent to the monitor, in characters. */
export const PUSH_MSG_MAX_CHARS = 250

/** How long one push request may take before it is abandoned. */
export const PUSH_TIMEOUT_MS = 5000

export interface PushOptions {
  timeoutMs?: number
  log?: (line: string) => void
}

/**
 * Sends one GET to the push URL. Existing `status` and `msg` parameters are
 * replaced, and a `ping` parameter is dropped. A network error, a timeout or
 * a non-2xx answer logs `aupm-nightly: push failed — <error name or HTTP
 * status>` and resolves normally.
 */
export async function pushStatus(
  pushUrl: string,
  status: PushStatus,
  msg: string,
  options: PushOptions = {},
): Promise<void> {
  const log = options.log ?? console.log
  try {
    const url = new URL(pushUrl)
    url.searchParams.set('status', status)
    url.searchParams.set('msg', msg.slice(0, PUSH_MSG_MAX_CHARS))
    url.searchParams.delete('ping')
    const res = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
    })
    if (!res.ok) log(`aupm-nightly: push failed — HTTP ${res.status}`)
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error'
    log(`aupm-nightly: push failed — ${name}`)
  }
}

/**
 * Returns the push function for NightlyDeps, or undefined when the variable
 * is unset or empty (then the nightly job sends no request).
 */
export function buildNightlyPush(
  env: NodeJS.ProcessEnv,
  options: PushOptions = {},
): ((status: PushStatus, msg: string) => Promise<void>) | undefined {
  const pushUrl = env.AUPM_NIGHTLY_PUSH_URL
  if (!pushUrl) return undefined
  return (status, msg) => pushStatus(pushUrl, status, msg, options)
}
