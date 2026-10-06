# Development

This file covers building, running and deploying this repository. For the product itself,
see [README.md](../README.md). For the specification, see [SPEC.md](../SPEC.md).

## Current status and limitations

AuPM runs on Algorand MainNet at `https://aupm.fyi`. A `PaymentRouter` application runs there,
and donations settle in USDC. The project is at an early stage: see [ROADMAP.md](ROADMAP.md).

`contracts/smart_contracts/artifacts/` holds the Puya build of `PaymentRouter`. Follow
[RUNBOOK-contract-build.md](RUNBOOK-contract-build.md) before any MainNet contract deploy or
upgrade. The operator runbook for the deploy is not published.

Contract tests run under `algorand-typescript-testing`, in JavaScript. A passing test does not
prove the contract compiles under Puya. Only `algokit project run build`, on a machine with
Docker, proves that.

Seeded reviews are real reviews. A `COMMUNITY_REVIEWED` record means a human read that exact
tarball. A record with no stored integrity hash resolves to `UNREVIEWED`, never to a
fabricated claim.

## How the payment flow works

The proxy checks a package's review status before it serves it. An unreviewed package always
passes through to npm, free. A reviewed package returns HTTP 402 with payment requirements.
The caller signs a plain USDC transfer and retries the request with a payment header. The
facilitator verifies and settles that transfer to a fixed `payTo` address.

CAUTION: an earlier design signed a two-part group, one USDC transfer plus one application
call. The facilitator rejects that group shape now. The client signs one plain USDC transfer
only.

```
client / aupm CLI        AuPM proxy              GoPlausible facilitator     Algorand MainNet
      |                     |                          |                        |
      | 1. npm install pkg  |                          |                        |
      |-------------------->|                          |                        |
      | 2. 402 + payment requirements                   |                        |
      |<--------------------|                          |                        |
      | 3. sign a plain USDC transfer to payTo           |                        |
      | 4. retry with payment header                     |                        |
      |-------------------->| 5. verify(payload)       |                        |
      |                     |------------------------->| 6. simulate           |
      |                     |                          |----------------------->|
      |                     |                          |<-----------------------|
      |                     |<-------------------------| isValid: true          |
      |                     | 7. settle(payload)        |                        |
      |                     |------------------------->| 8. submit USDC transfer|
      |                     |                          |----------------------->|
      |                     |                          |<-----------------------| txId
      |                     |<-------------------------|                        |
      | 9. 200 + tarball + attestation                  |                        |
      |<--------------------|                          |                        |
```

USDC accrues at one fixed `payTo` address. A payment never splits per transfer. A nightly job
reads the ledger and calls `PaymentRouter.credit()` in numbered batches, crediting the auditor
and ops balances. Each payee then calls `claim()` for their own balance. A version bump resets
a package's review status to `UNREVIEWED`.

## Routes and prices

| Route | Condition | Price |
|---|---|---|
| `POST /v1/attest/lockfile` | one or more reviewed packages | 1,000 µUSDC × reviewed packages |
| `POST /v1/attest/lockfile` | zero reviewed packages | free, rate-limited |
| `GET /v1/attest?name=&version=` | reviewed version | $0.001 |
| `GET /v1/attest?name=&version=` | unreviewed version | free, rate-limited |
| tarball download | reviewed version | $0.001 |
| tarball download | unreviewed version | free |
| `GET /api/v1/status/...` | — | free |
| `GET /api/v1/earnings/github/:login` | — | free |

Every price is a multiple of 1,000 microUSDC. The lockfile price has no cap and no discount: it
is always 1,000 µUSDC times the reviewed-package count. MainNet USDC asset id is 31566704.
Every paid route sets `extra.asset` explicitly, so a client never falls back to ALGO.

## Run the proxy locally

Copy `.env.example` to `.env` and fill in a deployed `PAY_TO_ADDRESS`. Start the proxy, then
install through it like any npm registry.

```bash
cp .env.example .env
pnpm -C proxy start                                  # binds http://localhost:4873
npm install is-odd --registry http://localhost:4873  # unreviewed, free
npm install ms@2.1.3 --registry http://localhost:4873  # 402, then pays if reviewed
```

CAUTION: the proxy calls the facilitator's `getSupported()` at startup and refuses to bind
without a valid `feePayer`. It needs network access to `https://facilitator.goplausible.xyz`
before it serves any request.

### Use the MCP server

```bash
pnpm -C mcp start
```

An agent calls two tools over the MCP server: `check_audit_status` for a free status lookup,
and `install_audited_package`, which pays and installs.

### Use curl directly

```bash
# single-package attestation, query params carry the scoped name
curl "http://localhost:4873/v1/attest?name=@babel/core&version=7.25.2"

# whole-lockfile attestation
curl -X POST http://localhost:4873/v1/attest/lockfile \
  -H "Content-Type: application/json" \
  --data-binary @package-lock.json

# free status lookup
curl http://localhost:4873/api/v1/status/lodash/4.17.21
```

