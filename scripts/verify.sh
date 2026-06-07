#!/usr/bin/env bash
# SPM verification harness. Exit 0 only if every check passes. The G4 /goal gate.
# Loops should run this against LocalNet. Prints PASS/FAIL per check.
set -uo pipefail
fail=0
run() { # name | command
  printf '%-26s ' "$1"
  if eval "$2" >"/tmp/spm_verify_${1// /_}.log" 2>&1; then echo PASS; else echo "FAIL  (see /tmp/spm_verify_${1// /_}.log)"; fail=1; fi
}
echo "== SPM verify (LocalNet) =="

run "typecheck"        "npm run -s typecheck"
run "unit+integration" "npm test --silent"

# Start proxy in background for e2e (fresh DB each run)
export SQLITE_PATH=/tmp/spm_e2e_$(date +%s).db
pnpm --dir "$(dirname "$0")/../proxy" dev >/tmp/spm_proxy_verify.log 2>&1 &
PROXY_PID=$!
# Wait for proxy to be ready (up to 10s)
for i in $(seq 1 20); do
  if curl -sf http://localhost:4873/api/v1/status/ping/1.0.0 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

run "e2e:localnet"     "SQLITE_PATH=$SQLITE_PATH node scripts/e2e.mjs --network localnet"

kill "$PROXY_PID" 2>/dev/null || true
echo "==========================="
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; fi
exit "$fail"
