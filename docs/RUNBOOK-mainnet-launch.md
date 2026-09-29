# Runbook — MainNet deploy

Audience: the operator, deploying PaymentRouter and the proxy to MainNet Algorand. Read
`docs/RUNBOOK-contract-build.md` first if the contract source changed since the last build.
Read `docs/DEPLOY-GUIDE.local.md` for the full TestNet rehearsal this runbook assumes already
passed — every command below is a MainNet repeat of a step already proven there.

Ground truth: `SPEC.md` §10, §13, §14 and §17, and `CLAUDE.md`. `NOTES.md` holds the TestNet
rehearsal's txids.

---

## 1. Order that cannot reverse

Two facts fix the order of every step in this runbook. Read them before you run anything.

- **`payTo` is the leaderboard key for the whole competition** (CLAUDE.md invariant 1). It opts
  into USDC first, then rekeys to PaymentRouter. A rekeyed account cannot sign its own asset
  opt-in, so this order cannot reverse. Once the first payment lands, `payTo` never changes.
- **The attribution tag is written at settlement, not retroactively.** `extra.tag ==
  "x402-global-challenge"` must be live in the server's 402 response before the first real
  payment. A payment that settles before the tag is live never moves into the challenge bucket.

---

## 2. Provision `payTo` and deploy PaymentRouter

Do this from a workstation, never on the server. Keep `PAY_TO_MNEMONIC`, `DEPLOYER_MNEMONIC`
and `CREDITER_MNEMONIC` out of the server's `.env` (CLAUDE.md canonical facts table).

1. Opt `payTo` into MainNet USDC (31566704).
   ```bash
   node scripts/optin-usdc.mjs PAY_TO_MNEMONIC --network mainnet --confirm-mainnet
   ```
   Check: `curl -s "https://mainnet-api.algonode.cloud/v2/accounts/<PAY_TO_ADDRESS>" | jq
   '.assets[] | select(."asset-id"==31566704)'` returns a non-empty result.

2. **TestNet/LocalNet rehearsal only.** Set `DEPLOYER_MNEMONIC`, `CREDITER_MNEMONIC`,
   `PAY_TO_ADDRESS`, `OPS_ADDRESS` and `AUDITORS` in the root `.env`, plus `NETWORK` for the
   target and `CONFIRM_MAINNET=1` if that target is MainNet. Deploy:
   ```bash
   ( set -a; . ./.env; set +a; cd contracts && pnpm run deploy:ci )
   ```
   This creates PaymentRouter from a single `DEPLOYER_MNEMONIC`, funds the app account for box
   storage, calls `setCrediter`, and calls `setIdentity` for every `AUDITORS` entry plus `ops`.
   **On MainNet, `Global.creatorAddress` must be the 2-of-3 admin multisig (ADR 0010), never one
   key** — use §2a instead of this step. Check: the command prints `PaymentRouter app id: <id>.`.
   Set `PAYMENT_ROUTER_APP_ID` to that id in `.env`. Clear `CONFIRM_MAINNET` afterward.

3. Rekey `payTo` to the app.
   ```bash
   node scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network mainnet --confirm-mainnet
   ```
   Check: `curl -s "https://mainnet-api.algonode.cloud/v2/accounts/<PAY_TO_ADDRESS>" | jq
   '."auth-addr"'` equals the app address printed in step 2 (rehearsal) or §2a (MainNet).

Clear `PAY_TO_MNEMONIC` from `.env` once step 3 succeeds. The key has no further signing power
over `payTo` (CLAUDE.md: cold keys never touch the server).

On a rehearsal network, to map another auditor later, add the entry to `AUDITORS` and rerun step
2. `deployPaymentRouter` is idempotent for the same deployer and app name: it reuses the existing
app and calls `setIdentity` again for the updated map, and refuses if the reused app's stored
`payTo` or asset id disagrees with the current configuration. On MainNet, map another auditor
with §2a's `setIdentity` procedure instead.

---

## 2a. Admin calls: multisig signing (ADR 0010, SPEC §10.2a, docs/TASK.md P8b)

On MainNet, `Global.creatorAddress` is the 2-of-3 admin multisig built from
`AUPM_ADMIN_MSIG_ADDRS` (three holder addresses, threshold 2, fixed in code — never read from the
environment). No single admin key can call `setCrediter`, `setIdentity`, `announceRelease` or
`executeRelease` alone.
`contracts/smart_contracts/payment_router/deploy-config.ts` builds each call as an unsigned
transaction file. The holders sign it offline with `goal`, never through one shared workstation
key.

