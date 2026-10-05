---
name: aupm-testing
description: >
  AuPM test stack, the verification harness (scripts/verify.sh), and the sandbox
  limits on running it. Use whenever you write or run tests, e2e scripts, or
  acceptance checks.
---
# Testing AuPM

## Principle
"Done" means a command exits 0 and prints PASS. Run the check and show the result.
Never weaken an assertion to make a check pass. Fix the code.

## Commands

| Scope | Command |
|---|---|
| Everything | `bash scripts/verify.sh` — prints `VERIFY: PASS` or `VERIFY: FAIL` |
| Types | `pnpm typecheck` |
| Per package | `pnpm -C proxy test`, `pnpm -C contracts test`, `pnpm -C mcp test`, `pnpm -C cli test` |
| CI Action | `node --test .github/actions/aupm/*.test.mjs` |
| Invariants | `bash scripts/guard.sh` |
| Lint | `pnpm exec biome ci .` — zero warnings |

`verify.sh` runs all of these, then `scripts/e2e.mjs` against a local proxy.
The e2e step SKIPs, with a reason, when the facilitator is unreachable. A SKIP is not a FAIL.

## Sandbox

CAUTION: inside the Bash sandbox, 4 subprocess tests in `proxy/src/index.test.ts`
fail with `listen EPERM ... .pipe`. The sandbox blocks unix sockets. Run proxy tests
and `verify.sh` with the sandbox disabled. Set `NODE_USE_ENV_PROXY=1` when a test
must reach registry.npmjs.org through the sandbox proxy.

## Stack
- proxy: vitest plus Hono `app.request()`. SQLite in a temp file. External clients
  (GitHub, indexer, facilitator) are injected; tests pass stubs.
- contracts: vitest on `algorand-typescript-testing`. See `aupm-payment-router` for its limits.
- mcp, cli: vitest.

Redirect test output to a log file. Read the exit code and the last 30 lines.
Compare integer micro-units, never floats.
