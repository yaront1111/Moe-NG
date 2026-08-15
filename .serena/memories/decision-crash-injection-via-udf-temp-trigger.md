# Decision: statement-precise crash injection via a `node:sqlite` UDF in a TEMP trigger

Chosen 2026-08-08 while planning `task-791d73407af64b179f6099810d940758` (projection crash
and rebuild hardening). Probed and confirmed on Node **v24.16.0**.

## Why not the technique already in the repo

`task-071173ab` injects faults with a second connection creating
`CREATE TRIGGER ... BEGIN SELECT RAISE(ABORT, ...); END`. That proves the **rollback path**.
It cannot prove crash-safety: the process stays alive and the store's own error handling
runs. Only process death leaves the WAL to recover, which is what "no partial state after a
crash" actually means.

## The technique

```js
// inside the child process, after opening the store
let connection;                       // the STORE'S own DatabaseSync
store.commitWithApply(throwawayInput, (context) => { connection = context.database; });
connection.function("moe_crash_now", () => {
  writeSync(1, `BOUNDARY:${name}\n`); // flush BEFORE dying or the marker is lost
  process.kill(process.pid, "SIGKILL");
});
connection.exec(
  "CREATE TEMP TRIGGER moe_crash BEFORE INSERT ON inbox_receipts BEGIN SELECT moe_crash_now(); END"
);
```

`CommitApplyContext.database` (`event-ledger-transaction.ts:30`) is the only public route to
the store's own connection.

## Four things that make it fail if you get them wrong

1. **The trigger must be TEMP.** UDFs are per-connection. A permanent trigger created from a
   second connection raises `no such function` on the store's connection, so the operation
   merely *refuses* instead of crashing — a green test that proved nothing.
2. **`PRAGMA trusted_schema = OFF` does not block it.** This store sets that pragma
   (`sqlite-event-store.ts:178`); the probe confirmed a UDF still fires from a TEMP trigger
   under it. Do not conclude it is impossible without probing.
3. **Flush the marker with `writeSync(1, ...)`.** Normal stdout is buffered and SIGKILL runs
   no exit handlers, so `console.log` loses the evidence that the boundary was reached.
4. **Never assert the signal name.** A SIGKILL child reports exit code `1` / signal `null` on
   Windows and code `null` / signal `SIGKILL` on POSIX. Assert `exitCode !== 0` **and** the
   boundary marker — the marker is what distinguishes "the crash worked" from "the child
   died for an unrelated reason" or "the boundary was never reached".

## What the drill must assert afterwards

Reopen and prove all-or-nothing: `PRAGMA integrity_check === "ok"`, `PRAGMA foreign_key_check`
zero rows, the store reopens (which re-runs `validateSchema`), and the durable state
reconciles as a **whole-prefix fold of the ledger** — no half-applied event, no inbox receipt
without its projection advance. Close every connection before
`rmSync(dir, {force:true, maxRetries:10, recursive:true, retryDelay:50})` or Windows throws
EBUSY (`mem:gotcha-testkit-temp-fixture-leak-ebusy`).

Related: `mem:task-task-071173ab5b93428b9ca0acf5c65a50e1-handoff` (the RAISE(ABORT) technique
this supersedes for crash, and still complements for rollback).
