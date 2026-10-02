# An empty attestation request gets the 402 challenge, not a 400

Clients and the facilitator's x402 doctor probe a paid route with an unpaid request that has no
input. They expect the 402 challenge first. SPEC §10.5 validates first and answers 400 before
any 402, so the doctor's `gate` check fails. We make a narrow exception. `POST
/v1/attest/lockfile` with an empty body (0 bytes), and `GET /v1/attest` with neither `name` nor
`version`, answer 402. The price is that of one reviewed package (1,000 µUSDC). `extra`
(`asset`, `feePayer`, `tag`) and the route extensions (`bazaar`, `x402-merchant`) are the same
as on every paid route. Every other invalid request still answers 400 before any 402: a
non-empty malformed body, a body over a limit, or only one of `name` and `version`. With
`X-AuPM-Donate: 0`, an empty request answers 400, because the free path never returns 402. A
paid retry with an empty request is never charged: the handler answers 400, and the middleware
skips settlement when the handler returns 400 or more (SPEC §10.5 point 2). Invariant 4 holds:
an empty request carries no content. We rejected 402 for every invalid request, because a
caller must never build and sign a payment for a request that cannot succeed.
