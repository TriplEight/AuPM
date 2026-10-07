# The lockfile route accepts a yarn classic yarn.lock

Yarn users cannot use `POST /v1/attest/lockfile` with `package-lock.json`. The route now also
accepts a yarn classic (v1) `yarn.lock`. Yarn berry (v2 and later) is not accepted.

## Format selection

A `text/plain` request (any parameters) selects the yarn classic parser only when the initial
comment block of the body holds the exact line `# yarn lockfile v1`. The block runs from the start
of the body, after one optional BOM, to the first line that is neither empty nor a `#` comment. The
line ending is LF or CRLF. The header text anywhere else never selects classic.

A body with a top-level `__metadata:` key is yarn berry. It gets a 400 that names the accepted
formats. A body with the classic header and `__metadata:` also gets a 400. A `text/plain` body with
neither marker keeps the JSON path, so a client that sends `package-lock.json` as `text/plain`
sees no change. `application/yaml` and `text/yaml` still select pnpm.

After a body selects classic, every parse fault is a classic 400 with a line number. It never
falls back to JSON.

## Parser

The parser is hand-written and runs in linear time. It adds no dependency. It runs in the pnpm
worker (ADR 0015), with the same byte cap, entry cap, time limit and one-parse-at-a-time rule.
The worker returns plain entries. The main thread classifies them with the same `classifyEntries`
function as the other formats, so the same tree gives the same counts and the same price.

One block is one entry. Grouped selectors, such as `"@babel/core@^7.0.0", "@babel/core@^7.25.2":`,
are one entry. All selectors of a block must name one package. A duplicate block header is a 400,
because yarn rejects it too.

## Source identity and integrity

A `resolved` value is a registry source only when it is an `https:` URL on exactly
`registry.npmjs.org` or `registry.yarnpkg.com`, with no user name, no password, no explicit port,
and a path that ends in `.tgz`. The code also requires that the raw authority text equals the parsed
host. This rejects characters that the URL parser drops or rewrites, for example a tab in the host,
a trailing dot or a backslash. Any other value, and a missing value, is `UNRESOLVABLE`. The server
never fetches `resolved`.

`registry.yarnpkg.com` is an alias for source identity only. A host match never proves that the
bytes are the same. The full comparison of the lockfile `integrity` with the stored review digest
always applies. A missing, malformed, sha1-only or mismatching `integrity` on a reviewed entry is
`INTEGRITY_MISMATCH`. The server never fills a missing digest from the registry or from the stored
review.

## Statement

The subject name is `yarn.lock`. The digest is the sha256 of the exact body bytes. The predicate
keeps its shape. `format` is `"yarn-classic"`, and `lockfileVersion` is the string `"1"`.

## Why yarn berry is excluded

A berry lockfile has a `checksum` field. Berry computes it over its own cache archive (a zip that
yarn builds), not over the npm tarball. A lookup against npm returns the tarball digest that the
review record holds. That digest differs from the berry `checksum`, so the two cannot be compared.
A berry entry that we matched by name and version alone would prove nothing about the installed
bytes. AuPM never downgrades a berry lockfile to a name and version check.

A later berry adapter needs a verified bridge from the reviewed tarball to the yarn cache archive.
Until that bridge exists and is tested, the route refuses berry.