**Each call follows the same three steps.** `<function>` and its own env vars are in the table
below.

1. Set the common env vars (`NETWORK=mainnet`, `CONFIRM_MAINNET=1`, `AUPM_ADMIN_MSIG_ADDRS`,
   `PAYMENT_ROUTER_APP_ID`) plus the call's own vars, then build the unsigned file:
   ```bash
   ( set -a; . ./.env; set +a; cd contracts && \
     pnpm exec tsx -e "require('./smart_contracts/payment_router/deploy-config').<function>()" )
   ```
   Check: the command prints the multisig address and the output file path.
2. Two of the three holders import the addresses once (`goal account multisig new <addr1>
   <addr2> <addr3> -T 2`), then each signs the same file in turn:
   ```bash
   goal clerk multisig sign -t <output-file>
   ```
3. Whoever holds the twice-signed file submits it:
   ```bash
   goal clerk rawsend -f <output-file>
   ```
   Check: `https://mainnet-api.algonode.cloud` lists the transaction with a round number.

| Call | `<function>` | Extra env vars | Output path (default) |
|---|---|---|---|
| `createApplication` | `deployMultisigCreate` | `PAY_TO_ADDRESS` | `./payment-router-create.txn` |
| `setCrediter(addr)` | `deployMultisigSetCrediter` | `CREDITER_ADDRESS` | `./payment-router-set-crediter.txn` |
| `setIdentity(identity, addr)` | `deployMultisigSetIdentity` | `IDENTITY`, `IDENTITY_ADDRESS` | `./payment-router-set-identity-<identity>.txn` |
| `announceRelease(to)` | `deployMultisigAnnounceRelease` | `RELEASE_TO_ADDRESS` | `./payment-router-announce-release.txn` |
| `executeRelease()` | `deployMultisigExecuteRelease` | `PAY_TO_ADDRESS`, `TREASURY_ADDRESS` | `./payment-router-execute-release.txn` |

After `createApplication` submits, set `PAYMENT_ROUTER_APP_ID` to the app id it returns before
building any of the other four files. Fund the app account for box storage before the first
`credit()` (any funder, no admin authority needed: `goal clerk send -a 1000000 -f <any-funder> -t
<APP_ADDRESS>`). Run `setIdentity` once per `AUDITORS` entry plus `ops`. Map `treasury` before the
first `executeRelease`: invariant 8 (CLAUDE.md) treats a role as onboarded only after an admin
maps it with `setIdentity`.

**`executeRelease()`'s outer fee.** `deployMultisigExecuteRelease` sets a flat outer fee of at
least 3,000 microALGO. `executeRelease()` submits up to two inner transactions: the treasury
sweep axfer, then the `payTo` rekey payment. The outer fee must pool both inner minimum fees,
plus the outer call's own fee (ADR 0010).

**The announce-to-execute delay.** `announceRelease` records the current round.
`executeRelease` refuses on-chain until 216,000 rounds pass (about 7 days at ~2.9s/round). Run
the migration procedure in §10 before `announceRelease`. Building the `executeRelease` file early
is harmless. The chain rejects a submission before the delay passes.

---

## 3. Configure and start the server

This host runs one instance (SPEC.md §10.3, one writer). Before this deploy reuses the current
TestNet host for MainNet, finish the TestNet move in `docs/TASK.md` item M0 — see
`docs/DEPLOY-GUIDE.local.md` §3 for the move's steps.

1. Set the server's `.env` or Portainer `stack.env` to hold only: `NETWORK=mainnet`,
   `ALGOD_SERVER`, `INDEXER_URL`, `PAY_TO_ADDRESS`, `PAYMENT_ROUTER_APP_ID`,
   `CREDITER_MNEMONIC`, `ATTEST_SIGNING_KEY`, `AUPM_ISSUER_URL`, `AUPM_KEY_VALID_FROM`,
   `AUDITORS`, `AUPM_BACKUP_HOST_DIR`, `PORT`, `TRUST_PROXY`, `FACILITATOR_URL`, `OPS_ADDRESS`.
   Never `PAY_TO_MNEMONIC`, `DEPLOYER_MNEMONIC`, or an auditor's or donor's mnemonic.
   Check: `grep -E 'MNEMONIC' .env` on the server prints only `CREDITER_MNEMONIC`.

