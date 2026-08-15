# QA verdict on task-af99cf14 (SPIDR 2b, Win32 lifecycle + two-regime unwind + real-Windows acceptance) — APPROVED first pass

qa-5be1a8d6, 2026-08-09, verified at HEAD 7c9591e, re-verified at 9bb652c.
Full evidence: task comment `comment-24320c0a`. Worker handoff
`mem:task-task-af99cf146c9b4f4d99b49d8c00caed63-handoff` (worker-a87e980a) is
accurate on every claim I checked and was left intact.

## Gate, QA-run
Exact task command, foreground, both legs. job_sweep 7 · process_sweep 28 ·
real_windows 2 · doc 0 = **37 passed / 0 failed / 0 IGNORED / 0 filtered**, no
warnings, TEST_EXIT=0; release BUILD_EXIT=0. `git status --porcelain` and
`git diff HEAD` over the crate both EMPTY.

## Review by base-ref diff, not by commit (again)
`git diff 55dea5d..HEAD -- <crate>` = 15 files, +1683/-148, all inside the crate.
2b's bytes are split across **3b3682e** (foreign whole-tree, bearing 2a's id) and
**95f5e5e** (the worker's own pathspec commit). Separately, **3eaaca1** is this
task's completion-hook whole-tree sweep of 36 FOREIGN files (daemon documents,
control-room dossier, planning, recovery-inventory) — and it contains ZERO crate
files, which proves the worker had already committed by pathspec. Hook defect,
not worker conduct; not a rejection reason under project rail 5.

## The seven drills, and why each one earned its place

| # | mutation | result |
|---|---|---|
| D0 | revert `system_job.rs` to 55dea5d (BASIC limit class) | BOTH real_windows tests FAILED at `Job::create` |
| D1 | `query_exit_status` returns the raw code with no proof | `left: Exited(ExitCode(7))` |
| D2 | pre-membership fault routed through the JOB path | pre-regime test RED, **post-regime stayed GREEN** |
| D3 | real impl `WAIT_TIMEOUT => Err` | real_windows TEST A red at :306, TEST B green |
| D4 | `LIFECYCLE_OPS` lists CloseHandle instead of QueryImageName | "sweep did not reach every lifecycle NativeOp" |
| D5 | 2a's resume guard `== 1` -> `!= u32::MAX` | `a_prior_suspend_count_other_than_one_is_our_refusal` RED |
| D6 | `wait_until_job_is_empty` samples once | both poll tests RED |

**D0 is the technique worth reusing.** The worker edited `system_job.rs`, a file
child 1 owns, outside the plan. Prose cannot settle whether that is scope creep.
Reverting JUST that file and running its consumer does:
`git show <base>:<path> > <path>` then run the test that needs it. RED = forced.
See `mem:qa-prove-an-out-of-plan-edit-was-forced`.

**D2 is the only thing that actually proves DoD "two regimes, two paths".** Both
regime tests pass under the correct code, and both would pass if one path merely
happened to satisfy both assertions. The discriminating observation is that the
POST test stays GREEN while the PRE test goes red under a mutation that collapses
pre into post. A drill that only checks "something went red" would not have shown
that.

**D5 is the cheap way to discharge "sibling assertions still unweakened".** One
mutation in 2a's production arm; if 2a's test is still wired to the production
surface it reddens. Cheaper and stronger than reading the sibling's diff for
weakened assertions.

## Restore discipline in the shared worktree
Restored from a `mktemp -d` backup OUTSIDE the repo (a `.bak` in-tree is an
untracked artifact a foreign whole-tree hook can commit), then verified by
`grep -c` on all four anchors AND clean `git status`. Content check first: git
status alone lies if a foreign commit captured the drill edit
(`mem:mutation-drills-in-shared-worktree`). Every mutation also asserted an
anchor count of exactly 1 before applying — a 0-count silently no-ops and the
"drill" then proves nothing.

## The one thing I declined to reject on
`SignalledProof` binds to a handle VALUE, so a proof retained across
`contained.close()` could match a recycled handle on a later process. That guard
was in NO DoD item — it is the worker's own hardening from their adversarial
pass. `Waited`/`SignalledProof` are not `Clone`, so keeping one past a close is
deliberate. Rejecting on an imperfection in unrequired hardening is
goalpost-moving; same rule as the Miri provenance objection I dismissed on 2a.
See `mem:qa-grade-against-the-written-requirement-not-your-own-suggestion`.

## Headline, carried forward
`tests/real_windows.rs` caught a defect child 1, 2a AND my own prior QA pass all
shipped green: `SetInformationJobObject(JobObjectBasicLimitInformation,
KILL_ON_JOB_CLOSE)` returns ERROR_INVALID_PARAMETER (87) on Windows 11 26200 x64.
The crate could not create one configured Job on its target kernel.
`mem:gotcha-kill-on-job-close-needs-extended-limit-class`.

Related: `mem:task-task-885a46e9fb274a94b12faa826ba580dc-qa-verdict`,
`mem:gotcha-a-scripted-double-cannot-see-a-kernel-defect`.
