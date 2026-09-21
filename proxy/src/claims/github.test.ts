// proxy/src/claims/github.test.ts
//
// CAUTION: every test here stubs `fetch` — no test in this file performs a
// real network call. `createGithubClient` is the only module in
// proxy/src/claims that talks to `api.github.com` directly.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createGithubClient } from './github.js'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createGithubClient path validation', () => {
  test('a repo containing ".." is rejected and no GitHub request is made', async () => {
    const github = createGithubClient('token')
    await expect(github.getFile('alice', '../secrets', 'file.json')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('a repo containing "/" is rejected and no GitHub request is made', async () => {
    const github = createGithubClient('token')
    await expect(github.getFile('alice', 'evil/repo', 'file.json')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('an owner containing ".." is rejected and no GitHub request is made', async () => {
    const github = createGithubClient('token')
    await expect(github.getFile('../admin', 'repo', 'file.json')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('a gist login containing ".." is rejected and no GitHub request is made', async () => {
    const github = createGithubClient('token')
    await expect(github.getGistContent('../admin')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('a legitimate owner/repo still performs the request', async () => {
    const github = createGithubClient('token')
    const result = await github.getFile('alice', 'my-repo', '.well-known/spm-claim.json')
    expect(result).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://api.github.com/repos/alice/my-repo/contents/.well-known/spm-claim.json',
    )
  })

  test('a legitimate login still performs the gist request', async () => {
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }))
    const github = createGithubClient('token')
    await github.getGistContent('alice')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/users/alice/gists')
  })
})
