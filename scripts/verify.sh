#!/usr/bin/env bash
# SPM verification harness — the G4 gate.
#
# Prints PASS, FAIL, or SKIP for every check. Exits 0 only when nothing
# FAILs. A SKIP always carries a reason and never counts as a failure —
# but it never counts as a pass either.
#
# CAUTION: this workstation has no funded wallet and no deployed contract.
# Every check that needs one degrades to SKIP here. On a machine with real
# credentials and network reach to the facilitator, the same checks run for
# real — nothing here is LocalNet-specific; LocalNet does not exist for SPM.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

fail=0
declare -a SUMMARY

log_for() {
  echo "${TMPDIR:-/tmp}/spm_verify_$(echo "$1" | tr -c 'A-Za-z0-9' '_').log"
}

# run <name> <command> — PASS/FAIL only. Use for checks with no legitimate
# SKIP state (typecheck, unit tests, guard, lint).
run() {
  local name="$1" cmd="$2" log
  log="$(log_for "$name")"
  printf '%-26s ' "$name"
  if eval "$cmd" >"$log" 2>&1; then
    echo PASS
    SUMMARY+=("PASS  $name")
  else
    echo "FAIL  (see $log)"
    SUMMARY+=("FAIL  $name")
    fail=1
  fi
}

skip_line() {
  local name="$1" reason="$2"
  printf '%-26s SKIP  (%s)\n' "$name" "$reason"
  SUMMARY+=("SKIP  $name -- $reason")
}

echo "== SPM verify =="

run "typecheck"        "pnpm typecheck"
run "unit:proxy"        "pnpm --dir proxy test"
run "unit:cli"          "pnpm --dir cli test"
run "unit:contracts"    "pnpm --dir contracts test"
run "unit:mcp"          "pnpm --dir mcp test"
run "action:spm-attest" "node --test .github/actions/spm-attest/attest.test.mjs"
run "guard"             "bash scripts/guard.sh"
run "lint"              "pnpm exec biome ci ."

# ---------------------------------------------------------------------------
# e2e: start a proxy instance with ephemeral, throwaway config, then run
# scripts/e2e.mjs against it. The whole block SKIPs — never FAILs, never
# falsely PASSes — when the facilitator is unreachable from this network:
# proxy/src/index.ts refuses to open its port without one (CLAUDE.md
# invariant 6), so no proxy can start here at all in that case.
# ---------------------------------------------------------------------------
E2E_NAME="e2e"
TSX=""
for candidate in mcp proxy cli; do
  if [ -x "$ROOT/$candidate/node_modules/.bin/tsx" ]; then
    TSX="$ROOT/$candidate/node_modules/.bin/tsx"
    break
  fi
done

if [ -z "$TSX" ]; then
  echo "FAIL  ($E2E_NAME: no tsx binary found under proxy/, mcp/, or cli/ node_modules — set up dependencies with pnpm)"
  SUMMARY+=("FAIL  $E2E_NAME -- tsx not installed")
  fail=1
else
  export NETWORK="${NETWORK:-testnet}"
  export SQLITE_PATH="${TMPDIR:-/tmp}/spm_verify_$(date +%s).db"
  export SPM_PROXY_URL="${SPM_PROXY_URL:-http://localhost:4873}"
  # Ephemeral, throwaway values — never a real key or a real deployed
  # contract. Good enough to exercise the 402 gate and the signing path;
  # never good enough to move real funds. Generated fresh every run.
  export SPLIT_APP_ADDRESS="$(cd "$ROOT/proxy" && node -e "console.log(require('algosdk').generateAccount().addr.toString())")"
  export ATTEST_SIGNING_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"

  # Clear any proxy left running by an earlier, interrupted run — `tsx
  # watch` never exits on its own (see the cleanup comment below).
  pkill -f "watch src/index.ts" 2>/dev/null || true

  PROXY_LOG="${TMPDIR:-/tmp}/spm_verify_proxy.log"
  rm -f "$PROXY_LOG"
  pnpm --dir proxy dev >"$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  ready=0
  for _ in $(seq 1 40); do
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      break
    fi
    if curl -sf "$SPM_PROXY_URL/api/v1/status/ping/1.0.0" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done

  if [ "$ready" -eq 1 ]; then
    echo "-- $E2E_NAME (proxy ready at $SPM_PROXY_URL) --"
    if "$TSX" scripts/e2e.mjs; then
      SUMMARY+=("PASS  $E2E_NAME")
    else
      SUMMARY+=("FAIL  $E2E_NAME -- see output above")
      fail=1
    fi
  elif grep -q "boot failed: facilitator" "$PROXY_LOG" 2>/dev/null; then
    # The one honest SKIP path: the mandatory facilitator (CLAUDE.md
    # invariant 6) is unreachable from this network. Not a code defect.
    reason="facilitator unreachable from this environment (see $PROXY_LOG) -- proxy refuses to boot without it"
    skip_line "$E2E_NAME" "$reason"
  else
    echo "FAIL  ($E2E_NAME: proxy never became ready; see $PROXY_LOG)"
    SUMMARY+=("FAIL  $E2E_NAME -- proxy never became ready, see $PROXY_LOG")
    fail=1
  fi

  # pnpm's own PID rarely matches the tsx child it spawns, and `tsx watch`
  # is a supervisor that relaunches src/index.ts on every crash — including
  # a failed boot — so it never exits on its own and never binds the port a
  # `fuser -k` could find. Match its command line directly; it is the only
  # thing in this repo ever run with this exact argv tail.
  pkill -f "watch src/index.ts" 2>/dev/null || true
  pkill -P "$PROXY_PID" 2>/dev/null || true
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
fi

echo "==========================="
echo "-- summary --"
for line in "${SUMMARY[@]}"; do
  echo "$line"
done
echo "==========================="
if [ "$fail" -eq 0 ]; then
  echo "VERIFY: PASS"
else
  echo "VERIFY: FAIL"
fi
exit "$fail"
