# Auditor identity is `aud:<id>` with a hardware-attested OpenPGP key

Status: accepted (2026-10-11). Lands after the contest window (SPEC §15). Until then the MVP
identity `github:<login>` stays in use.

## Identity

- `aud:<id>` is the stable internal identity of an auditor. It survives key rotation and token
  loss. Reputation and the payout binding attach to it.
- A verified email is the unique contact and the recovery factor. AuPM never shows it in
  public. An email takeover can only open a re-onboarding request that an admin approves. It
  never binds a signing key by itself. Alerts about the auditor's own leases, challenges and
  payouts are transactional. News and summaries need a separate opt-in.
- Forge and npm accounts (GitHub, GitLab, Codeberg, npm) are optional linked claims, proved by a
  signed gist or an equivalent. AuPM uses them for conflict checks, never as the identity.
  Nothing binds to a GitHub login, because AuPM plans to support GitLab and other forges.
- Payment rails are not coupled to identity or reputation. The admin maps `aud:<id>` to a payout
  address from a signed payout-binding statement. A change of rail touches only the binding.

## Signing key

- OpenPGP is the auditor signing identity. AuPM publishes the fingerprints in an append-only
  `auditors.json`, signed by an AuPM registry key and tagged in git. The admin trusts the
  registry key, and public text says so.
- AuPM never holds an auditor private key. The auditor generates the key on a hardware token, or
  on a pre-provisioned token where the auditor still regenerates the key. A key made off the
  device can be cloned, and a key that AuPM issues is a key that AuPM had a copy of.
- `keyAssurance`, stored in the registry and echoed in each record:
  - `hardware-attested`: an attestation chain to the vendor CA, checked at onboarding. Full
    rights. Today AuPM knows only YubiKey attestation as verified (YubiKey 5 firmware 5.2.3 or
    later, OpenPGP 3.4, `ykman openpgp keys attest`).
  - `software`: probation rights only (small packages, no challenge or ruling role).
- Key structure: a certify-only primary key kept offline. A signing subkey on the token with a
  one-year expiry. A revocation certificate escrowed with AuPM (the certificate only, never a
  key).
- Other signer types (keyless certificates tied to an identity provider, SSH, minisign) can come
  later only with equal hardware assurance. The record envelope carries a `signerType`.

## Lifecycle

- Rotation: a new subkey. The old key becomes `retired`. Earlier reviews stay valid.
- Revocation after a compromise at time T: reviews with a witness timestamp before T stay valid.
  Later reviews, and unwitnessed reviews after the last known good time, get
  `key:compromised`. AuPM deletes nothing.
- Loss: re-onboarding with a fresh attestation. `aud:<id>` and its reputation stay.
- Retro-signing: the auditor can sign a review later when they anchored it before they had a
  key. The record says `retro-signed` with the date. It never claims a signature at review time.

## Sybil cost

An `aud:<id>` costs a hardware token, a verified email, admin approval and a probation period.
One person with several tokens can still hold several identities. Shared payout addresses,
shared affiliations and pair-frequency caps detect some of them. AuPM accepts this risk.

We rejected the GitHub login as the identity (it binds AuPM to one forge) and keys issued by AuPM
(AuPM would hold a copy).
