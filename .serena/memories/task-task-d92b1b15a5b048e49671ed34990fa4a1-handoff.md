# task-d92b1b15 — Activation ledger: replay and effect scan fail closed at scale (PLAN)

Planned by architect-7f301fa7 at HEAD 9d60091. 7 steps, 5 files, no size warning. Both defects
confirmed on current bytes.

## Defect 1 — replay feeds a whole aggregate to an exactly-one reader (LATENT)

`answerReplayed` (activation-ledger-commit.ts:133-157) does `store.readEvents(aggregateId)` at :140
— EVERY event on the aggregate — then hands it to `readActivationLedgerRecord` at :144, whose guard
at reader.ts:61 is `if (events.length > 1) return ...EVIDENCE_AMBIGUOUS`. Any second event on the
aggregate breaks idempotent re-commit.

**The fix is to narrow the input, not weaken the guard.** The reader already checks the
discriminator `ACTIVATION_LEDGER_EVENT_TYPE` at :65 — one line *after* the count guard. Filter by it
first: zero activation events → ABSENT, two → AMBIGUOUS (unchanged), one + any foreign events → the
record. Relaxing `length > 1` to "take the first" passes the repro test and destroys the guarantee.

**LATENT, not live** (author's correction, comment-76869409): `createFoundationClaudeLauncher`
(foundation-launch-authority.ts:290) has ZERO callers anywhere including tests, and the authority is
not exported from the daemon root. So the test must CONSTRUCT the multi-event aggregate directly —
one that waits for a live Foundation path passes vacuously.

## Defect 2 — effect scan dies permanently past 6,400 events (LIVE)

`scanForEffect` (reader.ts:232-262), bounded by `MAX_SCAN_PAGES = 64, SCAN_PAGE_SIZE = 100` (:107).
It reads the GLOBAL stream from cursor `0n` and **cannot exit early on a hit** because it must prove
uniqueness — its only success exit is `if (!read.hasMore)` at :255. Past 6,400 global events the
loop finishes with `hasMore` still true, falls through to `return no("FOUNDATION_BINDING_SCAN_INCOMPLETE")`
at :261, and `readCurrentEffectSessionBinding` stops finding ANY activation, permanently.

**THE KEY FINDING: the page cap is not a safety device.** The loop already terminates without it —
an empty page with `hasMore` returns SCAN_INCOMPLETE (:242), and a cursor that does not strictly
advance returns SCAN_INCOMPLETE (:258-259). A stalled or lying store is caught by those guards. So
`MAX_SCAN_PAGES` adds no protection a correct store needs; it only imposes a false ceiling. Remove
the page bound, keep `SCAN_PAGE_SIZE`, and let the cursor-advance guard own termination.
See `mem:gotcha-a-page-cap-is-not-a-termination-guarantee`.

**Raise, do not solve, the design question** (task rail 4): even fixed, the scan is O(total project
events) per lookup. File a follow-up for a per-effect index or per-aggregate query and record its id.
Landing an index unannounced is forbidden.

## Test traps

- DoD 3's count must be a **literal**, never `MAX_SCAN_PAGES * SCAN_PAGE_SIZE` — a count derived
  from the constants it pins moves with them (equivalent-mutant trap).
- Real **file-backed** SqliteEventStore, opened in the test and closed in a `finally`; a held handle
  kills the vitest worker. Insert the 6,400+ events in ONE transaction or the test reads as a hang.
- DoD 4: a second matching activation past the old bound must still refuse
  FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS — that is what stops the fix buying scale by returning on
  first match.
- Preserve the digest cross-check at commit.ts:150 (ACTIVATION_LEDGER_REPLAY_DIVERGED); it is what
  stops a replay echoing the caller.
- `activation-ledger-reader.ts` is already 328 lines (over the 250 target, under 400, pre-existing).
  Do not push it toward 400 — extract a helper module instead.
