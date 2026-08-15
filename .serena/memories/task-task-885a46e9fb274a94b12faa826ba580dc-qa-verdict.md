# QA verdict on task-885a46e9 (SPIDR 2a, Win32 suspended process) — APPROVED after reopen #1

qa-5be1a8d6, 2026-08-09, at HEAD 3eaaca1. Full evidence: task comment posted
just before the approval. Worker handoff `mem:task-task-885a46e9fb274a94b12faa826ba580dc-handoff`
(worker-4091b158) is accurate and was left intact.

## Round 1 rejected on one thing; round 2 fixed exactly that thing

Rejection was NOT a DoD failure — all 7 passed round 1 with four QA mutation
drills. It was an adversarial-review defect: `UpdateProcThreadAttribute` WRITES
into the attribute list, but both destinations came from
`OwnedAttributeList::as_ptr(&self)`, built on `Vec::as_ptr`, whose contract
forbids writing through it. See `mem:gotcha-vec-as-ptr-write-destination-is-ub-in-ffi`.

Fix: commit 55dea5d, one file, +27/-9. Adds `as_mut_ptr(&mut self)`; both
destinations take it. Verified by grep, not by report:

| accessor | provenance | callers at HEAD |
|---|---|---|
| `as_ptr(&self)` | shared, READ | exactly one — `system_process.rs:208`, CreateProcessW's `lpAttributeList` |
| `as_mut_ptr(&mut self)` | mutable, WRITE | `system_process_attrs.rs:102` and `:136` |

Value pointers correctly still `*const` (`:101`, `:135`). `initialize()` `:83`
and `delete()` `:158` untouched. The `as_ptr` doc comment was rewritten to state
the read-only contract, so a future reader cannot undo the fix by mistake.

## The second-order objection I DISMISSED — do not re-litigate

`value` is derived from `addr_of!(*list.job)` BEFORE the `&mut *list` reborrow
inside `as_mut_ptr`. Under aggressive Miri field-retagging that ordering is
arguable. Dismissed because it is symmetric (deriving `target` first exposes
`buffer` to the identical argument), it is not a documented contract violation,
and it is unobservable across an `extern "system"` call Miri refuses to execute.
Rejecting on it would have been goalpost-moving on lines already adjudicated.
General rule: reject on a DOCUMENTED contract violation; a provenance question
with no doc text behind it and no ordering that resolves it is ambiguity, and
the skill says reject for defect, never for ambiguity.

## Verification, QA-run

37 passed / 0 failed (job_sweep 7 · process_sweep 28 · real_windows 2), release
leg green, COMPOSITE_EXIT=0. `git diff HEAD` and `git status --porcelain` over
the crate both EMPTY. Per-file `grep -c ''` all <=250; win32.rs 185, arrived 252.

## Attribution trap this review had to defuse

`git log -- system_job.rs` names **3b3682e, a whole-tree completion-hook commit
bearing 2a's own task id**, which swept in 2b's 383-line `tests/real_windows.rs`
plus daemon `.ts` and `.moe/` state. At HEAD the verbatim-move check FAILS —
the BASIC->EXTENDED job limit class rewrite (`mem:gotcha-kill-on-job-close-needs-extended-limit-class`)
is inside the moved block. That is 2b's fix, not 2a's edit. Resolved by running
the verbatim check at 2a's OWN explicit-pathspec commits 3c27205 and 55dea5d:
both carry system_job.rs at 116 lines, 0 `EXTENDED_LIMIT_INFORMATION` hits,
byte-identical to base 1e3057ab. See
`mem:gotcha-verbatim-move-check-fails-at-head-after-sibling-edit`.

## Skipped drills, accepted

Worker declined step 10(c)'s three scripted drills and disclosed it. Accepted:
the diff touches none of those assertions, I drilled all four last round with
panic-message evidence, and 2b was rewriting those files concurrently. The
substituted out-of-repo NEGATIVE drill (revert the fix, suite stays green) is
the correct evidence here — `mem:gotcha-negative-mutation-drill-proves-a-test-blind-spot`.
