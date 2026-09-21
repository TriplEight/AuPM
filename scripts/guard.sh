#!/usr/bin/env bash
# scripts/guard.sh
#
# Invariant guard. Greps the TRACKED source tree for patterns that have
# already caused, or nearly caused, a real defect in this project.
# Scans only files known to git (via `git ls-files`), so node_modules and
# other untracked/ignored paths are never touched.
#
# Prints one line per violation as "RULE <n>: <file>:<line>: <text>" and
# exits 1 when any rule fires. Exits 0 when the tree is clean.
#
# EXCEPTION MARKER
# A line carrying `guard-allow: RULE<n> — <reason>` is exempt from rule
# <n>. The reason is required; a marker with no reason after the dash
# does not count and the violation still fires. This exempts specific,
# deliberate, reviewed lines — never a whole file or a whole rule. Add a
# marker only when you understand exactly why the line is correct as
# written; it documents an exception, it does not mute the rule.

set -u

cd "$(git rev-parse --show-toplevel)" || exit 1

violations=0

# has_marker <rule> <file> <line> — true when that exact line carries a
# guard-allow marker for <rule>, with a non-empty reason.
has_marker() {
  local rule="$1" file="$2" line="$3" text
  text=$(sed -n "${line}p" -- "$file" 2>/dev/null)
  printf '%s' "$text" | grep -qE "guard-allow:[[:space:]]*RULE${rule}\\>[[:space:]]*(—|-)[[:space:]]*[^[:space:]]"
}

report() {
  # report <rule> <file> <line> <text>
  local rule="$1" file="$2" line="$3" text="$4"
  if has_marker "$rule" "$file" "$line"; then
    echo "ALLOW $rule: $file:$line: exempted by guard-allow marker"
    return
  fi
  echo "RULE $rule: $file:$line: $text"
  violations=$((violations + 1))
}

# All tracked files, and tracked files under a set of directories. Both
# helpers read strictly from `git ls-files` — never the raw filesystem —
# so node_modules and other ignored/untracked paths never enter a scan.
all_tracked() {
  git ls-files
}

tracked_under() {
  # tracked_under <dir> [<dir> ...]
  git ls-files -- "$@" 2>/dev/null
}

# ---------------------------------------------------------------------------
# RULE 1 — settle.ts must not exist under proxy/src.
# It performed direct chain submission with no facilitator involved. That
# was an authentication bypass. It is deleted, not fixed.
# ---------------------------------------------------------------------------
while IFS= read -r f; do
  [ -z "$f" ] && continue
  report 1 "$f" 1 "forbidden file: proxy/src/settle.ts must not exist"
done < <(tracked_under proxy/src | grep -E '(^|/)settle\.ts$')

