# SPM — Secure Package Manager

SPM is an npm-compatible registry overlay for Algorand MainNet. It passes
unreviewed packages through to npm for free. A human-reviewed package costs
1,000 microUSDC ($0.001), settled through the mandatory GoPlausible
facilitator. Target split 40/10/20/15/10/5. In the MVP: 40% to the auditor,
60% to the operator until the other roles launch. See "Revenue split" below.
Most supply-chain attacks land in packages nobody ever reviewed. SPM turns
human review into a paid, verifiable, on-chain-anchored public good.

WARNING: no MainNet deployment exists yet. Read "Current status" before you
rely on any figure here.

## How it works

The proxy checks a package's review status before serving it. An unreviewed
package always passes through to npm, free. A reviewed package returns HTTP
402 with payment requirements. The caller signs a plain USDC transfer and
retries the request with a payment header. The facilitator verifies and
settles that transfer to a fixed `payTo` address.

CAUTION: an earlier design signed a two-part group, one USDC transfer plus
one application call. The facilitator rejects that group shape now. The
client signs one plain USDC transfer only.

```
client / spm CLI        SPM proxy              GoPlausible facilitator     Algorand MainNet
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

USDC accrues at one fixed `payTo` address. A payment never splits per
transfer. A nightly job reads the ledger and calls `PaymentRouter.credit()`
in numbered batches, crediting the auditor and ops balances. Each payee then
calls `claim()` for their own balance. A version bump resets a package's
review status to `UNREVIEWED`.

## Revenue split

Target split, per 1,000 microUSDC of a reviewed payment:

| Recipient | Share | Per 1,000 µUSDC |
|---|---|---|
| Auditor | 40% | 400 |
| Contributor | 10% | 100 |
| Maintainer | 20% | 200 |
| Adversarial reviewer pool | 15% | 150 |
| Treasury | 10% | 100 |
| Ops | 5% | 50 |

MVP split. Only the auditor and ops roles are onboarded so far:

| Recipient | Share | Per 1,000 µUSDC |
|---|---|---|
| Auditor | 40% | 400 |
| Ops | 60% | 600 |

The MVP 60% is ops income now, not a debt owed to the other roles. Each role
gets its target share once it onboards.

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

Every price is a multiple of 1,000 microUSDC. The lockfile price has no cap
and no discount: it is always 1,000 µUSDC times the reviewed-package count.
MainNet USDC asset id is 31566704. Every paid route sets `extra.asset`
explicitly, so a client never falls back to ALGO.

## How to call it

### Point npm at the proxy

Copy `.env.example` to `.env` and fill in a deployed `PAY_TO_ADDRESS`.
Start the proxy, then install through it like any npm registry.

```bash
cp .env.example .env
pnpm -C proxy start                 # binds http://localhost:4873
npm install is-odd --registry http://localhost:4873   # unreviewed, free
npm install <reviewed-pkg> --registry http://localhost:4873   # 402, then pays
```

CAUTION: the proxy calls the facilitator's `getSupported()` at startup and
refuses to bind without a valid `feePayer`. It needs network access to
`https://facilitator.goplausible.xyz` before it serves any request.

### Use the MCP server

An agent calls two tools over the MCP server: `check_audit_status` for a free
status lookup, and `install_audited_package`, which pays and installs.

```bash
pnpm -C mcp start
```

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

Every paid route is opt-in. A 402 reports the price and no client signs
anything unless the caller explicitly agrees to donate. A donation never
signs above 1,000 microUSDC times the number of reviewed entries in the
request (1,000 microUSDC for one tarball or one single-package attestation),
and never in an asset other than the network's USDC ASA. There is no config
knob for either limit.

```bash
export SPM_DONOR_MNEMONIC="<25-word mainnet mnemonic>"
pnpm -C cli exec tsx src/index.ts attest package-lock.json --donate --out spm-attestation.json
```

