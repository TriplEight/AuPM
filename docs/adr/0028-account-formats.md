# Two recovery-phrase formats for keys that a person types

Every AuPM tool reads only a 25-word Algorand mnemonic (Algo25). Pera makes a 24-word "Universal
Wallet" by default. That phrase is a BIP-39 seed, and Pera derives its accounts from it with
ARC-52 (BIP32-Ed25519). On chain, both formats give an ordinary ed25519 account. Only the backup
format and the derivation are different. A person with a Pera Universal Wallet cannot use AuPM
today without a second account.

AuPM accepts two formats where a person types or stores a recovery phrase:

1. A 25-word Algo25 mnemonic. Existing keys stay valid: the MainNet donor, the
   `aupm-action-demo` CI secret and the MainNet auditor.
2. A 24-word Universal Wallet phrase. The tool derives the first account in the same way as
   Pera.

The tool identifies the format from the word count. Any other word count is an error that names
the two accepted formats.

The 24-word support needs one fact before code: the ARC-52 variant (Peikert or Khovratovich)
and the path (`m/44'/283'/n'/0/0` or `m/44'/283'/0'/0/n`) that Pera uses for its first account.
A person makes a TestNet Universal Wallet in Pera with throwaway words. The orchestrator compares
its first address with `peikertXHdWalletGenerator` from `@algorandfoundation/algokit-utils/crypto`
and records the test vector here. Until then, the tools accept only Algo25.

Native Falcon-1024 post-quantum accounts are live on MainNet since go-algorand v5.0.0. Their
backup is also a 25-word mnemonic. AuPM does not accept them yet. A later item tests a
Falcon-signed donor payment through `@x402-avm/*` and the facilitator, a Falcon `claim()` and a
Falcon review anchor. Falcon support comes only after each money path passes on TestNet.

An agent never generates a wallet and never sees a recovery phrase. Key generation stays a human
step on a terminal (`aupm donor init`). The MCP server signs only with a key file that exists.
The derivation code derives an address from a phrase that a person typed. It never makes a
phrase for an agent.

The donor key file stays at `$XDG_CONFIG_HOME/aupm/donor.key` (ADR 0016). This ADR does not
change what `aupm donor init` creates. Auditor commands read the key from a hidden terminal
prompt for each command. They never read it from a file or an env var, because the auditor key
is a cold key.
