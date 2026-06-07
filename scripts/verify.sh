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
run "e2e:localnet"     "node scripts/e2e.mjs --network localnet"
echo "==========================="
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; fi
exit "$fail"
