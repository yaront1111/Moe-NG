# task-d92b1b15 — Activation ledger: replay and effect scan fail closed at scale (DONE)

Implemented by worker-247da23f. Commit **2e688c9**, branch `moe/work-2026-08-08`, 4 files, +346/-6.
Both defects fixed, 5 mutation drills passed, owned-scope gate exit 0.

## The two fixes, both one-liners in production

**Defect 1** — `answerReplayed` (activation-ledger-commit.ts) fed `store.readEvents(aggregateId)`
— every event on the aggregate — to `readActivationLedgerRecord`, whose count guard refuses >1.
Fixed by filtering to `event.eventType === ACTIVATION_LEDGER_EVENT_TYPE` **at the call site**.

> **The filter must NOT go inside the reader.** I tried reasoning it through and the reader's own
> test table forbids it: `activation-ledger-reader.test.ts` pins a lone wrong-typed singleton to
> `ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED`. Filtering inside narrows that singleton to zero events
> and silently answers ABSENT instead — reddening an existing test and destroying discrimination for
> the reader's two other callers (`readFoundationActivationHistory`, `scanForEffect`), both of which
> already pass a correct singleton. Only `answerReplayed` was over-supplying.

**Defect 2** — `scanForEffect` (activation-ledger-reader.ts) was bounded by `MAX_SCAN_PAGES = 64`
× `SCAN_PAGE_SIZE = 100`, a ceiling on TOTAL project events past which every effect lookup refused
SCAN_INCOMPLETE forever. Removed the constant entirely and made the loop `for (;;)`.
See `mem:gotcha-a-page-cap-is-not-a-termination-guarantee`.

## Two things this task deliberately did NOT do

1. **Defect 1 is LATENT, not live.** `createFoundationClaudeLauncher`
   (foundation-launch-authority.ts:290) still has ZERO callers anywhere including tests, and the
   authority is not exported from the daemon root. Confirmed again on current bytes. The fix is
   **preventive**, not incident-driven, and the test had to CONSTRUCT the aggregate tail directly —
   one that waited for a live Foundation path would have passed vacuously.
2. **The performance cliff is filed, not solved** (task rail 4). Even fixed, `scanForEffect` is
   O(total project events) *per lookup*: it reads the global stream from cursor 0n and cannot exit
   early because it owes "exactly one matched", not "one matched".
   **Follow-up task id: `task-16d5bc3a10864351adf5be10dfa7df00`** — names the three candidate
   answers (carry the idempotency key on `CoordinationEffectQuery`; a durable per-effect index;
   an indexed store query) and notes the index option collides with this task's rail-1 ban on
   ledger-owned side tables, so ownership must be decided first.

## Test placement deviation (deliberate, QA please read)

The plan put Tests C and D in `activation-ledger-reader.test.ts`. I put them in
`foundation-launch-authority.test.ts`'s existing `describe("current effect/session binding")`.
Forcing reason: `readCurrentEffectSessionBinding` calls `validateActivationCommit` and demands
COHERENT, so a BOUND assertion needs a record produced by `activateEffect`. The hand-written
`activation-ledger-fixtures.ts` `record()` cannot be COHERENT (its grantId does not derive from its
digest), so reader.test.ts would have needed a ~90-line copy of the coherent fixture — exactly the
drift the fixtures file's own header warns against. That describe block already owns every other
`readCurrentEffectSessionBinding` case.

## What pins what (each drill reddens a DIFFERENT named test)

| Drill | Mutation | Reddens |
|---|---|---|
| D1 | whole-aggregate read restored | "replays the DURABLE record on an aggregate that also carries its Foundation tail" + "refuses a drifted candidate on a tailed aggregate" |
| D2 | `events.length > 1` guard removed | "still refuses an aggregate carrying TWO activation events as AMBIGUOUS" |
| D3 | 64-page bound reinstated | "answers BOUND on a store holding more than 6,400 global events" (AssertionError in 318ms — a refusal, **not** a timeout) |
| D4 | early return on first match | "still refuses a SECOND matching activation found past the old 6,400 ceiling" (`expected 'BOUND'`) |
| D5 | `SCAN_PAGE_SIZE` 100→50 | nothing — coverage did not shrink, which is the point |

D1 and D2 redden **disjoint** sets, so the fix and the exactly-one invariant are separately pinned.

## Gate state at completion — foreign red, disclosed

Owned-scope gate exit 0: typecheck 0, `Test Files 6 passed (6), Tests 87 passed (87)`.

Repo-wide legs are RED for foreign reasons, all measured not assumed:
- `typecheck` exit 1 — exactly 3 × `TS2339 Property 'toHaveSize' does not exist` in
  `src/activation/activation-ledger-aggregate-id.test.ts`, an **untracked file another agent created
  at 01:14 mid-session** (`git cat-file -e HEAD:...` → "exists on disk, but not in HEAD"). Excluding
  only that file, tsc exits 0.
- `test` exit 1 — 9 failed / 1930 passed. Path-attributed baseline: reverted my 4 files to pre-diff
  content, ran the 6 failing files (BASELINE = 5 files), restored byte-exact, re-ran the identical
  subset (HEAD = 3 files). **HEAD ⊂ BASELINE, so the new-failure delta is empty.** Two files failed
  *without* my diff and passed *with* it — causally impossible, confirming the flake class.
  4 of the 9 are literal `Test timed out in 5000ms`. `runtime-entrypoint`'s bridge guard reports
  `missing: orchestrator/verifier-process-runner.ts`, another agent's module added at 00:36 without
  its `.js` bridge.

Also foreign and deliberately NOT staged: `activation-ingress.test.ts` (foreign 3+/3− edit).

## Residual I disclosed rather than hid

Removing the page cap means a store that reports `hasMore: true` forever *with strictly-advancing
cursors* would spin rather than refuse after 64 pages. Every realistic fault is still caught on the
FIRST bad page by the empty-page and non-advancing-cursor guards (both pinned by the pre-existing
`stuck`/`stalled` fakes, still green). For any finite table with a monotonic cursor — i.e. SQLite,
the only implementation — termination is guaranteed, since each iteration consumes a distinct global
position. A store that could lie that way could equally forge bytes, so the cap was never that
defence.
