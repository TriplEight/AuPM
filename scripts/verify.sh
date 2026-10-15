#!/usr/bin/env bash
# AuPM verification harness.
#
# Prints PASS or FAIL for every check. Exits 0 only when nothing FAILs.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

fail=0
declare -a SUMMARY

log_for() {
  echo "${TMPDIR:-/tmp}/aupm_verify_$(echo "$1" | tr -c 'A-Za-z0-9' '_').log"
}

# run <name> <command> — prints PASS or FAIL for one check.
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

echo "== AuPM verify =="

run "prek"              "prek run --all-files"
run "unit:proxy"        "pnpm --dir proxy test"
run "unit:cli"          "pnpm --dir cli test"
run "unit:contracts"    "pnpm --dir contracts test"
run "unit:mcp"          "pnpm --dir mcp test"
run "action:aupm" "node --test .github/actions/aupm/*.test.mjs"
run "unit:scripts"      "node --test scripts/*.test.mjs"

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
