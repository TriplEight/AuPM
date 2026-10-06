# `aupm donor init` creates the donor key and opts in to USDC

A donor needs a funded Algorand account that holds USDC and has opted in to the USDC asset. Before
this change, the donor made the account and the opt-in by hand and exported the mnemonic in an
env var. `aupm donor init` creates the account with algosdk and writes
the 25 words and a newline to `$XDG_CONFIG_HOME/aupm/donor.key` (default
`~/.config/aupm/donor.key`), with no variable name in the file. The directory has mode 0700 and the file has mode 0600. The write is
exclusive: `init` refuses when the file exists and never overwrites a key. It never prints the
mnemonic. It prints a warning block about the key file, the address and the network, and five
numbered next steps with ARC-26 `algorand://` URIs and terminal QR codes (ALGO, the opt-in, USDC,
an optional CI secret, the first donation). It does not continue into `optin`.

No command waits or polls. A first version polled algod for the ALGO balance, with a timeout and
a Ctrl-C handler. A person who funds a wallet from an app or an exchange needs minutes to days, so
a waiting terminal pushed them to hurry. The command now checks once and says what to do.

`optin` reads the balance once. It signs and sends one 0-amount transfer of the USDC asset to the
donor's own address when the ALGO balance covers the minimum balance with one more asset (0.1
ALGO) and the 1,000 microALGO fee. An account that already holds the asset prints "already opted
in" and exits 0 without a transaction. An unfunded account gets the exact shortfall and the ALGO
step, and exits 1. `aupm donor status` reads the same state and prints the next step. It sends
nothing.

`init` refuses when the key file exists. It prints the address in the file and says that deleting
the file loses the funds in it. When `AUPM_DONOR_MNEMONIC` is set, `init` and `status` say that it
wins over the file. On Windows the 0600 check is skipped, and the output says that the file is not
permission-protected there.

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
