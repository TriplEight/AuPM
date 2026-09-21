# SPM build log (two-dev handoff)

Use `/handoff <summary>` to append entries. Newest at top.

## 2026-09-20 Handoff — ready for MainNet launch

- **Changed**: Attestation routes, claims ledger, `spm verify`, MainNet MCP payer,
  eager boot guard, published attestation keys route, Biome, invariant guard,
  git hooks, CI, and a rewritten verification harness. Twelve spec corrections.
  README rewritten for MainNet.
- **Files**: `proxy/src/{app,config}.ts`, `proxy/src/{attest,claims,x402,routes}/*`,
  `cli/src/verify.ts`, `contracts/.../contract.algo.ts`, `scripts/*`,
  `SPEC-v3.md`, `README.md`, `STATUS.md`.
- **State**: 147 proxy, 8 cli, 7 contracts, 5 mcp, 6 action tests pass.
  Typecheck, guard and `biome ci` all clean. `scripts/verify.sh` exits 0 with
  the e2e step SKIPPED, because this sandbox cannot reach the facilitator.
- **Blocked**: Nothing buildable. What remains needs a chain, a domain, or a
  human reviewer.
- **Next**: Follow `docs/RUNBOOK-mainnet-launch.md`. WARNING: read its section 1
  first. `distribute()` will not run below 100,000 microUSDC, so a single
  $0.001 payment cannot produce the five inner transfers the qualification
  checklist requires. Five lockfile calls, or a direct top-up, reach the floor.

## 2026-09-19 Contract artifacts stale — build needed on a Docker machine

- **Changed**: `SplitRouter` reworked for the v3 MainNet spec. `pay()` removed;
  `distribute()`, `releaseAuthority()`, `setAttestationKey()` added; `attest()`
  gained an `integrity` argument. Proxy migrated to the x402 middleware;
  `settle.ts` deleted. DSSE attestation signing added. `spm verify` added.
  Biome, an invariant guard, pre-commit hooks and CI added.
- **Files**: `contracts/smart_contracts/split_router/*`, `proxy/src/{app,config}.ts`,
  `proxy/src/x402/*`, `proxy/src/attest/*`, `cli/src/verify.ts`, `scripts/guard.sh`,
  `biome.json`, `.githooks/pre-commit`, `.github/workflows/ci.yml`.
- **State**: 45 proxy, 8 cli, 7 contracts, 5 mcp and 6 action tests pass.
  Typecheck passes. Guard is clean. Direct-dependency advisories are zero.
- **Blocked**: `contracts/smart_contracts/artifacts/` is STALE. The committed
  ARC-56 spec still lists `pay()` and lacks `distribute()`. The session that
  reworked the contract had no Docker and no AlgoKit CLI, so it could not
  compile with Puya or run LocalNet. WARNING: the JavaScript test harness does
  not prove the contract compiles or runs on the AVM.
- **Next**: Run `docs/RUNBOOK-contract-build.md` on a machine with Docker and
  the AlgoKit CLI. It lists the build commands, the ABI that must appear, the
  five constructs most likely to fail under Puya, the LocalNet rehearsal, and
  the irreversible opt-in-before-rekey ordering for `payTo`.

## 2026-06-07 EURD bonus track integrated

- **Changed**: Added `@ever_amsterdam/x402-euro-eurd@0.1.1` (zero prod deps) to MCP. Proxy 402 response now includes `exact+algorand:mainnet` EURD entry when `EURD_MAINNET_ASA_ID`+`EURD_PAY_TO` env vars set. `settle.ts` dispatches on proof type (USDC signed-group vs Quantoz bridge transactionCode). MCP `install_audited_package` uses `withEurPayment` wrapper when `QUANTOZ_API_KEY`+`QUANTOZ_ACCOUNT` present; falls back to USDC otherwise. Fixed pre-existing `MockAlgod` missing `getApplicationByID` in MCP test.
- **Files**: `mcp/src/tools/install.ts`, `mcp/src/tools/install.test.ts`, `mcp/package.json`, `proxy/src/app.ts`, `proxy/src/settle.ts`, `.env` (added EURD/Quantoz var stubs).
- **State**: `SPLIT_APP_ID=764063661` on TestNet. EURD vars blank — EURD path inactive until filled.
- **Blocked**: Need `EURD_MAINNET_ASA_ID` from Quantoz docs + a funded Quantoz account (`QUANTOZ_API_KEY`, `QUANTOZ_ACCOUNT`) for live EURD payment demo.
- **Next**: Get EURD ASA ID from https://docs.ai.quantozpay.com, set env vars, run `NETWORK=testnet bash scripts/demo.sh` to confirm EURD path end-to-end.

