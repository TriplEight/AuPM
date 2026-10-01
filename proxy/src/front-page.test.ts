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

  test('declares the three site icons with absolute URLs', () => {
    const html = buildFrontPage('https://x.invalid', 'desc')
    expect(html).toContain('<link rel="icon" href="https://x.invalid/favicon.ico" sizes="48x48">')
    expect(html).toContain(
      '<link rel="icon" type="image/svg+xml" href="https://x.invalid/.well-known/aupm-icon.svg">',
    )
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="https://x.invalid/.well-known/aupm-apple-touch-icon.png">',
    )
  })

  test('escapes the issuer in the icon links', () => {
    const html = buildFrontPage('https://x.invalid/"<&', 'desc')
    expect(html).toContain('href="https://x.invalid/&quot;&lt;&amp;/favicon.ico"')
    expect(html).toContain('href="https://x.invalid/&quot;&lt;&amp;/.well-known/aupm-icon.svg"')
    expect(html).toContain(
      'href="https://x.invalid/&quot;&lt;&amp;/.well-known/aupm-apple-touch-icon.png"',
    )
  })

  test('escapeHtml escapes apostrophe', () => {
    expect(escapeHtml("a'b")).toBe('a&#39;b')
  })
})
