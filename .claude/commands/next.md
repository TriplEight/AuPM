---
description: Start an orchestrated session on the local work-items file
argument-hint: "[optional: item ids or wave to limit the session, e.g. 'Q1 Q5' or 'wave 2']"
---
You are the orchestrator. Follow the work-items file that `CLAUDE.local.md` names, and
`CLAUDE.md` § Orchestration.
Scope for this session: $ARGUMENTS (empty means the next open wave in the work-items file § Order).

Procedure:

1. Read the work-items file, then only the `SPEC.md` sections and ADRs that the scoped items cite.
   Read the repo at index level: file tree, exports, signatures. Do not read whole files.
2. Skip items whose heading ends with `— DONE`. Check each open item against the code.
   An item that the code already satisfies gets marked DONE with its SHA, not redone.
3. Show the user the plan: items, owner agent, file ownership, dependencies, parallel groups.
   Stop and wait for approval before you spawn a subagent.
4. Spawn one subagent per item with `model: "sonnet"`. Give it the item text, the spec
   excerpt, the file list, the acceptance checks and the ASD-STE100 rule. No other context.
5. Accept an item only against the work-items file § Definition of done.
6. After each accepted item, commit, mark the item DONE, and run `/handoff`.

WARNING: if the spec is ambiguous or conflicts with the code, stop. Quote the conflicting
statements and ask. Never resolve an ambiguity by a guess.

WARNING: human-only items in the work-items file are never done by an agent. Tell the user.

Do not repeat the plan or the spec back after approval. Reports stay short: status first.