## 2026-06-07 G4 complete — verify.sh green

- **Changed**: G1–G4 all done; pure-JS contract tests (algorand-typescript-testing), Hono proxy + SQLite x402 gate, MCP install/check tools, e2e checks (status/gate/auto-reset) all pass.
- **Files**: `contracts/vitest.config.mts`, `contracts/vitest.setup.ts`, `contracts/smart_contracts/split_router/contract.algo.{ts,spec.ts}`, `proxy/src/**`, `mcp/src/tools/{install,check}.{ts,test.ts}`, `scripts/{verify,e2e}.{sh,mjs}`, `pnpm-workspace.yaml`.
- **State**: No deployed contract; `SPLIT_APP_ID` and `PAYER_MNEMONIC` unset — paid-install e2e check skips (requires LocalNet with Docker or TestNet).
- **Blocked**: Docker not available → no LocalNet → on-chain paid-install e2e skipped.
- **Next**: Deploy SplitRouter to TestNet via `algokit project deploy testnet`; fund payer wallet; set `SPLIT_APP_ID` + `PAYER_MNEMONIC`; run `NETWORK=testnet bash scripts/demo.sh` (G5).

## <date> bootstrap
- Repo scaffolded; Algorand agent skills + .mcp.json in place; SPM Claude config written.
- Next: Dev A -> proxy passthrough (hr1 sync); Dev B -> SplitRouter on LocalNet.

## 2026-09-19 W0 x402-avm research (no code changed)

- **Task**: Read installed @x402-avm packages, answer 5 questions with file:line citations.
- **Findings**: See `/tmp/claude-0/-home-user-SPM/49e092e2-974a-5c45-b1bb-a30d7a0befbf/scratchpad/w0-findings.md`.
- **Key answer**: Hono middleware DOES discard the handler body on settlement failure (returns a new Response built from the settlement error, not the handler's body) — `hono/dist/esm/index.mjs:176-182`.
- **Key answer**: Middleware skips settlement entirely when handler status >= 400 — `hono/dist/esm/index.mjs:164-166`.
- **Next**: Feed these findings into the proxy's x402 gate implementation (spm-x402-flow skill).

## 2026-09-21 — handoff to the Docker / AlgoKit / MainNet session

Branch `claude/spm-spec-orchestration-dlhhe2`, 35 commits, all pushed.

Implementation of SPEC-v3 is complete except the contract artifacts, which
need Docker and the AlgoKit CLI. Three code reviews ran after implementation
and found 25 defects the test suite did not. All are fixed except that one.

State: proxy 306, contracts 16, mcp 8, cli 16, Action 9. `pnpm typecheck`
passes, `scripts/guard.sh` is clean, `biome ci .` exits 0 with no warnings,
`scripts/verify.sh` prints `VERIFY: PASS` with an honest e2e SKIP, because the
facilitator is unreachable from this sandbox.

Read `docs/HANDOFF-next-session.md` first. Step 1 is regenerating the contract
artifacts; nothing else should happen before it. The committed ARC-56 spec
still lists the deleted `pay` and lacks `setPayTo`, `distribute` and
`releaseAuthority`.

Two decisions recorded this session:
- `payTo` may be corrected while it holds no USDC, and is immutable once any
  arrives. This replaced a write-once rule that made a typo unrecoverable.
- The CI Action no longer sends a wallet credential. That narrows spec §9 C3;
  third-party paid volume now comes from the CLI or the MCP server.

The defect worth carrying forward: the tarball path check broke four times.
The first three were spelling variants closed by adding decoder rules, and each
left the next one open. The fourth was structural, two predicates of different
width deciding the same question. `normalizeTarballPath` now replicates the
installed matcher's own steps and `isTarballRouteScope` mirrors the route key.
Any change to the route key must change both.