# ---------------------------------------------------------------------------
# RULE 2 — no direct chain submission in proxy/src.
# Settlement goes through the mandatory GoPlausible facilitator only. No
# local facilitator. No direct chain submission.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 2 "$f" "$l" "direct chain submission: $text"
done < <(tracked_under proxy/src | xargs -r grep -nE 'sendRawTransaction|waitForConfirmation' -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 3 — no algosdk.signBytes under proxy/src/attest or cli/src.
# signBytes prepends "MX" for domain separation and breaks standard DSSE
# verifiers. Attestations sign the raw PAE bytes with ed25519 instead.
# A line proving this by deliberately calling signBytes and asserting its
# output differs may carry a guard-allow: RULE3 marker.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 3 "$f" "$l" "forbidden signer: $text"
done < <(tracked_under proxy/src/attest cli/src | xargs -r grep -n 'signBytes' -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 4 — no EURD and no Quantoz under proxy/src, mcp/src, cli/src.
# EURD/Quantoz bridge settlement is out of scope. The facilitator accepts
# only a plain USDC asset-transfer.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 4 "$f" "$l" "out-of-scope settlement path: $text"
done < <(tracked_under proxy/src mcp/src cli/src | xargs -r grep -inE 'eurd|quantoz' -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 5 — no float arithmetic on money under proxy/src, mcp/src.
# Money is always integer micro-units. parseFloat and toFixed both imply a
# floating-point amount.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 5 "$f" "$l" "float arithmetic on money: $text"
done < <(tracked_under proxy/src mcp/src | xargs -r grep -nE 'parseFloat|toFixed' -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 6 — no AI-authorship attribution in tracked files.
# Do not attribute authorship to Claude or any AI in code, comments, docs,
# or commits. This targets ATTRIBUTION, not the bare mention of a tool
# name — "a fresh Claude session" or "install Claude Code" is normal
# project documentation, not an authorship claim. It matches only:
#   - Co-Authored-By: <AI name>
#   - Generated with / Generated by <AI name>
#   - Authored by <AI name>
#   - the robot emoji followed by "Generated"
# Excludes .claude/, CLAUDE.md, AGENTS.md, NOTES.md (project config that
# legitimately names its own tooling) and this script, which would
# otherwise match its own pattern literals.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 6 "$f" "$l" "AI attribution: $text"
done < <(all_tracked | grep -v -E '^\.claude/|^CLAUDE\.md$|^AGENTS\.md$|^NOTES\.md$|^scripts/guard\.sh$' \
  | xargs -r grep -inE '(co-authored-by|generated with|generated by|authored by)[^[:cntrl:]]*(claude|anthropic|copilot)|🤖[^[:cntrl:]]*generated' -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 7 — no committed secret material, outside .env.example.
# Mnemonics are cold or read from an untracked .env at runtime. They never
# appear as a literal value in tracked source or docs. Excludes
# .claude/skills/** (third-party vendor API reference examples) and any
# *.test.* fixture file, since a fixture's job is to hold synthetic
# non-secret data that looks like the real thing.
# ---------------------------------------------------------------------------
rule7_scope() {
  all_tracked | grep -v -E '(^|/)\.env\.example$' | grep -v -E '(^|/)\.claude/skills/' | grep -v -E '\.test\.'
}

# 7a — a bare 25-word mnemonic phrase (Algorand mnemonics are 25 words).
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 7 "$f" "$l" "25-word mnemonic pattern: $text"
done < <(rule7_scope | xargs -r grep -nE '([a-z]+ ){24}[a-z]+' -- 2>/dev/null)

# 7b — a name containing "mnemonic" assigned a literal quoted value (not a
# process.env lookup, not an empty placeholder, not a <...>/${...} stand-in).
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 7 "$f" "$l" "mnemonic assigned a literal value: $text"
done < <(rule7_scope | xargs -r grep -inE "[a-z0-9_]*mnemonic[a-z0-9_]*[[:space:]]*[:=][[:space:]]*[\"'][a-z]+([[:space:]]+[a-z]+)+[\"']" -- 2>/dev/null)

# ---------------------------------------------------------------------------
# RULE 8 — the two other package-manager CLIs stay out of scripts/**,
# .githooks/**, and .github/workflows/** (CLAUDE.md: use pnpm everywhere).
# This scans only the harness and CI surfaces, never README.md or other
# docs — a documented end-user command pointing plain npm's installer at
# the SPM registry there is the product working as intended, not a
# violation here.
#
# Word-boundary matched, so a line naming pnpm's own install/run/test/ci
# verbs never false-positives just because that other CLI's name is a
# substring of "pnpm". scripts/guard.sh itself is excluded so this rule's
# own pattern text is never checked against itself.
# ---------------------------------------------------------------------------
while IFS=: read -r f l text; do
  [ -z "$f" ] && continue
  report 8 "$f" "$l" "forbidden package manager: $text"
done < <(tracked_under scripts .githooks .github/workflows \
  | grep -v -E '^scripts/guard\.sh$' \
  | xargs -r grep -nE '\bnpm[[:space:]]+(run|test|install|ci)\b|\byarn\b' -- 2>/dev/null)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "guard.sh: $violations violation(s) found"
  exit 1
fi

echo "guard.sh: clean"
exit 0
