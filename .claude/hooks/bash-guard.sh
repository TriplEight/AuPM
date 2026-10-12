#!/usr/bin/env bash
# PreToolUse hook on Bash. Exit 2 blocks the command and sends the reason to the agent.
# Blocks: a command that prints a *_MNEMONIC value, and a git push to master.
set -euo pipefail


input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
[[ -n "$cmd" ]] || exit 0

block() {
  printf 'Blocked by .claude/hooks/bash-guard.sh: %s\n' "$1" >&2
  exit 2
}

mnemonic_expansion='\$\{?[A-Za-z0-9_]*_MNEMONIC'
mnemonic_env_dump='\b(printenv|env|set|export)\b[^;&]*MNEMONIC'
mnemonic_env_file='\.env\b([^.]|$)[^;&]*MNEMONIC|MNEMONIC[^;&]*\.env\b([^.]|$)'
if [[ "$cmd" =~ $mnemonic_expansion || "$cmd" =~ $mnemonic_env_dump ||
  "$cmd" =~ $mnemonic_env_file ]]; then
  block 'the command can print a *_MNEMONIC value. Never print a mnemonic.'
fi

git_push='\bgit\b[^;&|]*\bpush\b'
if [[ "$cmd" =~ $git_push ]]; then
  push_to_master='\bpush\b[^;&|]*[[:space:]:+](master|main)\b'
  if [[ "$cmd" =~ $push_to_master ]]; then
    block 'git push to master. Push a feature branch and open a PR.'
  fi
  # The repo that pushes: `git -C <dir>` in the command, else the cwd of the tool call.
  push_dir=$(jq -r '.cwd // empty' <<<"$input")
  git_dir_flag='\bgit[[:space:]]+-C[[:space:]]+("([^"]+)"|([^[:space:]]+))'
  if [[ "$cmd" =~ $git_dir_flag ]]; then
    push_dir="${BASH_REMATCH[2]:-${BASH_REMATCH[3]}}"
    push_dir="${push_dir/#\~/$HOME}"
  fi
  current=$(git -C "${push_dir:-$CLAUDE_PROJECT_DIR}" branch --show-current 2>/dev/null || true)
  if [[ "$current" == master || "$current" == main ]]; then
    block "git push while on $current. Push a feature branch and open a PR."
  fi
fi