Without `--donate`, `spm attest` reports the price on a 402 and exits 2,
signing nothing. The MCP `attest_lockfile` tool takes the same opt-in as
`allowDonation`. `mcp/src/donor.ts` is the shared donation client behind
both.

The `spm-attest` GitHub Action installs `spm-cli` and runs `spm attest`. Its
`donate` input defaults to `'false'`. Set it to `'true'` and pass a
`donor-mnemonic` secret to donate from CI. WARNING: never pass a mnemonic as
plain text. Use a GitHub Actions secret. The Action fails open: a
facilitator outage, a 5xx, or a missing `donor-mnemonic` logs a warning and
exits 0, so it never reddens a caller's CI.

### Donor account setup

Create a fresh Algorand account. Do not reuse an account that holds anything
else. Fund it with about 0.3 ALGO: 0.1 ALGO for the account minimum balance,
0.1 ALGO for the USDC asset opt-in, plus a small margin. Add a few dollars of
USDC on Algorand MainNet (ASA 31566704). Opt in to that USDC asset before the
first donation.

The facilitator pays the payment transaction fee, so the ALGO only covers the
minimum balance and the opt-in. A wallet with an in-app USDC purchase, for
example Pera, avoids an exchange withdrawal to a fresh address.

Set the account's 25-word mnemonic in `SPM_DONOR_MNEMONIC`. Never commit it
and never log it.

## Verify an attestation offline

`spm verify` checks one DSSE envelope against a published key. It makes no
network request.

```bash
pnpm -C cli exec tsx src/index.ts verify attestation.json \
  --lockfile package-lock.json \
  --keys spm-keys.json
```

CAUTION: never verify with `algosdk.signBytes`. It prepends `MX` and breaks
standard DSSE verifiers. The signing key uses raw ed25519 instead.

## Development setup

Use `pnpm`. Never use `npm` or `yarn` to install packages in this project.

```bash
pnpm install                        # install all workspace dependencies
pnpm test                           # proxy and contract test suites
pnpm typecheck                      # contracts, proxy, mcp, cli
pnpm lint                           # biome check
bash scripts/guard.sh               # invariant guard over tracked files
```

Each of these commands was run against this repository state and exits 0.

## Repository layout

- `contracts/` — AlgoKit TypeScript. `PaymentRouter`: `createApplication`,
  `setCrediter`, `setIdentity`, `credit`, `claim`, `releaseAuthority`.
- `proxy/` — Hono overlay: npm passthrough, SQLite status store, x402
  routes, attestation signing, claims ledger.
- `mcp/` — MCP server: `check_audit_status`, `install_audited_package`.
- `cli/` — `spm` wrapper, including `spm verify` offline verification.
- `.github/actions/spm-attest/` — CI Action. It fails open; it never reddens
  a user's CI.
- `docs/` — architecture notes and the contract build runbook.

## Current status and limitations

No MainNet deployment exists yet. No contract is deployed, and no payment
has settled.

`contracts/smart_contracts/artifacts/` holds a Puya build of `PaymentRouter`.
No `PaymentRouter` application id is deployed on MainNet yet. Follow
`docs/RUNBOOK-contract-build.md` before any MainNet deploy.

Contract tests run under `algorand-typescript-testing`, in JavaScript. A
passing test does not prove the contract compiles under Puya. Only
`algokit project run build` on a machine with Docker proves that.

Seeded reviews are real reviews. A `COMMUNITY_REVIEWED` record means a human
read that exact tarball. A record with no stored integrity hash resolves to
`UNREVIEWED`, never to a fabricated claim.

## Further reading

- `SPEC.md` — the authoritative specification.
- `docs/TASK.md` — next steps and work items.
- `docs/adr/` — design decisions.
- `docs/RUNBOOK-contract-build.md` — regenerate the contract artifacts.
- [Leaderboard](https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&env=mainnet&src=x402-global-challenge)