2. `AUPM_ISSUER_URL` and `AUPM_KEY_VALID_FROM` come only from `.env` or `stack.env`. A shell
   export does not change them. The server refuses to boot without valid values (Q13).
   CAUTION: a new `ATTEST_SIGNING_KEY` gets a new `AUPM_KEY_VALID_FROM` (today's UTC date). A
   reused key keeps its existing `AUPM_KEY_VALID_FROM` unchanged.
   `compose.yaml` refuses to start without `AUPM_BACKUP_HOST_DIR`. `AUPM_BACKUP_HOST_DIR` and
   `PORT` are interpolated, so a shell export of either overrides the file; unset both in the
   shell before `up`. `AUPM_BACKUP_HOST_DIR` is a host directory, owned by uid 1000, bind-
   mounted at `/backup`.
   ```bash
   sudo mkdir -p <path> && sudo chown 1000:1000 <path>
   ```
   Compose prefixes the named volume `aupm-db` with the project name — the compose file's
   directory name, unless `COMPOSE_PROJECT_NAME` or a top-level `name:` overrides it — for
   example `aupm_aupm-db`. List the real name with `docker volume ls`.
   Check: `docker compose config` prints the resolved service with no missing-variable error.

3. Publish the image. Push a `v*` tag (the first AuPM release is `v0.2`, the version that
   `compose.yaml` pins). `.github/workflows/image.yml` pushes `ghcr.io/tripleight/aupm:<tag>`.
   After the first push, set the GHCR package to public once, in the GitHub package settings.
   For a later release: push the new tag, then bump the `image:` line in `compose.yaml` in a
   commit.
   Check: `docker pull ghcr.io/tripleight/aupm:<tag>` succeeds with no login.

4. Point Portainer's stack at this repository and set the stack's environment variables in the
   Portainer UI. Portainer writes them to `stack.env` next to `compose.yaml`. A push that bumps
   the `image:` line, or a manual redeploy in Portainer, pulls the new commit and restarts the
   container — no separate install step.
   Check: the Portainer stack shows the `aupm` container as running, with the pinned image tag.

5. Route the MainNet domain to this container through cloudflared, on this host. No cloudflared
   configuration file is tracked in this repository. Set the ingress rule on the host to
   `http://localhost:<PORT>`.
   Check: `curl -s https://<mainnet-domain>/api/v1/status/ms/2.1.3` returns JSON.

6. On a host that already ran the pre-rename deployment, migrate its volume and its env names
   before the first start of the renamed image:
   1. Stop the running service: `docker compose down` (this does not remove volumes).
   2. Create the new volume: `docker volume create <project>_aupm-db`.
   3. Copy the old volume's data into the new one with a throwaway container:
      ```bash
      docker run --rm -v <project>_spm-db:/from -v <project>_aupm-db:/to \
        alpine cp -a /from/. /to/
      ```
   4. In the host `.env` or Portainer `stack.env`, rename every `SPM_*` variable to its `AUPM_*`
      form: `SPM_NIGHTLY` to `AUPM_NIGHTLY`, `SPM_ISSUER_URL` to `AUPM_ISSUER_URL`,
      `SPM_KEY_VALID_FROM` to `AUPM_KEY_VALID_FROM`, `SPM_BACKUP_HOST_DIR` to
      `AUPM_BACKUP_HOST_DIR`, `SPM_DONOR_MNEMONIC` to `AUPM_DONOR_MNEMONIC`, `SPM_PROXY_URL` to
      `AUPM_PROXY_URL`.
   Check: `docker volume ls` shows `<project>_aupm-db`. After step 7 starts the service, the
   status route (step 5's check) reports the pre-migration reviews.

7. Start the stack (Portainer deploys it; on a host without Portainer, run the command below).
   ```bash
   docker compose up -d
   ```
   Check: the server logs the `feePayer` resolved from the facilitator's `getSupported()` at
   boot and does not exit. At start, the nightly job runs once (no successful run exists yet).
   After that run, `curl -s https://<mainnet-domain>/api/v1/health` returns 200. A 503 with
   `"lastSuccess": null` means the run failed: read the log line `aupm-nightly: failed — …`.

8. Add `og:site_name`, `og:title`, `og:description` and `og:image` at the domain root for the
   Bazaar merchant card. No route in this repository serves them. They belong to the front page
   deployed alongside the proxy.
   Check: `curl -s https://<mainnet-domain>/ | grep -c 'og:'` prints 4 or more.

---

## 4. Back up the database

The nightly job (§6 below) writes a dated `audit-<timestamp>.db` copy into `/backup` (the
`AUPM_BACKUP_HOST_DIR` bind mount) before it credits a batch. A failed backup stops the job
before it credits — nothing after a backup failure runs.

Set up a Backrest plan on the host, outside this repository:

1. Add `AUPM_BACKUP_HOST_DIR` to the plan.
2. Schedule it daily, after 03:17 UTC — after the nightly job's own backup step.
3. Exclude `.audit-*.db.tmp` (the nightly job's in-progress temp file).
4. Set an alert to the operator on a snapshot error. This proxy runs no status check of its own
   against the plan.

Check: after one night, the newest `audit-*.db` file in `AUPM_BACKUP_HOST_DIR` appears in the
latest Backrest snapshot.

---

## 5. Anchor and record real reviews

A review record without a real, on-chain-anchored review is a fabricated claim (CLAUDE.md
invariant 5). No route or script in this repository writes a review row except
`scripts/record-review.mjs`.

1. **Auditor, on their own machine.** Read the tarball. Then:
   ```bash
   node scripts/anchor-review.mjs <name> <version> --reviewer <login> --scope "<what you read>" \
     --key-file <path-to-mnemonic-file> --network mainnet --confirm-mainnet
   ```
   The key file holds one line, the auditor's mnemonic, and must not be readable by group or
   other. Type `yes` at the prompt.
   Check: the script prints the anchor's txid.

2. **Operator, on the server.**
   ```bash
   docker compose run --rm aupm node --import tsx/esm ../scripts/record-review.mjs <anchorTxid> \
     --network mainnet
   ```
   This needs a TTY. Never run it with `-T` or from a non-interactive job. Type `yes` at the
   prompt.
   Check: `curl -s https://<mainnet-domain>/api/v1/status/<name>/<version>` reports
   `COMMUNITY_REVIEWED` with the reviewer's login and the recorded integrity hash.

Target 3–5 anchored reviews before the first qualifying payment (`SPEC.md` §17, item Q4), then
widen toward 15–30 using the hit-rate measurement in `docs/DEPLOY-GUIDE.local.md` §2.

---

## 6. The nightly job

The proxy process schedules its own nightly job: genesis check, then reconcile, then back up,
then credit (ADR 0009, SPEC.md §13.2), daily at 03:17 UTC, plus a catch-up run at start when the
last successful run is more than 24 hours old or none exists. A Portainer redeploy carries the
schedule with it — nothing to install separately.

`AUPM_NIGHTLY=off` disables the schedule (`.env.example`). Any other value refuses to boot.

Check `GET /api/v1/health` for the last run and the last success. It answers 200 when the last
success is at most 26 hours old, else 503. Point an uptime monitor at it.

Run one pass by hand, for example right after a deploy:
```bash
docker compose run --rm aupm node --import tsx/esm src/claims/nightly-main.ts
```
A successful run logs `aupm-nightly: credited batch N, txid ...`, or, with no
`PAYMENT_ROUTER_APP_ID` set yet, a line naming why the credit step was skipped, and exits 0.
This manual entry point takes the same SQLite lease as the in-process scheduler, so the two
never run at once.

Check: `curl -s https://<mainnet-domain>/api/v1/health` shows the run just completed.

---

## 7. Claim a credited balance

An identity's mapped address claims its whole balance once it reaches `MIN_CLAIM` (100,000
microUSDC).

```bash
node scripts/claim.mjs <identity> <CLAIMANT_MNEMONIC_ENV_VAR> --network mainnet --confirm-mainnet
```
`<identity>` is `github:<login>` for an auditor, or `ops` for the ops pool. The script refuses
locally, before sending anything, when the balance is below `MIN_CLAIM` or the signer is not the
mapped address.

Check: the script prints the claim txid. The claimant's USDC balance increases by the claimed
amount.

---

## 8. Qualify

1. Check attribution before the first real payment.
   ```bash
   node scripts/check-402.mjs "https://<mainnet-domain>/v1/attest?name=ms&version=2.1.3"
   ```
   Check: exits 0, prints PASS for `extra.tag`, `extra.asset`, `network` and `extra.feePayer`.
2. One real payment from a real wallet, not from localhost and not scripted.
   Check: the resource appears under `/discovery/resources`. The merchant appears under
   `src=x402-global-challenge` on the facilitator's leaderboard.
3. Record the settle txid and the leaderboard result in `NOTES.md`.
   Check: `NOTES.md` carries a dated entry with the settle txid.

```bash
for s in x402-global-challenge bazaar direct dev; do
  curl -s "https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&limit=200&range=all&env=mainnet&src=$s" \
  | jq --arg a "<PAY_TO_ADDRESS>" '.items[] | select(.address==$a) | {rank,settles,volume}'; done
```
If volume lands under `dev` or `direct`, attribution never went live before the payment settled.
Fix the tag first. A misattributed payment does not migrate.

The facilitator classifies localhost traffic, cron pings, retry storms and self-payment loops as
`DEV`. Those settle for real and never count. Use event-triggered CI only, one wallet per
adopting team, and no retry beyond the protocol's single retry.

---

## 9. Third-party donors

Each donor needs the `aupm-attest` Action merged into their repository, a MainNet address, a
USDC opt-in, and a few dollars of Algorand-native USDC. Acquiring that USDC is the slow step:
most people hold none on Algorand, and an exchange withdrawal takes days.

Check that each donor shows up as a distinct address under `cat=payers` on the facilitator's
leaderboard. Team wallets are labelled as such in `NOTES.md` and in the submission.

The Action fails open by design: a facilitator outage, a 5xx, or a missing wallet secret logs an
alert and exits 0. Keep it that way — an attestation step that fails a third party's CI gets
removed from their repository the first time it does, and the donation volume goes with it.

---

## 10. Migrate PaymentRouter to a new app (planned for the MainNet build, P8)

`releaseAuthority(to)` becomes `announceRelease(to)` and `executeRelease()` under P8 (ADR 0010,
SPEC.md §10.2a). Run this procedure before `announceRelease`, every time.

1. Deploy and build the new PaymentRouter app (`docs/RUNBOOK-contract-build.md`). Do not rekey
   `payTo` to it yet.
2. Run one final `credit()` batch against the old app.
   ```bash
   docker compose run --rm aupm node --import tsx/esm src/claims/nightly-main.ts
   ```
   Check: the log line names the credited batch and a credit txid.
3. Announce the migration to every payee (auditors, ops, and any onboarded role): the new app id,
   the claim window, and the round `announceRelease` was called at.
4. Call `announceRelease(to)` on the old app, with `to` set to `payTo`'s current address (the
   rekey target stays `payTo` itself; only the authorizer changes). Follow §2a's three-step
   multisig procedure with `deployMultisigAnnounceRelease` and `RELEASE_TO_ADDRESS`.
5. Tell payees to `claim()` their balance on the old app before the delay window ends (about
   7 days, 216,000 rounds).
   ```bash
   node scripts/claim.mjs <identity> <CLAIMANT_MNEMONIC_ENV_VAR> --network mainnet --confirm-mainnet
   ```
   Check: each payee who claims in time shows a claim txid and a balance of 0 on the old app.
6. Before `executeRelease`, stop the nightly job against the old app id.
   ```bash
   AUPM_NIGHTLY=off  # set on the old app's deployment, then redeploy
   ```
   Check: `GET /api/v1/health` on the old app's deployment shows no further scheduled run.
7. Call `executeRelease()` on the old app. It sweeps `creditedUnclaimed` to the address mapped to
   identity `"treasury"`, sets `creditedUnclaimed` to 0, marks the old app retired, and rekeys
   `payTo` to the new app. This fails if `"treasury"` is not mapped with `setIdentity` — map it
   first (§2a). It also fails on-chain if the 216,000-round delay since `announceRelease` has not
   passed. Follow §2a's three-step multisig procedure with `deployMultisigExecuteRelease`,
   `PAY_TO_ADDRESS` and `TREASURY_ADDRESS`. Its outer fee is a flat 3,000 microALGO or more,
   pooling the two inner transactions this call submits.
   Check: `payTo`'s `auth-addr` equals the new app's address. `credit()` and `claim()` on the old
   app now fail.
8. Pay each payee who missed the claim window their swept balance off-chain, on request. The old
   app's balance boxes stay in place as proof of the amount owed; nothing deletes them.

---

## 11. Known open items

**Legal.** AuPM holds funds owed to third parties. For a German operator this may touch
payment-services regulation. Get advice before paying anyone outside the team. It carries no
weight in the competition. It is personal exposure.
