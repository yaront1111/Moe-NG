# Handoff: Projection commit seam (Task B2, task-bfc39542) — DONE, in REVIEW

`SqliteEventStore.commitWithApply(input, apply)` runs a caller-supplied apply inside the
same BEGIN IMMEDIATE transaction as the event append.

## Where the code is (READ THIS BEFORE REVIEWING)
The change is split across TWO commits because a sibling swept it:
- `a81aedd feat(task-5a9535485...): Graph revision reducer decomposition` — swept in ALL
  FIVE of my store paths under a foreign message.
- `a45b161 feat(task-bfc39542...)` — my own commit, post-sweep delta only (the two
  adversarial hardening fixes).
Review the seam as the UNION of both over: store-contracts.ts, decision-ledger.ts,
sqlite-event-store.ts, event-ledger-transaction.ts, store-projection-seam.test.ts.
See `mem:gotcha-shared-tree-broad-add-sweep`.

## Shape as landed
- `event-ledger-transaction.ts` (148 lines): exported `CommitApplyContext { database, summary }`
  and `CommitApply`. Old `commit()` body moved verbatim into
  `private runCommandTransaction(rawInput, apply: CommitApply | null)`; `commit()` passes null,
  `commitWithApply()` passes the callback. `resolveCommand` gained a 3rd param and invokes
  `applyWithinCommit` on the COMMITTED branch only, after writeCommitEffects, before the
  shared COMMIT. Replay and every conflict path therefore skip the seam for free.
- summary = `toCommitResult(stored, "COMMITTED")` — the PUBLIC CommitResult, chosen over
  internal StoredCommitResult so no internal type leaks through a public signature. No
  positions either way; the callback SELECTs `global_position` by `command_id` in-transaction.
- `writeCommitEffects` and `StoredCommitResult`: untouched, as required.
- `store-contracts.ts`: exactly one line, `| "PROJECTION_APPLY_FAILED"` between
  OUTCOME_UNKNOWN and PROJECT_SCOPE_MISMATCH.
- Verification: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test`
  -> exit 0, 22 files / 146 tests, three identical runs.

## PLAN PREMISE THAT WAS WRONG (cost a 5th file)
The task description asserted "a new inherited method needs NO decision-ledger.ts edit".
FALSE. `DecisionLedgerCore` is an explicit interface (decision-ledger.ts:36-71) implemented
as a frozen OBJECT LITERAL of arrow delegates (:87-128), not by the class. Inheritance does
not reach `SqliteEventStore.#core`. Any new method on the EventTransactionStore chain needs
two hunks there: one interface member + one delegate entry. See
`mem:gotcha-decision-ledger-core-is-an-object-facade`.

## Two defects my own adversarial review caught (both now tested)
1. An `async` apply typechecks against `=> void` and would have been fired-and-forgotten
   before COMMIT — success returned with the projection work unfinished. Now `isThenable`
   on the return value throws PROJECTION_APPLY_FAILED.
2. `String(error)` THROWS for a Symbol or null-prototype throw value; that TypeError escaped
   the catch and got renamed STORE_UNAVAILABLE by normalizeOperationalError — the trap the
   task warned about, reintroduced via the formatter. Now a total `describeApplyFailure`.
See `mem:gotcha-void-callback-swallows-async-in-a-transaction`.

## Left for downstream
The FOLD is not here by design (seam-not-feature rail): no projection engine, relay,
subscription, or upcaster. The consumer writes its own rows through `context.database`.
An apply that runs its own COMMIT/ROLLBACK already fails closed (outer COMMIT throws with
commitAttempted=true -> poison + OUTCOME_UNKNOWN); documented as contract, not policed.
