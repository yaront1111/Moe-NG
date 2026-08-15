# KILL_ON_JOB_CLOSE is rejected by the BASIC job limit class

Measured on Windows 11 26200 x64, 2026-08-09, windows-sys 0.61.2, on one fresh
`CreateJobObjectW` handle, same flag `0x2000` both times:

```
basic ok=0 err=87 | extended ok=1
```

- `SetInformationJobObject(job, JobObjectBasicLimitInformation,
  &JOBOBJECT_BASIC_LIMIT_INFORMATION{ LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }, size)`
  returns **FALSE** with **ERROR_INVALID_PARAMETER (87)**.
- The same flag through `JobObjectExtendedLimitInformation` /
  `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` returns TRUE.

Docs list KILL_ON_JOB_CLOSE among `JOBOBJECT_BASIC_LIMIT_INFORMATION`'s
LimitFlags, which is what makes the wrong choice look researched. It is not.
Read the flags back through the SAME class you set them through, or an exact
equality check compares two different views.

## Why this matters far beyond one API call

`moe-windows-job-core` shipped this bug through THREE green gates: child 1
wrote it, child 2a built on it, QA re-ran both verification legs. Every one of
those suites drove an injected call table, so not one of them ever reached the
kernel. The scripted sweep proves the ORDERING, the REFUSALS and the CLEANUP
DISCIPLINE — and it proves the `windows_sys` code COMPILES. It cannot prove any
FFI call is the right call. Child 1's Cargo.toml even recorded the reasoning
("KILL_ON_JOB_CLOSE is a documented basic LimitFlag, so the extended struct
buys nothing"), which is how a wrong premise survives review: it reads as a
decision someone already made.

**The rule.** Any task that lands a real FFI/syscall boundary behind an
injectable seam needs at least one test that actually crosses it, in the same
task. A seam makes the logic testable and makes the boundary invisible. If the
plan defers the real-kernel test to a sibling, the boundary is unverified until
that sibling lands — say so out loud rather than letting a green suite imply
otherwise.

Corollary for reviewers: "N tests pass" over an injected double is not evidence
about the platform. Ask which test opened a real handle.

When you fix a defect whose CAUSE is a written premise, correct the premise
too. Left in place, the comment tells the next reader to undo the fix.
