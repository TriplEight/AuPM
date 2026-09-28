# The proxy process schedules the nightly job

A host timer unit ran `nightly-main.ts` outside the `aupm` container. It needed its own unit
files, its own host user, and its own install step, and it left the running server with no way
to report the job's own health. The MVP runs one proxy process with one writer (ADR 0001); that
process can schedule its own daily job just as well as a host timer can, with one fewer moving
part to install and monitor.

The proxy process now runs the job in-process, daily at 03:17 UTC, and once at start when the
last successful run is more than 24 hours old or none exists. `AUPM_NIGHTLY=off` disables the
schedule; any other value refuses to boot. A SQLite lease (`nightly_lease`) stops two runs from
overlapping — the in-process scheduler and `nightly-main.ts`, the operator's manual entry point,
both take it before a run and release it after. A lease older than one hour counts as released,
so a crashed run does not block every later one forever. SQLite also records each run's start,
end, result, error, batch, and credit txid (`nightly_runs`). `GET /api/v1/health` reports the
last run and the last success, free and unauthenticated, and answers 503 once the last success
is more than 26 hours old.

## Consequences

- The host timer unit files are deleted. No host unit to install, edit, or enable.
- A redeploy of the `aupm` container carries the schedule with it — no separate step.
- A failed run logs `aupm-nightly: failed — <reason>` and never stops the server; an operator (or
  monitoring) reads the failure from `GET /api/v1/health` or the log line, not from a lost
  process.
- `nightly-main.ts` still exists, for a one-off, by-hand pass — for example right after a
  deploy — and now takes the same lease, so it never races the in-process scheduler.
- The in-process scheduler needs a clean SIGTERM/SIGINT path (item F4, `proxy/src/shutdown.ts`):
  a redeploy stops the scheduler and the server, gives an in-flight run up to 8 s to
  finish, and closes SQLite only when it did. A run still busy at that deadline is left alone —
  the process exits non-zero instead, and the 1-hour `nightly_lease` staleness rule reclaims it.
