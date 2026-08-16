# Handoff — task-16d5bc3a (effect-binding lookup was O(total project events))

## Status
DONE -> REVIEW. Commits `1ba0ce1` (production) and `381c025` (test watchdog).
Step-2 test bytes are in FOREIGN commit `1733d72` (see gotchas below).
Review surface: `git diff cf272f67..HEAD -- apps/daemon/src/activation/`.

## Decision taken (DoD 1)
Option **(c) indexed store query**. Owner of the surface is
`SqliteEventStore.readEventsByTypeAfter` (landed by task-69c2c9e7 over
task-d20ffd07's `(event_type, global_position)` index). NOT (a) schema change to
`CoordinationEffectQuery`, NOT (b) a daemon side table — so task rail 3's
"decide the owner of a side table" question never arises.

## What changed in the daemon
`apps/daemon/src/activation/activation-ledger-reader.ts`:
- `FoundationBindingStore` port: `readEventsAfter` **retired**,
  `readEventsByTypeAfter(eventType, afterGlobalPosition, limit?)` added.
  `maxDecodedBytes` deliberately omitted (the retired sibling omitted it too).
- `scanForEffect` pages the type-filtered stream. 6,501 events read per lookup
  before, **1** after, against a literal bound of 8.

### The real content: the completeness proof was REPLACED and is WEAKER
Old proof = POSITIONAL CONTIGUITY (`position = cursor + 1` per item), which was
self-verifying: it proved the scan saw everything WITHOUT trusting the store.
Under a type filter matches are sparse by construction, so contiguity is false
on every healthy ledger. The new proof rests on the pager's `hasMore`/
`nextCursor` contract — it **trusts** the store. That trade is written into the
module comment in the slot the contiguity paragraph occupied, and names its pin:
`packages/store/src/event-read-model-contract.test.ts` > "pages only exact
event-type matches across an interleaved ledger".

Four replacement guards (all drilled, all load-bearing):
1. strict increase (`event.globalPosition <= position` -> SCAN_INCOMPLETE)
2. filter honesty (event type re-checked even though the store filters)
3. cursor names the LAST RETURNED position (not `cursor + items.length`)
4. an empty page may not claim `hasMore`

### Deliberate semantic change, plan-authorised
`hasMore === true` AT the captured horizon is **no longer** SCAN_INCOMPLETE.
Under a filtered pager `hasMore` is computed over matches, so a true `hasMore`
at H is ordinary concurrent growth; refusing on it would rebuild the
permanent-refusal cliff at the horizon that this task removed at the page cap.
`"bounds a continuously advancing scan to the captured horizon"` now expects
ABSENT/FOUNDATION_BINDING_NOT_FOUND with `pageReads: 3`.

### File split (400-line rail)
Reader hit 407. Leaf predicates (`TRANSITION_ORDER`, `isQueryText`, `sameLease`,
`tracedProject`, `bindsActivation`, `MAX_QUERY_CHARS`, `LEASE_FIELDS`) moved to
`foundation-binding-predicates.ts` (62 lines) + one-line LF `.js` bridge.
Reader = 371. Splitting `scanForEffect` instead would CYCLE, because
`readActivationLedgerRecord` is called by both the scan and the history fold.

## Gates
- `pnpm --filter @moe/daemon typecheck` EXIT=0
- `pnpm --filter @moe/daemon test` EXIT=0, "Test Files 100 passed (100)" /
  "Tests 2071 passed (2071)"
- `pnpm --filter @moe/store test` EXIT=1 — FOREIGN, same case as merge-base:
  `recovery-anchor.test.ts > "publishes exactly the anchor surface a restore
  controller composes"`, "RECOVERY_ANCHOR_FAULT_POINTS leaked onto the root".
- task-69's contract suite verified undisturbed by positive control: 38/38.
- Step-1's recorded foreign daemon typecheck red (orchestrator agent-spawn
  slice) had CLEARED by HEAD f91f2c8 — do not re-disclose it as current.

## Mutation drills (6, each alone, each reverted)
1. early return on first hit -> ambiguity case reds on fake AND real store
2. terminate on short page instead of `hasMore` -> `pageReads` 1 vs 3
3. drop strict increase -> "position repeated inside one page" reds
   (NOTE: the "goes backwards" sibling stays green — the cursor guard answers it)
4. drop horizon bound -> "ignores an activation past the captured horizon" reds
5. revert port to `readEventsAfter` (3 edits incl. restoring the `continue`
   discard, else it reds for the wrong reason) -> both cost assertions report
   "expected 6501 to be less than or equal to 8"
6. (added by me) empty page may claim more -> two SCAN_INCOMPLETE cases red

See `gotcha-store-focused-vitest-needs-root-two-up`,
`gotcha-git-checkout-drill-restore-needs-a-commit-first`,
`gotcha-worker-watchdog-times-out-under-suite-contention`.
