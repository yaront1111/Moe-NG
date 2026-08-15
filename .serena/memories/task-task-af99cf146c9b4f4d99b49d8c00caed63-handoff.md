# task-af99cf14 (SPIDR child 2b) — DONE and INDEPENDENTLY VERIFIED

Architect architect-5aba94da. Planned 10 steps / 9 files; worker-a87e980a
delivered 10/10, `failedDodItems: []`, status DONE.
Sibling 2a = `task-885a46e9` (REVIEW). Parent shell = `task-a02496`.

## Verification I ran myself at HEAD (not the status field)

- `job_sweep` **7 passed**, `process_sweep` **28 passed**,
  `real_windows` **2 passed, 0 ignored**, doc-tests 0. Release build exit 0.
- `real_windows.rs` genuinely RUNS on the kernel — no `#[ignore]`, no `cfg`
  gate, no stub anywhere in tests/ (grep for `#[ignore` / `#[cfg(` returns only
  a doc comment saying so). No taskkill, no shell, no PID enumeration.
- Every production file ≤250: process 218, lifecycle 213, system_process 210,
  win32 185, process_calls 171, system_process_attrs 162, system_job 130,
  system_lifecycle 105, job 93, spec 78, handle 77, unwind 74, lib 73.
- Tree clean, all 20 paths tracked, no binary/artifact tracked, `dist/` ignored
  at .gitignore:4.

## The plan's hard parts all landed as designed

Test names map one-to-one onto the requirements:
`an_exit_query_with_no_prior_wait_is_unknown_and_never_a_number`,
`an_exit_query_after_a_timed_out_wait_is_unknown`,
`an_exit_query_after_an_abandoned_wait_is_unknown`,
`an_exit_code_is_reported_only_after_a_wait_reported_signalled` — the
STILL_ACTIVE(259) discipline. `three_of_the_four_wait_results_are_ok_values` —
the WAIT_EVENT non-collapse. `a_pre_membership_fault_terminates_and_awaits_the_child_directly`
and `a_post_membership_fault_terminates_the_job_and_waits_for_it_to_empty` —
the two regimes as separate paths. `the_two_sweeps_together_account_for_every_native_op`
— the totality cross-check. `a_job_that_never_empties_is_uncertain_and_never_reported_as_empty`
— UNKNOWN never gains authority.

**My step-5 amendment landed**: `an_unterminated_spec_is_refused_before_any_boundary_call`
is the third (nothing-acquired) regime that `fn validate` created and the
original plan missed. Both pre-authorised splits were used (`unwind.rs`,
`system_lifecycle.rs`), plus one the worker added itself (`spec.rs`) — that is
why the file count came in above the 9 I planned.

Worker also added a guard I did not specify:
`a_signalled_proof_about_one_process_does_not_authorise_another`.

## Commit attribution — bytes span THREE commits, two foreign

- `95f5e5e` (2b's own): src/lifecycle.rs, tests/real_windows.rs
- `c199088` (task-1df0622e, graph supersession — FOREIGN): src/unwind.rs,
  src/spec.rs, src/win32/system_lifecycle.rs
- earlier foreign/2a commits carry the rest

Third occurrence of the whole-tree hook hazard on this crate
(`mem:moe-finished-task-may-have-no-commit`). Never a rejection reason. QA must
review by base-ref diff over owned paths spanning all three, not by looking for
one commit bearing the task id.

## Note for QA / the parent shell

With 2a in REVIEW and 2b DONE, parent shell `task-a02496` can be closed once 2a
clears QA — via a **REVIEW transit hop**, since direct BLOCKED -> DONE is
rejected (`mem:moe-backlog-to-done-transition-blocked`).

Related: `mem:task-task-885a46e9fb274a94b12faa826ba580dc-handoff`,
`mem:gotcha-amend-plan-step-refused-when-team-role-is-null`,
`mem:gotcha-closed-enum-ALL-array-breaks-sibling-sweep`.
