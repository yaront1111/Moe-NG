# task-1615065497f0489097a4bbc11cea9d6b — atomic pristine recovery-binding install

## STATUS: DONE. QA-approved 2026-08-14 after reopen #1 (qa-50f0d628).

## What shipped
`SqliteEventStore.installInitialRecoveryBinding(input)` — genesis install, separate from
`installRecoveryBinding`'s DELETE-then-INSERT replacement (untouched). Chain
`DecisionLedgerStore extends RecoveryInitialInstallStore extends RecoveryInstallStore`,
published in all FOUR places (class, DecisionLedgerCore interface, frozen delegate, facade).
Guard order pinned by a precedence test:
SCOPE -> codec -> slot -> [BEGIN IMMEDIATE] -> PENDING -> HISTORY -> ACTIVE(CURRENT) -> INSERT alone.
Own closed 4-code registry `RECOVERY_INITIAL_INSTALL_REASON_CODES`, DISJOINT from
`RECOVERY_INSTALL_REASON_CODES` (whose `reasonCodeCount: 8` entrypoint pin must stay 8) and
reusing the existing TWO layers (recovery-install.test.ts pins exactly two).

## Consumer edge
task-e19074f841f9450296799abfba9bfcaa (genesis binding in createStoreDependencies) is the
named consumer. This is a store primitive; no cross-package manifest edge involved.

## Round-1 rejection and its fix (the reusable lesson)
DoD 3 enumerated FIVE conditions; four had exact code+layer tests, the fifth
("unprovable transaction outcome") had none. Drill D5 — moving `commitAttempted = true`
from before to after `this.database.exec("COMMIT")` — left all 468 tests green.
Real defect it hid: a COMMIT that lands durably but throws on acknowledgement reaches
`releaseInstallTransaction` with commitAttempted=false, `isTransaction` already false, so it
returns null and the caller surfaces `normalizeOperationalError` = ordinary STORE_UNAVAILABLE
on an UNPOISONED handle instead of DurableStoreError OUTCOME_UNKNOWN.

Fix landed at recovery-initial-install.test.ts:443, harness copied from
store-commit-ambiguity.test.ts:104-133: patch `DatabaseSync.prototype.exec` to run the REAL
COMMIT then throw once. Asserts (1) code exactly `OUTCOME_UNKNOWN`, never a returned refusal;
(2) handle POISONED — `STORE_UNAVAILABLE` **plus message containing "quarantined"**, because
store-runtime.ts:233 is the poisoned branch and :238 is plain `STORE_CLOSED`; only the message
separates quarantine from close; (3) reopen reads ACTIVE FOUND with REF_X — the row DID land,
which is exactly why the outcome is unprovable rather than failed.
Prototype restore + `store.close()` share ONE finally: on the SUCCESS path `poison()` already
closed the database, so the handle leak appears only on the FAILING path, where the Windows
afterEach rmSync EPERM would kill the worker and hide which assertion failed.

## QA verification record (round 2)
- Gate re-run in foreground: typecheck + test exit 0, 41 files / **469** tests (round-1 baseline
  468; delta is exactly the one new case — nothing silently disappeared).
- D5 re-run by QA: RED on `expected 'STORE_UNAVAILABLE' to be 'OUTCOME_UNKNOWN'`,
  1 failed | 15 passed, naming the new case. Restored by reverse Edit; sha256 back to
  `cf3b7574cb99e5ea`; `git status -- packages/store/` empty. Never git checkout.
- Production bytes IDENTICAL to round 1 (`recovery-initial-install.ts` sha cf3b7574cb99e5ea),
  so D1-D4 (replacement drill, PENDING guard, history guard, rowMatchesBinding) stay proven.
- Committed bytes == gated bytes on all 10 owned paths (`git show HEAD:<path>` sha match).
  Retry commit a509233 is test-only; the original +51 lines were swept into FOREIGN whole-tree
  commit c576110 — known hook hazard, correctly not amended/reset.
- Sizes `grep -c ''`: initial-install 177, contracts 102, recovery-install 191,
  decision-ledger 149, sqlite-event-store 368, index 117.

See `mem:gotcha-fail-closed-flag-inside-try-is-untested-by-default`,
`mem:gotcha-store-history-tables-are-not-independently-seedable`.
