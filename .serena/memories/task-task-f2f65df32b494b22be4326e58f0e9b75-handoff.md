# Recovery anchor: the guard was one condition short of its own comment

`settledInstall` (recovery-anchor.ts) recognised only `state === "INSTALLED"`, so a
crash between the SWITCH publish and the INSTALLED marker fell through to
prepare + `runInstall` and **re-entered the protocol** — whose first two steps
(`writeInactiveSlot`, `stampIncarnation`) write the database in `targetSlot`,
which after the switch is the **LIVE** slot.

The function's own doc comment already forbade exactly this: *"re-entering the
protocol would write the restored payload into the slot that is now LIVE — the
one thing this module exists to never do."* **A doc comment describing a hazard
is not evidence the guard covers it.** Read the condition, not the prose.

## The signature, and why no new durable state was needed

`state === "PREPARED" && currentSlot === targetSlot` is an unambiguous signature
of the post-switch window. Verified before writing code — this is the claim the
whole fix rests on, and if any other path produced that pair the arm would skip a
real install and report INSTALLED over an unwritten slot:

- `RECOVERY_BINDING_SLOTS` is exactly `["ACTIVE","PENDING"]`; `selectInactiveSlot`
  returns the opposite member, so it can never return its argument.
- Every prepared record is built `target: selectInactiveSlot(current)` → current
  ≠ target at PREPARE, always.
- `resealAnchorRecord` has exactly **two** production call sites, both in
  `runInstall`: `:256` the switch, `:260` the marker.
- Other `currentSlot` mentions are reads (discard/inspect), not writes.

Adding a third `SWITCHED` state was rejected by the architect: it adds a durable
write *inside* the window being closed.

## Hoisting the identity check was load-bearing, not tidying

The identity check originally sat *after* `state === "INSTALLED"`, so a second
arm underneath would have been unguarded. I hoisted it above the state split.
**Drill C** (scope it back to the INSTALLED arm) reddens "refuses a different
command's fence over the post-switch window" with `expected true to be false` —
the intruder is handed a completed install. Not cosmetic.

## Three drills, three directions

| Mutation | Red |
|---|---|
| drop `currentSlot !== targetSlot` (too broad) | **7** tests, incl. "still runs a full install when the crash landed BEFORE the switch" |
| restore `state !== "INSTALLED"` (arm dead) | the post-switch marker test |
| identity guard scoped to INSTALLED arm only | the intruder-fence test |

Drill the arm in every direction it can be wrong, not just the one the DoD names.
The over-broad direction is the dangerous one — it skips real installs.

## Observe the seam, not the bytes

The harm is that `writeInactiveSlot`/`stampIncarnation` **run**, not that the
resulting bytes differ — a re-entry that succeeds still leaves a correct-looking
anchor. Tests record which `injectFault` boundaries the second call crosses and
require `observed` to be `[]`. Assert boundaries **individually** before the
`toEqual([])`: the empty-array failure says "expected 8 items to equal []" and
never names which boundary re-ran.

For "wrote nothing further", content equality proves nothing (the record encodes
deterministically) — assert the anchor file's **`mtimeMs` is unchanged**.

## Where a shared helper can live (cycle + size)

`recovery-anchor.ts` already imports from `recovery-anchor-install.ts`, so
putting the marker writer in the former and importing it back closes a **cycle**.
And `recovery-anchor-install.ts` was already 263 lines against a 250 target, so
adding a ~14-line helper there (net 263→274) violated the plan's "must not grow".

Solution: new `recovery-anchor-marker.ts` (36 lines) holding `markInstalled`,
imported by both writers. It takes the anchor **FILE path**, not the root,
because `anchorPath` lives in install.ts — resolving the root inside the marker
module would re-close the cycle. That reason is in the module's doc comment.
Result: install.ts 263 → **262** (shrank), anchor.ts 198 → 210.

**New `.ts` in packages/store needs a `.js` bridge** (`export * from "./x.ts";`) —
invisible to vitest and tsc, only child-process probes catch its absence.

## `computePreparedIdentity` does NOT cover the payload

It covers codec version, generationDigest, incarnationRef, keyEpochRef,
preparedAt, restoreCommandId only. So a test helper that mints fresh sqlite bytes
per call still produces the **same** prepared identity — which is what makes a
same-command resume testable.

## Two different refusal codes on two entry points

`installRecoveryAnchor` → `RECOVERY_ANCHOR_INCARNATION_REUSED`;
`resumeRecoveryAnchor` screens a layer earlier → `RECOVERY_ANCHOR_COMMAND_MISMATCH`.
Both layer `RECOVERY_ANCHOR`. Asserting merely "refused" lets either layer answer.

## A failed marker write throws; it does not falsely claim

`publishFileAtomically` returns `Promise<void>` and throws. The
`{ok:true, outcome:"INSTALLED"}` object is built only after the await resolves,
so no partial claim escapes. Pre-existing behaviour — `runInstall`'s marker write
was unguarded the same way; the resume path matches it rather than diverging.

## Shared-worktree notes from this run

- A peer's RED-first test (`backup-generation.test.ts`, register item 1,
  task-1fb6e871) reddened my owned-package gate mid-task. Attributed three ways:
  file uncommitted-modified; **the failing test name absent at HEAD**; zero
  reachability (`grep -c recovery-anchor backup-generation.ts` = 0). It went green
  before I finished. **Re-run before carrying a disclosure forward** — I nearly
  filed one for a red that no longer existed.
- Two foreign whole-tree commits swept my work under other tasks' labels
  (7263d13, 6482e5f). `git status` empty ≠ nothing changed. Locate with
  `git log -S"<a line you wrote>"`.
- I ran 3 drills while those commits were landing. **Verify HEAD's blob is the
  pristine sha and grep the mutant signatures to 0** — a hook can commit a drill.
- Restore drills from a copy kept **outside** the repo, never `git checkout`,
  which reverts to HEAD and destroys the whole uncommitted fix.

Related: `mem:decision-backup-generation-wal-pinning-and-atomic-publish`,
`mem:gotcha-sibling-tdd-red-blocks-your-owned-package-gate`,
`mem:gotcha-new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`.