## Donate to a review

Every paid route is opt-in. A 402 reports the price and no client signs anything unless the
caller explicitly agrees to donate. A donation never signs above $0.001 (1,000 microUSDC)
times the number of reviewed entries in the request ($0.001 for one tarball or one
single-package attestation), and never in an asset other than the network's USDC ASA. There is
no config knob for either limit.

Set the mnemonic from a secret manager for one command only — never in a `.env` file:

```bash
AUPM_DONOR_MNEMONIC="$(rbw get aupm-donor)" \
  pnpm -C cli exec tsx src/index.ts attest package-lock.json --donate --out aupm-receipt.json
```

The same pattern installs one package:

```bash
AUPM_DONOR_MNEMONIC="$(rbw get aupm-donor)" pnpm -C cli exec tsx src/index.ts install ms@2.1.3 --donate
```

Without `--donate`, `aupm attest` reports the price on a 402 and exits 2, signing nothing. The
MCP `attest_lockfile` tool takes the same opt-in as `allowDonation`. `mcp/src/donor.ts` is the
shared donation client behind both.

The `aupm` GitHub Action replaces `npm ci`. It installs through the AuPM registry, falls back to
npm, and then runs `aupm attest`. Its `donate` input
defaults to `'false'`. Set it to `'true'` and pass a `donor-secret` secret to donate from CI.
Never pass a mnemonic as plain text — use a GitHub Actions secret. An install failure fails the
job, as with plain npm. An AuPM failure never fails the job: a registry failure falls back to
npm, and a facilitator outage, a 5xx, or a missing `donor-secret` logs a warning and exits 0.

### Donor account setup

Create a fresh Algorand account. Do not reuse an account that holds anything else. Fund it
with about 0.3 ALGO: 0.1 ALGO for the account minimum balance, 0.1 ALGO for the USDC asset
opt-in, plus a small margin. Add a few dollars of USDC on Algorand MainNet (ASA 31566704). Opt
in to that USDC asset before the first donation.

The facilitator pays the payment transaction fee, so the ALGO only covers the minimum balance
and the opt-in. A wallet with an in-app USDC purchase, for example Pera, avoids an exchange
withdrawal to a fresh address.

Set the account's 25-word mnemonic in `AUPM_DONOR_MNEMONIC`. Never commit it and never log it.

`aupm donor init` guides you through these steps. It creates the account, writes the key to
`~/.config/aupm/donor.env` (`$XDG_CONFIG_HOME/aupm/donor.env`) with mode 0600, and prints a
warning about the key file, the address and numbered next steps with QR codes. It does not wait.
Run `aupm donor optin` after the ALGO arrives. Run `aupm donor status` at any time to see the
balances and the next step. When the env var is set, it wins
over the file. `aupm donor optin` and `aupm donor status` work for an existing key.

## Verify an attestation offline

`aupm verify` verifies one DSSE envelope against a published key. It makes no network request.

```bash
pnpm -C cli exec tsx src/index.ts verify attestation.json \
  --lockfile package-lock.json \
  --keys aupm-keys.json
```

CAUTION: never verify with `algosdk.signBytes`. It prepends `MX` and breaks standard DSSE
verifiers. The signing key uses raw ed25519 instead.

## Development setup

Use `pnpm`. Never use `npm` or `yarn` to install packages in this project.

Prerequisites: Node 22 or later and pnpm 12.5.1, the same versions as CI. pnpm 11 and later need
Node 22. A native module (`better-sqlite3`) builds for the Node version that runs
`pnpm install`. After a Node version change, run `pnpm install` again.

```bash
pnpm install                        # install all workspace dependencies
pnpm test                           # proxy and contract test suites
pnpm typecheck                      # contracts, proxy, mcp, cli
pnpm lint                           # biome check
bash scripts/guard.sh               # invariant guard over tracked files
```

Each command here exits 0 against this repository state.

## Repository layout

- `contracts/` — AlgoKit TypeScript. `PaymentRouter`: `createApplication`, `setCrediter`,
  `setIdentity`, `credit`, `claim`, `announceRelease`, `executeRelease`.
- `proxy/` — Hono overlay: npm passthrough, SQLite status store, x402 routes, attestation
  signing, claims ledger.
- `mcp/` — MCP server: `check_audit_status`, `install_audited_package`, `attest_lockfile`.
- `cli/` — `aupm` wrapper, including `aupm attest` and offline `aupm verify`.
- `.github/actions/aupm/` — CI Action, a drop-in for `npm ci`. An AuPM failure never fails the job.
- `docs/` — architecture notes, runbooks and the contract build guide.

## Further reading

- [SPEC.md](../SPEC.md) — the authoritative specification.
- [docs/adr/](adr/) — design decisions.
- [RUNBOOK-contract-build.md](RUNBOOK-contract-build.md) — regenerate the contract artifacts.
