# SPM build log (two-dev handoff)

Use `/handoff <summary>` to append entries. Newest at top.

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
