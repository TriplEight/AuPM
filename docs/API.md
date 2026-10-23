# AuPM HTTP API and attestations

This page lists the public routes of an AuPM server and the CLI commands that use them. The
examples use the MainNet origin `https://aupm.fyi`. For the onboarding of each role, see
[ONBOARDING.md](ONBOARDING.md).

## Free routes

| Route | Result |
|---|---|
| `GET /api/v1/status/<name>/<version>` | The review status of one package version. A scoped name has two segments: `/api/v1/status/@babel/core/7.25.2`. |
| `GET /api/v1/earnings/github/<login>` | The ledger earnings of one auditor: held, matured unpaid, frozen and paid micro-USDC, and whether a payout address is set. It never returns the address. |
| `GET /api/v1/reviews?reviewer=<login>` | The reviews of one auditor, with the status and the anchor txid of each. |
| `GET /api/v1/contract` | The network, the PaymentRouter app id, the `payTo` address, and the USDC asset id. |
| `GET /api/v1/health` | The server state and the deployed `version` and `commit`. |
| `GET /.well-known/aupm-keys.json` | The public keys that sign attestations. |
| `GET /.well-known/x402` | The x402 discovery document. |
| `GET /llms.txt` | A description of the routes for agents. |

Any npm registry path goes through to npm. An unreviewed package is always free.

Example:

```bash
curl https://aupm.fyi/api/v1/status/ms/2.1.3
```

## Attestation routes

| Route | Price |
|---|---|
| `GET /v1/attest?name=<name>&version=<version>` | 1,000 microUSDC × tenths for a reviewed package. Free for other packages. |
| `POST /v1/attest/lockfile` | 1,000 microUSDC × tenths × the reviewed entries. Free for a lockfile with no reviewed entry. |

The multiplier is the request header `X-AuPM-Multiplier`: a whole number of tenths from 1 to
1000 (x0.1 to x100). Without the header, the multiplier is 10 (x1, $0.01). The minimum is 1
(x0.1, $0.001). The base donation is 10,000 microUSDC per reviewed package. The cap is
1,000 × tenths per entry. A malformed or out-of-range value on a paid request gets HTTP 400.
Each paid response reports the base, the multiplier and the total. A paid attestation signs the
same record in `predicate.donation`.

The lockfile route accepts `package-lock.json`, `pnpm-lock.yaml` (lockfileVersion 9.0) and
`yarn.lock` (yarn classic v1), each at most 2 MiB.

A request with the header `X-AuPM-Donate: 0` gets a free partial attestation. It withholds the
reviewed entries. It never withholds an `INTEGRITY_MISMATCH` or `UNRESOLVABLE` entry. Without
that header, a request that includes a reviewed package gets HTTP 402 and pays through x402.

A tarball download is free. A reviewed tarball returns HTTP 402 only when the request has the
header `X-AuPM-Donate: 1`.

## Get an attestation with the CLI

```bash
aupm attest package-lock.json --out attestation.json            # free, partial
aupm attest package-lock.json --donate --out attestation.json   # paid, complete
```

To count the reviewed entries before you pay, run the free command first. The free attestation
gives the number of withheld reviewed entries.

## Check an attestation offline

```bash
curl -sSfo aupm-keys.json https://aupm.fyi/.well-known/aupm-keys.json
aupm verify attestation.json --lockfile package-lock.json --keys aupm-keys.json
```

`aupm verify` makes no network call. A changed lockfile fails the check. An attestation is a DSSE
envelope with an in-toto Statement v1 and an ed25519 signature.
