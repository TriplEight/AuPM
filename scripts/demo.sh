#!/usr/bin/env bash
# The single operator entry point for a real, on-chain e2e run: starts a
# real proxy and runs scripts/e2e.mjs against it, printing every Lora URL.
# The G5 demo gate. NETWORK defaults to testnet — the live rehearsal
# network (CLAUDE.md: "TestNet is for pre-flight rehearsal only").
#
# WARNING: this script needs a real, funded AUPM_DONOR_MNEMONIC and a real
# payTo (PAY_TO_ADDRESS) in .env. It never invents throwaway credentials the
# way scripts/verify.sh does for its rehearsal run — a demo with a fake
# wallet proves nothing on stage.
#
# scripts/e2e.mjs's 250-package on-chain PaymentRouter credit/claim
# rehearsal (R3a, TestNet only, hermetic) needs DEPLOYER_MNEMONIC and
# CREDITER_MNEMONIC in addition to the variables required below — see
# .env.example. This script never forces those: e2e.mjs SKIPs that one
# step, by name, when any of them is absent.
#
# NETWORK resolution order (read once, before the banner prints):
#   1. An explicit NETWORK already set in the operator's shell environment
#      wins. `NETWORK=testnet ./scripts/demo.sh` always gets TestNet, even
#      if .env says mainnet — an explicit override is the least surprising
#      rule and lets an operator force the safe network on the command line.
#   2. Otherwise, NETWORK from .env is used.
#   3. Otherwise, default to testnet.
# The banner is printed only after this value is final, so it never
# announces a network the script does not actually use.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Capture any operator-supplied NETWORK before .env can overwrite it.
NETWORK_FROM_SHELL="${NETWORK:-}"

# Load root .env so AUPM_DONOR_MNEMONIC, PAY_TO_ADDRESS, ATTEST_SIGNING_KEY
# etc. are in scope.
if [ -f "$ROOT/.env" ]; then
  set -o allexport
  # shellcheck source=/dev/null
  source "$ROOT/.env"
  set +o allexport
fi

# Resolve the final NETWORK value: explicit shell env wins over .env, which
# wins over the testnet default. This is the one value used for the rest of
# the script and the one printed in the banner below.
if [ -n "$NETWORK_FROM_SHELL" ]; then
  NETWORK="$NETWORK_FROM_SHELL"
else
  NETWORK="${NETWORK:-testnet}"
fi
export NETWORK
echo "== AuPM demo ($NETWORK) =="

if [ "$NETWORK" = "mainnet" ]; then
  echo "WARNING: NETWORK=mainnet. Step 8 makes a real USDC payment on Algorand MainNet."
  if [ "${AUPM_DEMO_CONFIRM_MAINNET:-}" != "yes" ]; then
    read -r -p "Type 'yes' to confirm and spend real funds on MainNet: " confirm_mainnet
    if [ "$confirm_mainnet" != "yes" ]; then
      echo "Aborted: MainNet confirmation not given."
      exit 1
    fi
  fi
fi

# Required for every check below to run for real, not SKIP. AUPM_ISSUER_URL
# and AUPM_KEY_VALID_FROM (Q13) are public config, not secrets, but the
# server refuses to boot without them on every network — this script never
# invents throwaway values for them the way scripts/verify.sh does, so a
# missing one here is a real .env gap, not something to paper over.
missing=""
for var in PAY_TO_ADDRESS AUPM_DONOR_MNEMONIC ATTEST_SIGNING_KEY \
  AUPM_ISSUER_URL AUPM_KEY_VALID_FROM; do
  if [ -z "${!var:-}" ]; then
    missing="$missing $var"
  fi
done
if [ -n "$missing" ]; then
  echo "ERROR: missing required .env value(s):$missing"
  echo "       Set a funded payTo (PAY_TO_ADDRESS) and ATTEST_SIGNING_KEY."
  exit 1
fi
export PAY_TO_ADDRESS AUPM_DONOR_MNEMONIC ATTEST_SIGNING_KEY \
  AUPM_ISSUER_URL AUPM_KEY_VALID_FROM

# Kill any stale proxy on the configured port before starting ours.
PORT="${PORT:-4873}"
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1

# Start proxy in background with a demo-specific DB.
SQLITE_PATH="/tmp/aupm_demo_$(date +%s).db"
export SQLITE_PATH
export AUPM_PROXY_URL="${AUPM_PROXY_URL:-http://localhost:$PORT}"
pnpm --dir "$ROOT/proxy" start >"$ROOT/proxy/demo.log" 2>&1 &
PROXY_PID=$!
trap 'pkill -P "$PROXY_PID" 2>/dev/null; kill "$PROXY_PID" 2>/dev/null; fuser -k "${PORT}/tcp" 2>/dev/null; echo "Proxy stopped."' EXIT

# Wait for proxy to be ready (up to 15s); fail if our process died.
echo "Starting proxy..."
ready=0
for _ in $(seq 1 30); do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "ERROR: proxy failed to start. Check proxy/demo.log"
    cat "$ROOT/proxy/demo.log" >&2
    exit 1
  fi
  if curl -sf "$AUPM_PROXY_URL/api/v1/status/ping/1.0.0" >/dev/null 2>&1; then
    ready=1
    echo "Proxy ready."
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: proxy did not become ready within 15s. Check proxy/demo.log"
  cat "$ROOT/proxy/demo.log" >&2
  exit 1
fi

# tsx lives in mcp/node_modules — several e2e.mjs checks import TypeScript
# source files directly and need its loader. Required, not optional: a
# plain `node` run cannot resolve those imports, so this script fails loud
# instead of silently skipping real checks.
TSX="$ROOT/mcp/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "ERROR: $TSX not found. Set up dependencies with pnpm first."
  exit 1
fi

if "$TSX" "$ROOT/scripts/e2e.mjs"; then
  echo "DEMO: PASS"
  echo "Open the printed Lora URL(s) on stage."
  exit 0
else
  echo "DEMO: FAIL"
  exit 1
fi
