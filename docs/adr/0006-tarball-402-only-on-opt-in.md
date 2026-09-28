# A reviewed tarball returns 402 only with donation opt-in

npm cannot pay a 402. The seed list (`ms`, `once`, `inherits`) is in almost every lockfile, so a
hard 402 on reviewed tarballs would break `npm install` for every user who sets `registry=` in
`.npmrc`, and AuPM promises "no migration". The tarball route therefore serves a reviewed tarball
free, with an `X-AuPM-Tier` header, unless the request carries `X-AuPM-Donate: 1`. Then it returns
402. The attestation routes keep standard x402 behaviour: reviewed content returns 402 to any
caller, so Bazaar agents can pay. AuPM clients that run without `--donate` send
`X-AuPM-Donate: 0` and get a free partial attestation. It withholds the reviewed entries and
always lists `INTEGRITY_MISMATCH` and `UNRESOLVABLE` entries, because AuPM never charges for a
security warning.
