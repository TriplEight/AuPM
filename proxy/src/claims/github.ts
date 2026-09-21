// proxy/src/claims/github.ts
//
// Real, read-only GitHub client for claim-proof verification (SPEC.md
// 5.3). Implements the GithubClient interface from proxy/src/claims/ledger.ts
// over the public GitHub REST API. Only POST /api/v1/claims/verify uses this
// — earnings and claim creation never reach GitHub.
//
// WARNING: never log `token` (CLAUDE.md). It is a read-only token, used only
// to raise the anonymous rate limit and read public content.

import type { GithubClient } from './ledger.js'

const GITHUB_API = 'https://api.github.com'

// GitHub's own naming rules for a repository owner (user or org login) and a
// repository name: ASCII letters, digits, `-`, `_`, `.` only. Reject `.` and
// `..` outright — either one, unvalidated, resolves a REST path segment to a
// different endpoint (e.g. `..` climbs out of `/repos/<owner>/`), attaching
// the read-only token to a request the caller never asked for.
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

function requireGithubSegment(value: string, label: string): string {
  if (value === '.' || value === '..' || !GITHUB_SEGMENT_RE.test(value)) {
    throw new Error(`invalid GitHub ${label} "${value}": must be a valid GitHub login or repo name`)
  }
  return value
}

function requireToken(token: string): string {
  if (!token) {
    // Fails cleanly: this throws inside the (already async) GithubClient
    // methods, so POST /api/v1/claims/verify rejects with a clear message
    // instead of making an unauthenticated, heavily rate-limited call, and
    // instead of crashing the server (CLAUDE.md).
    throw new Error('GITHUB_READONLY_TOKEN is not set: cannot verify claim proofs against GitHub')
  }
  return token
}

/**
 * Build a real, injectable GithubClient. `token` comes from
 * config.ts's GITHUB_READONLY_TOKEN, read from the environment at boot.
 */
export function createGithubClient(token: string): GithubClient {
  function authHeaders(): HeadersInit {
    return {
      authorization: `Bearer ${requireToken(token)}`,
      accept: 'application/vnd.github.raw+json',
      'user-agent': 'spm-claims-verifier',
    }
  }

  return {
    async getFile(owner: string, repo: string, path: string): Promise<string | null> {
      // WARNING: validate every caller-supplied path segment before it
      // reaches a URL. An unvalidated `..` resolves to a different
      // `api.github.com` endpoint with the read-only token attached.
      requireGithubSegment(owner, 'owner')
      requireGithubSegment(repo, 'repo')
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
        headers: authHeaders(),
      })
      if (!res.ok) return null
      return res.text()
    },

    async getGistContent(login: string): Promise<string | null> {
      requireGithubSegment(login, 'login')
      const res = await fetch(`${GITHUB_API}/users/${login}/gists`, { headers: authHeaders() })
      if (!res.ok) return null
      const gists = (await res.json()) as Array<{ files?: Record<string, { raw_url?: string }> }>

      const chunks: string[] = []
      for (const gist of gists) {
        for (const file of Object.values(gist.files ?? {})) {
          if (!file.raw_url) continue
          const fileRes = await fetch(file.raw_url, { headers: authHeaders() })
          if (fileRes.ok) chunks.push(await fileRes.text())
        }
      }
      return chunks.length > 0 ? chunks.join('\n') : null
    },
  }
}
