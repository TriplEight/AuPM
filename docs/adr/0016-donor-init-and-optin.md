# `aupm donor init` creates the donor key and opts in to USDC

A donor needs a funded Algorand account that holds USDC and has opted in to the USDC asset. Before
this change, the donor made the account and the opt-in by hand and exported the mnemonic in an
env var. `aupm donor init` creates the account with algosdk and writes
`AUPM_DONOR_MNEMONIC=<25 words>` to `$XDG_CONFIG_HOME/aupm/donor.env` (default
`~/.config/aupm/donor.env`). The directory has mode 0700 and the file has mode 0600. The write is
exclusive: `init` refuses when the file exists and never overwrites a key. It never prints the
mnemonic. It prints the address, the path, an ARC-26 `algorand://<address>` URI, a terminal QR code
of the URI and the funding needed. Then it runs `aupm donor optin`.

`optin` polls algod until the ALGO balance covers the minimum balance with one more asset (0.1
ALGO) and the 1,000 microALGO fee. Then it signs and sends one 0-amount transfer of the USDC asset
to the donor's own address. An account that already holds the asset prints "already opted in" and
exits 0 without a transaction. A timeout (15 minutes, or `--timeout <minutes>`) exits non-zero and
prints the address and the funding. Ctrl-C exits 0.

The opt-in goes from the donor to algod directly. It is not an x402 payment: it moves no funds, it
has no `PAYMENT-REQUIRED` challenge and it does not use the facilitator. Invariant 6 (the
facilitator is mandatory, no direct chain submission) covers payments only, so it does not apply.
The donor pays the opt-in fee in ALGO, which is the reason for the ALGO funding step.

The donor client reads the key file when `AUPM_DONOR_MNEMONIC` is unset. The env var wins. A file
with a mode wider than 0600 is refused with `chmod 600 <path>`. This replaces the rule "no stored
credential file" in SPEC §11.4. The file lives on the donor's own machine. The server never holds
it, so the rule that cold keys stay off the server holds.

We rejected a key in the OS keychain: it needs a native dependency and it does not work in CI. We
rejected printing the mnemonic for the donor to copy: it leaks into terminal history and logs.
The QR code comes from `uqr`, which has no dependencies.
