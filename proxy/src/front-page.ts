// proxy/src/front-page.ts
//
// The static front page at `GET /`. The x402 Bazaar merchant card reads the
// `og:` tags from this page (SPEC.md 11.2).

const README_URL = 'https://github.com/TriplEight/AuPM#readme'
const SITE_NAME = 'AuPM'
const TITLE = 'AuPM: human-reviewed npm packages'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// Builds the page from the public origin and the og:description text.
// Every interpolated value is HTML-escaped.
export function buildFrontPage(issuer: string, description: string): string {
  const image = escapeHtml(`${issuer}/.well-known/aupm-og.png`)
  const url = escapeHtml(`${issuer}/`)
  const keys = escapeHtml(`${issuer}/.well-known/aupm-keys.json`)
  const favicon = escapeHtml(`${issuer}/favicon.ico`)
  const svgIcon = escapeHtml(`${issuer}/.well-known/aupm-icon.svg`)
  const touchIcon = escapeHtml(`${issuer}/.well-known/aupm-apple-touch-icon.png`)
  const desc = escapeHtml(description)
  const title = escapeHtml(TITLE)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${image}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<link rel="icon" href="${favicon}" sizes="48x48">
<link rel="icon" type="image/svg+xml" href="${svgIcon}">
<link rel="apple-touch-icon" href="${touchIcon}">
</head>
<body>
<h1>${escapeHtml(SITE_NAME)}</h1>
<p>${desc}</p>
<ul>
<li><a href="${escapeHtml(README_URL)}">README</a></li>
<li><a href="${keys}">Attestation keys</a></li>
</ul>
</body>
</html>
`
}
