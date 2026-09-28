# Runbook — build the PaymentRouter contract

Run this runbook after any change to
`contracts/smart_contracts/payment_router/contract.algo.ts`. It regenerates the compiled TEAL,
the ARC-56 specification, and the typed client, and it lists the on-chain checks that prove the
contract, not just its JavaScript test harness.

---

## 1. Why this is needed

The committed artifacts in `contracts/smart_contracts/artifacts/payment_router/` are a Puya
build of the contract source. A source change with no matching rebuild leaves those artifacts
stale, and `contracts/smart_contracts/payment_router/deploy-config.ts` deploys whatever the
artifacts say — not the source.

The contract tests run under `@algorandfoundation/algorand-typescript-testing`, which executes
the contract as JavaScript. A passing test proves the contract's logic. It does not prove the
contract compiles under Puya, and it does not prove it runs on the AVM. Only a build plus an
on-chain rehearsal (§6) proves that.

## 2. Prerequisites

1. Install the AlgoKit CLI, version 2.6.0 or newer (`contracts/.algokit.toml` sets that
   minimum).
2. From the repository root, install dependencies.
   ```bash
   pnpm install
   ```
   Check: exits 0. Never use `npm` or `yarn` in this repository.

## 3. Build

```bash
cd contracts
algokit project run build
```
Check: exits 0. Run it from `contracts/` — the repository root has no `.algokit.toml`, so
`algokit` reports `No such command 'build'` there.

This runs two steps, both defined in `contracts/package.json`:
1. `algokit compile ts smart_contracts --output-source-map --out-dir artifacts`
2. `algokit generate client smart_contracts/artifacts --output {app_spec_dir}/{contract_name}Client.ts`

## 4. Check the ABI

```bash
node -e "const j=require('./contracts/smart_contracts/artifacts/payment_router/PaymentRouter.arc56.json'); console.log(j.methods.map(m=>m.name).join(' '))"
```
Check: prints exactly `createApplication setCrediter setIdentity credit claim
releaseAuthority`. Order may differ. The set must not. If any other method name appears, the
build did not run against the current source — stop and repeat step 3.

## 5. Run the checks

From the repository root:
```bash
export PATH=$HOME/.local/share/pnpm/bin:$PATH
pnpm typecheck
pnpm -C contracts test
bash scripts/guard.sh
```
Check: each command exits 0. `pnpm typecheck` fails if
`contracts/smart_contracts/payment_router/deploy-config.ts` no longer matches the regenerated
client.

## 6. On-chain checks

A passing test in `contracts/smart_contracts/payment_router/contract.algo.spec.ts` proves the
logic in `contract.algo.ts`. It never moves value and never touches Puya or the AVM. Check
each of these on TestNet before any MainNet deploy (`SPEC.md` §17, item R0):

- A tarball payment of 1,000 microUSDC credits the auditor 400 and ops 600.
- A lockfile payment of 3,000 microUSDC across 3 reviewed packages credits the auditor 3 × 400
  and ops the remainder. The entries sum exactly to `attributedTotal × 400 / 1000`.
- Two payments for the same `(repo, identity)` collapse into one entry in the same batch.
- `credit()` with a `batchSeq` that repeats or skips the last credited batch fails.
- `credit()` with `attributedTotal + unattributedTotal` above `payTo`'s unallocated USDC balance
  fails.
- `claim()` on a balance of 99,999 microUSDC fails. On 100,000 it succeeds.
- `claim()` with an outer fee below 2,000 microALGO fails.
- `releaseAuthority()` rekeys `payTo` to the given address, and only the admin can call it.
  Planned for the MainNet build (P8): `announceRelease()` and `executeRelease()` replace it, with
  a compiled-in delay (ADR 0010). Add `announceRelease()`/`executeRelease()` checks here once
  that build lands.

Rehearse the full sequence on TestNet, in this order (`SPEC.md` §10.2):
1. `payTo` opts into USDC.
   ```bash
   node scripts/optin-usdc.mjs PAY_TO_MNEMONIC --network testnet
   ```
   Check: the account holds asset 10458941.
2. Deploy PaymentRouter.
   ```bash
   ( set -a; . ./.env; set +a; cd contracts && pnpm run deploy:ci )
   ```
   Check: the command prints an app id.
3. A payment settles through the facilitator to `payTo`.
   Check: the indexer shows an axfer of USDC into `payTo`.
4. `payTo` rekeys to the app.
   ```bash
   node scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network testnet
   ```
   Check: the account's `auth-addr` equals the app address.
5. The nightly job credits a batch.
   ```bash
   docker compose run --rm aupm node --import tsx/esm src/claims/nightly-main.ts
   ```
   Check: the log line names the credited batch and a credit txid.
6. The mapped identity claims its balance.
   ```bash
   node scripts/claim.mjs <identity> <CLAIMANT_MNEMONIC_ENV_VAR> --network testnet
   ```
   Check: the script prints a claim txid.

`NETWORK=testnet bash scripts/demo.sh` drives steps 1, 3, 4 and part of 5 end to end against a
real `.env` (`docs/DEPLOY-GUIDE.local.md` covers the full rehearsal). Check: it prints `DEMO:
PASS`.

## 7. After a successful build

Commit the regenerated artifacts. They are tracked on purpose, so a reviewer can diff the
compiled output against the source.
```bash
git add contracts/smart_contracts/artifacts
git commit -m "Regenerate PaymentRouter artifacts"
```
Check: `git status` shows a clean `contracts/smart_contracts/artifacts/` tree afterward.

## 8. Do not

- Do not hand-edit the generated TEAL, the ARC-56 specification, or the typed client.
  Regenerate them.
- Do not weaken a contract assertion to make the compiler or a test pass.
- Do not deploy to MainNet until section 5 and section 6 both pass.
