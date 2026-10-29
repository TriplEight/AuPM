# AuPM onboarding

This guide gives the onboarding procedure for each AuPM user role. Do the steps in order.

NOTE: the AuPM authors are not affiliated with any third-party service or app that this guide
links, and do not endorse it. The links are for convenience only.

| Role | You want to | Wallet | Cost |
|---|---|---|---|
| [CLI user](#1-cli-user) | Install packages through AuPM | None | Free |
| [Donor](#2-donor) | Pay for reviews of the packages you install | A key that `aupm` makes | 0.01 USDC per reviewed package (x1) |
| [MCP user](#3-mcp-user) | Let a coding agent check and install packages | None, or the donor key | Free, or as a donor |
| [GitHub Action user](#4-github-action-user) | Install through AuPM in CI, and donate from CI | None, or the donor key | Free, or as a donor |
| [Auditor](#5-auditor) | Read tarballs, record reviews and get paid | A cold account that you control | Small ALGO fees |

The HTTP routes, the status lookup and the offline check of an attestation are in
[API.md](API.md).

## 0. Before you start

### Public values

| Value | MainNet |
|---|---|
| AuPM origin | `https://aupm.fyi` |
| USDC asset id | `31566704` (6 decimals) |
| Price | Per reviewed package: default 10,000 microUSDC ($0.01, x1), minimum 1,000 ($0.001, x0.1), maximum x100 |

WARNING: other assets use the name "USDC". Always select the USDC asset by the id `31566704`.

### Install the CLI

You need Node 22.14.0 or later.

```bash
npm install -g aupm-cli
aupm
```

The second command prints the usage.

If npm stops with `ENOVERSIONS`, your npm `before` or `min-release-age` setting hides the new
versions. Run `npm install -g aupm-cli --min-release-age=0`, or wait some days.

### Optional: fund an account

Do this phase only if you donate or audit. A CLI user and a free MCP or Action user need no
account.

1. Donors: make the donor key first. Run `aupm donor init` (section 2, step 1). It prints the
   address to fund.
2. Get ALGO and USDC on Algorand. For example, buy with Pera Fund in Pera Wallet. See the
   [Pera Fund guide](https://support.perawallet.app/en/article/funding-an-account-using-pera-fund-oyinow/).
3. Do a check of the first 6 and the last 6 characters of each address before you send.

## 1. CLI user

You need the CLI (section 0). You need no wallet and no account. Nothing in this section costs
money.

1. Install a package through AuPM. Use `aupm` where you use `npm`:

   ```bash
   aupm install ms@2.1.3
   ```

   `aupm` runs the real npm against the AuPM registry. It passes npm's arguments, output and exit
   code through. After the install, it prints the number of packages in each group: reviewed, not
   reviewed, integrity mismatch and unresolvable. For example:
   `Reviewed: 0. Not reviewed: 12. Integrity mismatch: 0. Unresolvable: 0.` The next line is a
   pointer: ``Known advisories: run `npm audit` (source: npm, GitHub Advisory Database). AuPM does
   not check advisories yet.`` AuPM reads no advisory data. A package that is not
   reviewed is the normal case. If the integrity mismatch count is more than 0, do not use those
   packages. If the lockfile contains reviewed packages, `aupm` also prints what a donation would
   cost. It does not donate without `--donate`.
2. Use pnpm, yarn classic or npx the same way:

   ```bash
   aupm pnpm add ms@2.1.3
   aupm yarn add ms@2.1.3       # yarn classic (v1) only
   aupm npx cowsay hi
   ```

   `aupm pnpm` and `aupm yarn` need pnpm or yarn classic on your computer. `aupm` does not
   install them.

3. Optional: use plain npm with the AuPM registry:

   ```bash
   npm config set registry https://aupm.fyi/
   ```

   To go back, run `npm config delete registry`.

Plain `npm install` never donates. `aupm install` donates only with `--donate`, or after
`aupm config set donate true` (section 2).

Each donation pays for human review. The split is 40/10/25/20/5. Treasury (20%) and ops (5%)
come off the top. The other 75% goes to a pool for the exact package version: the reviewer line
(40%), the contributor (10%) and the maintainer (25%). The contributor and maintainer roles are
not onboarded yet. Until then, their shares (35%) go to the treasury. See
[Where the money goes](../README.md#where-the-money-goes).

| Status | Meaning |
|---|---|
| `UNREVIEWED` | No auditor read this exact tarball. This is the normal answer today. |
| `COMMUNITY_REVIEWED` | A human auditor read this exact tarball and anchored the review on chain. |
| `INTEGRITY_MISMATCH` | The tarball does not match the npm integrity. Do not install it. |
| `UNRESOLVABLE` | AuPM cannot resolve this entry. |

## 2. Donor

A donor pays 0.01 USDC (x1, the default) for each reviewed package in a lockfile.

The split is 40/10/25/20/5. Treasury (20%) and ops (5%) come off the top. The other 75% goes to
a pool for the exact package version: the reviewer line (40%), the contributor (10%) and the
maintainer (25%). The contributor and maintainer roles are not onboarded yet. Until then, their
shares (35%) go to the treasury. See [Where the money goes](../README.md#where-the-money-goes).

A donation happens only when you opt in.

### What you need

- The `aupm` CLI (section 0).
- About 0.3 ALGO and 1 to 5 USDC on Algorand (section 0). 1 USDC pays for 100 reviewed
  packages at x1.

The donor key is a hot key. It is in a file on your computer. Keep only a small amount of USDC
in it. Do not use an account that holds anything else.

### Procedure

1. Make the donor key:

   ```bash
   aupm donor init
   ```

   - On a terminal, `init` makes a new Algorand account and shows the 25 words one time. It
     shows them on a separate screen. It saves nothing yet.
   - Do not record or share your screen while `init` runs. A screen recording keeps the words.
   - Write the 25 words on paper, in order. Type `yes`. The words leave the screen. `init` then
     writes them to `~/.config/aupm/donor.key` (mode 0600). It never overwrites the file. Any
     other answer asks again.
   - To stop, press Ctrl-C. `init` then prints
     `Stopped. Nothing was saved.` The next `aupm donor init` makes a new account.
   - `init` shows one step on each screen and waits for you. It prints the donor address.
   - Without a terminal, or with `--yes`, `init` writes the key file at once. It never prints the
     words. Back up the key file: open it in a text editor and copy the 25 words by hand.
   - Run `aupm donor init` again at any time. If the donor account has an opt-in and USDC, `init`
     prints a short summary: the address, the ALGO balance, the USDC balance, the number of
     reviewed packages that the USDC pays for, and the `donate` setting with its source.
2. Optional: import the donor key into Pera Wallet. After you type `yes`, `init` prints
   `Optional: import the wallet into Pera Wallet.` Pera then keeps a second copy of the key, and
   you can fund the donor account from Pera directly. In Pera, select **Add account**, then
   **Import an account**, and type the 25 words.
3. Send about 0.3 ALGO to the donor address. `init` shows a QR code for 0.3 ALGO. The minimum is
   0.201 ALGO. 0.1 ALGO stays locked in the account. 0.1 ALGO stays locked for the USDC
   opt-in. 0.001 ALGO pays the fee. The facilitator pays the fee of each donation, so donations do not spend this ALGO.
4. Opt the donor account in to USDC. On the terminal, press Enter. `init` checks the balance one
   time and sends the opt-in. If the ALGO has not arrived, `init` prints
   `The ALGO has not arrived yet. Wait for the transfer, then press Enter.` If you stopped
   `init`, run:

   ```bash
   aupm donor optin
   ```

   If the ALGO is not there yet, `optin` prints
   `Cannot opt in to USDC yet. The wallet needs <N> more ALGO. Nothing was sent.` and the
   shortfall, and exits 1. Run it again later.
5. Send 1 to 5 USDC (asset `31566704`) to the donor address. After the opt-in, `init`,
   `aupm donor optin` and `aupm donor status` show a QR code for 1 USDC. On the terminal, press
   Enter after you send it. If the USDC has not arrived, `init` prints
   `The USDC has not arrived yet. Wait for the transfer, then press Enter.` When the USDC
   arrives, `init` shows the donate step.
6. Check the donor account:

   ```bash
   aupm donor status
   ```

   It shows the ALGO balance, the opt-in, the USDC balance, the number of reviewed packages that
   the USDC pays for, and the next step. It sends nothing.
7. Donate. Add `--donate` to an install command:

   ```bash
   aupm install --donate
   ```

   The cost is 1,000 microUSDC times your multiplier in tenths times the reviewed entries in the
   lockfile. The default multiplier is 10 (x1, $0.01 per entry). There is no cap and no discount. A lockfile with no reviewed entry is free. Without
   `--donate`, the install summary says that a donation is optional. If you have no donor key, it tells you to run
   `aupm donor init` once.
8. Check the payment. A paid run prints the settlement txid. Open it in an Algorand explorer, for
   example `https://lora.algokit.io/mainnet/transaction/<txid>`.

### Donate on every run

```bash
aupm config set donate true     # writes donate = true to ~/.config/aupm/config.toml
aupm config get donate          # prints the value and its source
aupm install --no-donate        # skips the donation one time
```

The order of precedence is: `--donate` or `--no-donate`, then `AUPM_DONATE`, then the config
file, then off. `aupm config` manages AuPM settings only. For npm settings, use `npm config`.

### Key rules

- If you set the `AUPM_DONOR_MNEMONIC` environment variable, `aupm` uses it and ignores the key
  file. `init` and `status` tell you. If the value is not a valid phrase, they tell you to run
  `unset AUPM_DONOR_MNEMONIC`.
- `aupm` refuses a key file with a mode wider than 0600. To correct it, run `chmod 600 <path>`.
- `aupm` refuses to sign more than 1,000 microUSDC times your multiplier in tenths per lockfile
  entry. It refuses any asset other
  than USDC.
- If you lose the key file and all copies of the 25 words, you lose the USDC in the donor
  account.
- To stop: send the remaining USDC and ALGO to another account. Then remove the key file.

## 3. MCP user

The MCP server gives a coding agent three tools:

| Tool | Cost | What it does |
|---|---|---|
| `check_audit_status` | Free | Returns the review status of one exact package version. |
| `install_audited_package` | Free, or a donation | Downloads the tarball of one package version through AuPM to a temporary folder. It returns the path. It does not change your project. |
| `attest_lockfile` | Free, or a donation | Returns one signed attestation for a `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`. |

### Procedure

1. Install Node 22.14.0 or later.
2. Add the server to the configuration of your MCP client:

   ```json
   { "mcpServers": { "aupm": { "command": "npx", "args": ["-y", "aupm-mcp"] } } }
   ```

   - Claude Code: run `claude mcp add aupm -- npx -y aupm-mcp`.
   - Other clients: put the JSON in the MCP configuration file of the client.
3. Restart the client. Make sure that the three tools are in the tool list.
4. Ask the agent to check a package, for example: "Check the AuPM audit status of ms 2.1.3."

Without a donation setting, a reviewed package returns `status: 'donation_required'` with the
price and the resource URL. The server signs nothing.

### Donations

1. Do the donor procedure in section 2, steps 1 to 6. The MCP server reads the same key file,
   `~/.config/aupm/donor.key`. The MCP server never makes a key.
2. Do not put the 25 words in the MCP configuration file. A configuration file is often shared
   or synced.
3. Select one of the two ways to donate:
   - **Always.** Run `aupm config set donate true`, or set `AUPM_DONATE=true` in the environment
     of the MCP server. Each paid tool call then donates. A call with `allowDonation: false`
     does not donate.
   - **Per call.** Keep the setting off. The agent sets `allowDonation: true` on each call that
     pays. Example: "Attest package-lock.json with AuPM and donate for the reviewed packages."
4. Check the result. A paid call returns the settlement txid.

CAUTION: with the setting on, or with `allowDonation`, an agent can spend from the donor account.
Keep a small USDC balance in it. Check the balance with `aupm donor status`.

An agent without MCP can read `https://aupm.fyi/llms.txt`. It describes the HTTP routes and the
results.

## 4. GitHub Action user

The AuPM Action replaces an `npm ci`, `pnpm install --frozen-lockfile` or
`yarn install --frozen-lockfile` step. It installs through AuPM. If AuPM fails, it installs from
the public registry. An AuPM failure never fails your job. With a donor secret, it donates for
each reviewed package in the lockfile. The price is in the "Public values" table in
[section 0](#public-values).

```yaml
- uses: TriplEight/AuPM/.github/actions/aupm@<40-character SHA>
  with:
    endpoint: https://aupm.fyi
    donate: 'true'                                            # omit for free use
    donor-secret: ${{ secrets.AUPM_DONOR_MNEMONIC_MAINNET }}  # omit for free use
```

The full procedure is in the
[demo repository](https://github.com/TriplEight/aupm-action-demo): fork, key, secret, pin,
receipt and TestNet rehearsal. The input reference is
[.github/actions/aupm/README.md](../.github/actions/aupm/README.md).

## 5. Auditor

An auditor reads the exact tarball of a package version and records the review on chain. Then
AuPM shows that version as `COMMUNITY_REVIEWED`. The reviewer line of that version gets 40% of
each donation for it. If you are the only auditor of the version, that is 4,000 microUSDC for
each donation at x1.

NOTE: this audit process is the MVP version. It will change soon, after the auditor pilot.

### What you need

- A GitHub account. Your GitHub login is your auditor identity.
- A cold Algorand account. This account signs your reviews and receives your USDC. Two kinds
  work:
  - A Pera Universal Wallet account (24-word recovery phrase). `aupm` uses the first account that
    Pera shows. For another account of the same wallet, add `--address <address>` to `review`.
  - An Algo25 account (25-word recovery phrase).
- About 0.3 ALGO (section 0): 0.1 for the account, 0.1 for the USDC opt-in and 0.001 for each
  review. A payout to you costs you no ALGO.
- The `aupm` CLI (section 0).

### Precautions

- Keep the recovery phrase on paper, offline. Never type it into a website, a chat, an issue or
  an AI agent.
- Type the phrase only into the hidden prompt of an `aupm auditor` command, on your own computer.
  `aupm` does not store it.
- Use this account only for AuPM reviews. Do not keep other funds in it.
- The AuPM team never asks for your recovery phrase.

### Procedure

1. Apply. [Open an issue with the "Auditor application" form](https://github.com/TriplEight/AuPM/issues/new?template=auditor-application.yml).
   Give the address of the account. Opt the account in to USDC (asset `31566704`) before you apply.
   The ops check the opt-in. Then they add the address as your payout address.
   They also add the address that signs your reviews, with
   `pnpm -C proxy auditor add github:<login> <address>`. The two addresses can differ.
   If you lose the review key or it leaks, tell the ops. They replace it with
   `pnpm -C proxy auditor rotate github:<login> <new-address> [--until <round>]`. The old key
   stays valid for anchors confirmed up to the cutoff round. The new key starts one round later.
2. Read the files. Get the exact tarball that users install:

   ```bash
   npm pack ms@2.1.3
   tar -xzf ms-2.1.3.tgz
   ```

   Read the files in `package/`.
3. Record the review:

   ```bash
   aupm auditor review ms@2.1.3
   ```

   - The command asks for your recovery phrase in a hidden prompt. The screen shows nothing while
     you type. If your terminal is not interactive, it stops and tells you so.
   - For a Pera wallet with several accounts, add `--address <address>` to pick the account.
   - It asks four questions: what you read, the install scripts, your findings, and what changed
     since your previous reviewed version. It shows that previous version. Type `first review`
     for the last question if this is your first review of the package. The whole review note
     must fit in 1,024 bytes, so keep the answers short.
   - It prints every field of the review. It asks `Send this review to the blockchain?` Type
     `yes` to send it. It sends one 0-ALGO transaction from your account to your own account. The
     note holds the review. The fee is 0.001 ALGO. You cannot undo it.
   - It prints `Review recorded.`, the txid and an explorer link.
   - Add `--login <your GitHub login>` to skip the login question.
4. Post the txid in your application issue.
5. Check your reviews. After the ops record a review, this command shows it:

   ```bash
   aupm auditor status <your GitHub login>
   ```

   Before the ops record a review, it prints
   `No reviews found for github:<your GitHub login>.`

6. Wait for the ops to return to you. They reply in your issue.
7. Get paid. You send no transaction for this.
   - Each donation for a version that you reviewed adds your share to your balance in the AuPM
     ledger.
   - AuPM holds each share for 30 days after the donation. A dispute can freeze a held share.
     After the hold, the share is yours.
   - The nightly job sends your matured balance to your payout address when one of these rules
     applies:
     - The balance is 1 USDC (1,000,000 microUSDC) or more.
     - Your last payout was 7 days ago or more, and the balance is 0.1 USDC or more.
     - Your last payout was 30 days ago or more, and the balance is 0.01 USDC or more.
   - A smaller balance stays in the ledger until a rule applies. The ops can change these
     values.
   - Keep the USDC opt-in on your payout address. Before each payout, the job checks it. If the
     check fails, the job skips your payout and the ops tell you. Your balance stays.

   ```bash
   aupm auditor balance <your GitHub login> --address <your payout address>
   ```

   - The command prints your held, matured unpaid, frozen and paid amounts and your last
     payout time.
   - The last line is `Next step:`. It tells you what to do.
   - `--address` makes the command check the USDC opt-in and the frozen state of your payout
     address on the Algorand node. The command never sends the address to the AuPM server.
     Without `--address`, the command asks you to add it.
   - If no payout address is set, the `Next step:` line tells you to send the address to the
     ops (step 1).

## Help

- Questions and bugs: open an issue in `TriplEight/AuPM`.
- How AuPM works: [README.md](../README.md).
- The HTTP routes: [API.md](API.md).
