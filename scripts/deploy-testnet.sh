#!/usr/bin/env bash
# Deploy SplitRouter to TestNet and update root .env with APP_ID + APP_ADDRESS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

# Verify PAYER has ALGO before attempting deploy
PAYER_ADDR=$(grep '^PAYER_ADDR=' "$ROOT/.env" | cut -d= -f2)
echo "== Checking PAYER balance =="
BALANCE=$(curl -s "https://testnet-api.algonode.cloud/v2/accounts/${PAYER_ADDR}" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log(j.amount ?? 0)")
echo "PAYER balance: $((BALANCE / 1000000)) ALGO ($BALANCE µALGO)"
if [ "$BALANCE" -lt 3500000 ]; then
  echo "ERROR: PAYER needs at least 3.5 ALGO to deploy. Current: ${BALANCE} µALGO"
  echo "Fund via: https://bank.testnet.algorand.network/"
  exit 1
fi

echo "== Opting PAYER into USDC (ASA 10458941) =="
node "$ROOT/scripts/optin-usdc.mjs"

echo "== Deploying SplitRouter to TestNet =="
cd "$ROOT/contracts"
OUTPUT=$(pnpm deploy:ci 2>&1)
echo "$OUTPUT"

# Extract APP_ID and APP_ADDRESS from output
APP_ID=$(echo "$OUTPUT" | grep '^APP_ID=' | tail -1 | cut -d= -f2)
APP_ADDR=$(echo "$OUTPUT" | grep '^APP_ADDRESS=' | tail -1 | cut -d= -f2)

if [ -z "$APP_ID" ] || [ -z "$APP_ADDR" ]; then
  echo "ERROR: Could not parse APP_ID/APP_ADDRESS from deploy output"
  exit 1
fi

echo ""
echo "== Updating root .env =="
cd "$ROOT"
# Update or append SPLIT_APP_ID
if grep -q '^SPLIT_APP_ID=' .env; then
  sed -i '' "s/^SPLIT_APP_ID=.*/SPLIT_APP_ID=${APP_ID}/" .env
else
  echo "SPLIT_APP_ID=${APP_ID}" >> .env
fi
# Update or append SPLIT_APP_ADDRESS
if grep -q '^SPLIT_APP_ADDRESS=' .env; then
  sed -i '' "s/^SPLIT_APP_ADDRESS=.*/SPLIT_APP_ADDRESS=${APP_ADDR}/" .env
else
  echo "SPLIT_APP_ADDRESS=${APP_ADDR}" >> .env
fi

echo "SPLIT_APP_ID=${APP_ID}"
echo "SPLIT_APP_ADDRESS=${APP_ADDR}"
echo ""
echo "Deploy complete. Root .env updated."
