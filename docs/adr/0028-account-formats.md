# Two recovery-phrase formats for keys that a person types

AuPM tools first read only a 25-word Algorand mnemonic (Algo25). Pera makes a 24-word "Universal
Wallet" by default. That phrase is a BIP-39 seed, and Pera derives its accounts from it with
ARC-52 (BIP32-Ed25519). On chain, both formats give an ordinary ed25519 account. Only the backup
format and the derivation are different. A person with a Pera Universal Wallet needed a second
account to use AuPM.

AuPM accepts two formats where a person types or stores a recovery phrase:

1. A 25-word Algo25 mnemonic. Existing keys stay valid: the MainNet donor, the
   `aupm-action-demo` CI secret and the MainNet auditor.
2. A 24-word Universal Wallet phrase. The tool derives the account in the same way as Pera.

The tool identifies the format from the word count. Any other word count is an error that names
the two accepted formats.

A TestNet Universal Wallet from Pera with throwaway words gave the derivation. The phrase is a
BIP-39 English phrase with an empty passphrase. The 64-byte seed goes to ARC-52 BIP32-Ed25519 with
the Peikert variant and the path `m/44'/283'/n'/0/0`. The account is `n`, the index is 0.
`peikertXHdWalletGenerator` and `peikertXHdAccountGenerator` from
`@algorandfoundation/algokit-utils/crypto` do the derivation. The tools check the BIP-39 checksum
with `@scure/bip39` and the English word list.

The default is `n = 1`. Pera's first named account is `n = 1`. `n = 0` is the wallet root, and
the tools never use it by default. The commands that sign for an auditor (`aupm auditor review`
and `aupm auditor claim`) accept `--derivation <n>`, a non-negative integer, or
`--address <address>`, which searches `n = 0` to `19` for that address and gives an error when
none matches. The two flags exclude each other. With a 25-word key, both flags are an error. The
donor key (the key file and the env var) accepts 24 words and always uses `n = 1`. It has no
flag. `aupm donor init` still makes a 25-word key.

Test vector (a public TestNet throwaway, no funds): derivation 0 gives
`JNFVWY2Q44O3K5IYRYG5JE7ZKR4KP34JEQVGCKE7ECXKTTX7364VXFDK7M`. Derivation 1 gives
`XRGJY2DYXW3E3O34VFKLSA4VLUESY77Z2D6NBNKTNFBA76WM3NYKPTRH7A`.

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
