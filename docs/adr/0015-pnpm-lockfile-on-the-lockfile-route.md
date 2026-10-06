# The lockfile route also accepts a pnpm-lock.yaml

pnpm users cannot use `POST /v1/attest/lockfile` with `package-lock.json`. The route now also
accepts a `pnpm-lock.yaml`. A request with `Content-Type: application/yaml` or `text/yaml` (any
parameters) selects the pnpm parser. Any other content type keeps the JSON path unchanged.

Only lockfileVersion '9.0' is accepted. Any other version, a number instead of a string, or no
version gets a 400 that names '9.0'. We read the `packages` keys with the `yaml` package
(`name@version`, scoped `@scope/name@version`, a peer suffix `(...)` dropped) and take
`resolution.integrity`. A `directory`, `repo`/`commit`/`type`, or non-npm `tarball` resolution is
`UNRESOLVABLE`, the same class as a non-registry package-lock entry. A `tarball` that points at
registry.npmjs.org counts as a registry entry, as it does in a package-lock. `snapshots` and
`importers` are not read.

Both formats feed one classifier. The same tree gives the same summary counts and the same
price. Limits (`LOCKFILE_MAX_BYTES`, `LOCKFILE_MAX_ENTRIES`), the 402 gate, ADR 0013, the
`X-AuPM-Donate: 0` partial attestation and invariant 4 are unchanged. The statement subject name
is `pnpm-lock.yaml`, and its digest is the sha256 of the exact body bytes. The predicate gains one
field, `format` (`"npm"` or `"pnpm"`). For pnpm, `lockfileVersion` is the string `"9.0"`.

The parser calls `parseDocument` with `uniqueKeys: false` and checks duplicate keys itself, in
the root and in `packages`. The library check is quadratic: 20,000 keys took 25 s. A duplicate
key is a 400, because pnpm rejects it too.

Known cost: YAML parsing is synchronous and slow, about 0.3 MB/s on the development host. A
5 MiB body can block the event loop for seconds. The per-IP request limiter bounds the rate. A
worker thread or a smaller YAML byte limit is the next step if this matters in production.

We rejected pnpm lockfileVersion 6 and 7 for now. Their `packages` keys use a different shape
(`/name@version`), and no user asked for them.
