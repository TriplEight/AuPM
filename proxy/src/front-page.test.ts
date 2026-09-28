// proxy/src/front-page.test.ts
import { describe, expect, test } from 'vitest'
import { buildFrontPage, escapeHtml } from './front-page.js'

describe('buildFrontPage', () => {
  test('escapes quote, angle bracket and ampersand in every value', () => {
    const html = buildFrontPage('https://x.invalid/"<&', 'desc "<&')
    expect(html).toContain('content="desc &quot;&lt;&amp;"')
    expect(html).toContain('https://x.invalid/&quot;&lt;&amp;/.well-known/aupm-og.png')
    expect(html).not.toContain('"<&')
  })

  test('escapeHtml escapes apostrophe', () => {
    expect(escapeHtml("a'b")).toBe('a&#39;b')
  })
})
