# AuPM changelog

The session log is local-only (`NOTES.local.md`, untracked). This file lists merged changes.

## 2026-09-29
- #38 `5e9d315`: multisig submit instructions POST to algod, not `algokit goal clerk rawsend`.
- #39 `f803173`: `.dockerignore` excludes nested `.claude/` directories.
- #40 `7af05bd`: ADR 0012. Unread review records are allowed on TestNet only.
- #41 `1295f69`: one `credit()` call holds at most 3 entries (opcode budget 173 + 159 per entry).
  A pending batch over the limit is released and planned again.
- #42 `6a76338`: the CLI, `aupm install --donate` and the Action report the settled amount and
  txid.
- TestNet rehearsal, app 772851922: all phases pass. Credit batches 2–11, claims
  `N5LHMVSY7766AJLTQ2SUSXATADDKYYCEUFIFU5MGAYTGGIRTUAKQ` and
  `EINZFK6UI23O7P4S6R6SCT7OCUDTUPFY4S4DQ4DY46VB7GKKZOXA`.
- W1 `e2d7434`: `announceRelease(to)` targets the new app, never `payTo`. The runbook orders
  funding and checks box minimum balances.
- W5 `21b6900`: `GET /` serves the `og:` page. The `og:image` is at `/.well-known/aupm-og.png`.
  The CLI and MCP server default to `https://aupm.fyi`.
- W3 `b2c83e4`: the server reads the crediter mnemonic and the attestation key from files
  (`CREDITER_MNEMONIC_FILE`, `ATTEST_SIGNING_KEY_FILE`).

## 2026-09-28
- N0 `c11224c`: renamed the product from SPM to AuPM.
- Wave 7: P1 `7c1f182` (ADR 0010), P7 `e62666c` `5a5e613` `8cd5b5f`, P8 contract `2416bbc`,
  P8 docs `3e2a56d` (ADR 0011), P2 `eb7bc37`, P3 `b42cdfa`, P8a `bbe899e`, P8b `4bbffd7`,
  P5 `5eb4f73`, P6 `ff64c16`.
- Decisions: 2-of-3 multisig admin. Announce, then execute after 216,000 rounds. Sweep of
  unclaimed USDC goes to `treasury`.
- P8d `b918abf`: one 30/70 split on every network. The earlier TestNet app 772553842 is retired.
- P9 `f7304bb`: the CLI and the proxy import `aupm-mcp` through the workspace.
- Contract artifacts rebuilt `7e6291e`.

## 2026-09-27
- F2 `e3d349c`: Compose reads the issuer and key date only from the env file.
- F4 `e9aa06f`, `fedaa6c`, `c34839f`: clean shutdown on SIGTERM with an 8 s deadline.
- V1 `9de186e`: the verify e2e proxy takes a free port.

## 2026-09-25
- Release `v0.1.1` (`2a963e0`). Image digest
  `sha256:348ec591889f72ccf294be315bcc3e045b85d2cb80a009564647c0e874d13f4b`.
- F1 `68ed80d`: Compose pins `v0.1.1`.
- N1 `c4d07d4`: the proxy runs the nightly job at 03:17 UTC (ADR 0009). `GET /api/v1/health`
  returns 503 after 26 h without a success.
- N2 `b971d8a`: image workflow. N3 `61dbb8a`: Compose pins the image tag.
- S1 `349de5c`: `@modelcontextprotocol/sdk` 1.30.1. T1 `c086ac2`: test ports.
- R4 `07ccce4`: TestNet rehearsal, part 2. App 772553842. Rekey
  `JKW6NFYEYACVABWOO3WOGZTXMZLR333JJOIOW5RG4YHOZ7KTT5ZA`. Review anchor `ms@2.1.3`
  `4ABHLGBLN54YZMYIHIOVVITWGBJ4RUIJLLBOKGNFBRWZF36OTD3A`. Nightly credit batch 1
  `ZXPQTM6VOOI7A7URDOJP2MF4HLJDM6OX2UKKDITLHSX43DVCQ5CQ`.
- The test env clears every `.env.example` key before proxy, mcp and cli tests.

## 2026-09-24
- R4 part 1 passed on TestNet (E2E 22/22). App 772551142
  (deploy `EZRMTRJSSVRIMCCVLRPMUYA34FUBFSLGNPKLAQEWRIA77WK7XOWA`).
- Rekey `KWUTV7VBCUDMITKQ4EU3YWIQO2UOOUM4SXQPW5CMASSKFCZ2X2ZA`.
- Lockfile payment, 250 reviewed entries: `UAZG6FXFG5UUOZ5X7EKOXV35MM3NMYFOYS4KVNS4XZ77C73UBC2A`.
- Nightly credit, batch 1: `CGBHO2HHP3P2YQ442ULUAGT6TYJTGLRHQSNATPPPG2M6NEWINMVQ`.
- Claims: auditor `GWJXJRMI767QIEZYU2QAZ2ANK4ULVBDCENJB2PS6JA66SLPWPFCQ`, ops
  `ZVQ2RVZ5OG7H3VO6PQXDTJAVVRFMNI7ZZSAVULM5W3CR23VMNHPQ`.

## 2026-09-23
- Waves 1 to 4 (H1, Q1, Q5, R1, R3): hardening, tests and the release tooling.

## 2026-09-22
- SPEC v6 review. Documents only.

## 2026-09-21
- Every client opts in to donation. `SPEC.md` replaces the earlier spec file name.
- Contract artifacts regenerated. The toolchain moves to pnpm.
- Launch tooling: `scripts/check-402.mjs` and `scripts/hit-rate.mjs`.
