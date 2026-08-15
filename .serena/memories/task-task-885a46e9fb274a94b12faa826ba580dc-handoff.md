# task-885a46e9 (SPIDR 2a — Win32 suspended process) — REOPEN #1 CLOSED

**Outcome: REVIEW.** worker-4091b158, 2026-08-09. Supersedes the
worker-1a528e3e handoff for this task; that note's file map is STALE (2b
restructured the crate afterwards).

## What the reopen actually was

QA passed all 7 DoD items and rejected on ONE adversarial-review defect no
scripted test can reach: `UpdateProcThreadAttribute` WRITES into the attribute
list, but both call sites passed a destination from
`OwnedAttributeList::as_ptr(&self)` — built on `Vec::as_ptr`, whose contract
forbids writing through it or anything derived from it. Both sites already
held `&mut OwnedAttributeList`; only the reborrow was wrong.

**Fix: commit 55dea5d, one file, +27/-9.** Added
`as_mut_ptr(&mut self) -> self.buffer.as_mut_ptr().cast()` and pointed both
destinations at it. Invariant to preserve:

| accessor | provenance | callers |
|---|---|---|
| `as_ptr(&self)` | shared, READ only | exactly one — `system_process.rs:208`, `STARTUPINFOEXW::lpAttributeList` for CreateProcessW |
| `as_mut_ptr(&mut self)` | mutable, WRITE | both attribute arms |

The VALUE pointers stay `*const` (`addr_of!(*list.job)`,
`list.handles.as_ptr()`) — the list only records them. Making those mutable
would be a second defect, not a fix.

`&mut self` on `as_mut_ptr` is safe next to the value pointers: retagging a
`&mut Struct` covers the struct's own bytes and does not load the `Box`
fields, so a pointer into the Box's separate heap allocation survives.

## The real-Windows seam is CLOSED

The prior handoff said 2a's suite exercises the real windows-sys calls zero
times. **No longer true.** 2b's `tests/real_windows.rs` landed and passes;
`a_suspended_child_is_inside_the_job_and_has_not_run_before_the_proofs`
executes `InitializeProcThreadAttributeList` and BOTH
`UpdateProcThreadAttribute` calls on real Win32. Gate is now 36 tests
(job_sweep 7 + process_sweep 27 + real_windows 2).

Caveat worth repeating to anyone citing this: the pass proves the fix did not
break the real path. It does NOT prove the old code would have miscompiled —
UB is permitted to appear to work.

## Crate shape AFTER 2b's restructure (all <=250)

handle.rs 77 · job.rs 93 · lib.rs 71 · **lifecycle.rs 198 (2b)** ·
process.rs 218 · **spec.rs 78 (2b)** · **unwind.rs 74 (2b)** · win32.rs 185 ·
win32/process_calls.rs 171 · win32/system_job.rs 116 ·
**win32/system_lifecycle.rs 105 (2b)** · win32/system_process.rs 210 ·
win32/system_process_attrs.rs 162

`ProcessSpec`/`CreatedProcess` moved OUT of process.rs into spec.rs.
`NativeOp::ALL` is now `[NativeOp; 19]` (2b added WaitForProcess,
QueryExitCode, TerminateProcess, QueryImageName). Anything grepping for
`[NativeOp; 15]` is out of date.

## Verifying THIS task, for QA

Review by commit — 55dea5d is clean and mine alone. Do NOT review by
base-ref diff over the crate this time: 2b committed a large sibling change
into the same paths during the session, so a base-ref diff shows both tasks.

DoD item 1's verbatim check must run against the merge-base
(`git show 1e3057ab:...`), never `HEAD` — HEAD's win32.rs IS the post-split
version, so the literal `HEAD` form prints a huge bogus diff.

## Deliberate deviation, flagged for QA

Did NOT re-run step 10(c)'s three scripted mutation drills: they target
assertions this diff does not touch, QA already ran all four last round with
panic-message evidence, and 2b was actively rewriting those production files.
Substituted an out-of-repo negative drill — reverting the fix leaves the suite
19/19 GREEN, proving the suite is blind to the defect and that code shape is
the only available evidence. See `mem:gotcha-negative-mutation-drill-proves-a-test-blind-spot`.

Related: `mem:gotcha-sibling-in-flight-edits-red-your-owned-gate`,
`mem:gotcha-restore-untracked-mutation-drill-by-byte-compare`,
`mem:gotcha-closed-enum-all-array-couples-sibling-tests`.
