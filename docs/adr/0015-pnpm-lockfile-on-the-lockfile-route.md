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

YAML parsing is slow: about 0.3 MB/s on the development host, so a 5 MiB body blocks the event
loop for 7 to 9 s. This route is free and public. Three limits contain the cost.

- **Worker thread.** The parse runs in a `node:worker_threads` worker
  (`proxy/src/attest/yaml-worker.mjs`, plain JavaScript, so it needs no TypeScript loader). The
  main thread never calls `yaml` for a request body. The worker has a 256 MiB heap limit.
- **Time limit.** A parse that takes more than 5 s is terminated. The route answers 422 with
  "lockfile is too complex to parse in time". We chose 422 over 413. The body is within the size
  cap and syntactically plausible, so 413 would tell the caller to send less, and that is not what
  fixes it. 422 says the server understood the type and could not process the content.
- **One parse at a time.** A YAML request that arrives while a parse runs gets 503 with
  `Retry-After: 3`. JSON requests never wait for the parser and are not affected.
- **Server faults.** A worker that cannot start, a missing script or `yaml` module, or a worker
  that exits without a result is the server's fault, not the caller's. The route answers 500 with
  a generic message and logs one line with the error code and message, never the body. A worker
  out of memory stays 422. A syntax error or duplicate key is posted by the worker and answers 400.
- **Separate byte cap.** `LOCKFILE_MAX_YAML_BYTES` is 2 MiB, checked before the worker starts
  (413). The JSON cap stays 5 MiB.

All four checks run in the pre-middleware, before the x402 gate. A refused YAML request never
returns 402, and a refused request is never charged.

The worker calls `parseDocument` with `uniqueKeys: false` and checks duplicate keys itself, in the
root and in `packages`. The library check is quadratic: 20,000 keys took 25 s. A duplicate key is
a 400, because pnpm rejects it too.

We rejected pnpm lockfileVersion 6 and 7 for now. Their `packages` keys use a different shape
(`/name@version`), and no user asked for them.
