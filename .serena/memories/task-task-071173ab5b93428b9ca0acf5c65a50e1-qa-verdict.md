# QA verdict: APPROVED — Transactional outbox relay + durable inbox dedupe (SPIDR 3/5)

Verified by qa-f4052923 on 2026-08-08 against commit `2443a6a` (the worker's own
explicit-pathspec commit: 7 files, +959, all under `packages/store/src/outbox-relay/`).

## Gate, re-run by QA, not trusted from the note

`pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` -> exit 0,
**25 files / 201 tests**, run twice (before mutation probes and again after restore).
Matches the worker's claim exactly.

## The four DoD items and what actually proves each

1. **One transaction.** `commitWithApply` -> `withCommandTransaction(resolveCommand)`;
   `writeCommitEffects` (domain_events + outbox_messages) then `applyWithinCommit`
   (projection + inbox), all before the shared COMMIT — `event-ledger-transaction.ts:114-147`.
   Fault matrix injects `RAISE(ABORT)` at all four tables and asserts
   `snapshotDatabase(path) == EMPTY` after each.
2. **Idempotent redelivery, distinguishable.** ALREADY_APPLIED/`deduplicatedBy: INBOX`,
   `commit: null`, zero reducer calls, DB byte-identical to `before`. Separately labelled
   from COMMAND_RECEIPT replay.
3. **Durable across restart.** Store closed, reopened, redelivered with fresh
   command/event/outbox IDs at the bumped `expectedVersion` — still INBOX.
4. **Owned paths only.** `2443a6a` is clean. See contamination note below.

## Three independent mutation probes I ran myself (rail 6)

Backed up out of tree, restored, hash re-verified `95d8def687c3...` after every cycle.
The suite is **not** vacuous:

| Mutation | Result |
|---|---|
| `requireFreshInbox` returns before the digest compare | 3 red: dedupe, INBOX_CONFLICT, **and the restart-durability test** |
| `requireProjectionAt` skips the `state_digest` compare | 1 red: stale-state-digest. Red because it asserts `OUTBOX_RELAY_PROJECTION_CONFLICT` specifically — the fallback path still refuses, but as `PROJECTION_WRITE_FAILED`. **The test bites on the code, not on "did not succeed."** |
| `writeOnce` swallows the SQLite error (`changes = 1`) | 2 red: `projections` and `inbox_receipts` fault cases. Proves the `== EMPTY` atomicity assertions are load-bearing against a partial write, not decoration. |

The second one is the important one: it is exactly the epic-rail-6 defect class
(assert the reason code, not the outcome) and this suite passes it.

## Contamination — do not attribute it to the worker

`0e4903a` carries this task's title but is the **wrapper post-flight `git add -A` sweep**,
landed 12:05:43 +0300 — two minutes after the worker's clean commit, five seconds after
`qa-f4052923 claimed task`, simultaneous with `worker session ended (CLI exit=0)`. It swept
`.moe/` state plus `packages/scheduler/src/budget/budget-settlement.{ts,js,test.ts}`
(task-3602672f's in-flight work). governor-afcd0846 had already declared this an
infrastructure defect that no worker can fix — see `mem:gotcha-shared-tree-foreign-red-and-swept-commits`.
**A QA reviewer must diff the worker's own commit, not `HEAD`.** Rejecting on `HEAD`'s
contents here would have been wrong.

## Noted, deliberately not rejected

`transactional-outbox-relay.ts` is **266 lines** vs the plan step-4 wording "<=250".
Epic rail 5 sets 250 as a *target* and 400 as the split point, so 266 is compliant;
the plan text was stricter than the rail. Not a defect.

Also not required and not present: real two-process concurrency test. BEGIN IMMEDIATE
makes SQLite single-writer, and the projections compare-and-set plus the inbox UNIQUE
cover the interleavings, so the gap is theoretical.
