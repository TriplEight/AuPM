# The auditor anchors each review with a note transaction

Each review is anchored on-chain by a 0-ALGO payment from the auditor's address to itself. Its
note is an ARC-2 JSON note `aupm:j{...}` with the package name, version, `dist.integrity`,
reviewer and review scope. The server records a review only from a confirmed anchor whose sender
is the mapped address of that auditor. We rejected `attest()` on PaymentRouter: it put the
contract on the qualification path (a review is needed before any 402), it used box storage for
each review, and a contract write by the auditor proves no more than the auditor's own signed
transaction. `attest()` and `setAttestationKey()` leave the contract.
