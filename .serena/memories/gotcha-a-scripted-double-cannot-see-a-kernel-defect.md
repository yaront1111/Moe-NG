# A scripted call-table double cannot see a kernel defect — and a green sweep hides it perfectly

Measured on task-af99cf14 (moe-next Win32 Job crate), 2026-08-09.

## What happened

Child 1 shipped `SetInformationJobObject(JobObjectBasicLimitInformation, ...)`
with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. MSDN lists that flag as a basic
LimitFlag, so the code reads correct. On a real kernel it returns FALSE with
**ERROR_INVALID_PARAMETER (87)**. The same flag through
`JobObjectExtendedLimitInformation` succeeds.

`Job::create` therefore could not create a single configured Job on the OS the
crate exists to target. It survived:
- child 1's full sweep, green
- 2a's extended sweep, green
- 2a's QA pass (mine), including four mutation drills, green

Every one of those drives an injected call table. The double returns `Ok`
because the double was written from the same reading of the docs the production
code was. **A test double encodes the author's belief about the boundary, so it
can never contradict it.** The first test that touched the kernel failed on line
one of its first test.

## The QA rule this produces

For any task whose deliverable is an FFI/syscall/driver/network boundary, treat
"the sweep is green" as evidence about the LOGIC ABOVE the boundary and nothing
else. Ask explicitly: what in this diff has ever executed against the real
thing? If the answer is "the release build compiles", the boundary is unverified
— a compile proves the signature, never the semantics.

This is why a real-kernel acceptance test that ACTUALLY RUNS (no `#[ignore]`, no
cfg gate, no stub) is worth more than any number of additional scripted cases,
and why letting one be marked skipped is a hard reject rather than a nit.

## The QA drill that certifies such a test

Revert the production fix and confirm the acceptance test goes red:

```
git show <base>:<path> > <path>     # restore the pre-fix bytes
cargo test --test real_windows      # must FAIL
cp <backup> <path>                  # restore, then verify by CONTENT grep
```

Red proves three things at once: the fix was forced (not scope creep), the
acceptance test reaches the kernel, and the defect was real rather than reasoned.

Related: `mem:gotcha-kill-on-job-close-needs-extended-limit-class`,
`mem:qa-prove-an-out-of-plan-edit-was-forced`,
`mem:gotcha-negative-mutation-drill-proves-a-test-blind-spot`.
