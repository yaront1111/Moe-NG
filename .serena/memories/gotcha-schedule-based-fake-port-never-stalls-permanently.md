# A schedule-driven fake port models a ONE-TIME stall, never a permanent one

Writing a fake write-port as "a list of chunk sizes, fall back to the remainder
once the list runs out" is the natural shape, and it is the right shape for
testing *completion* across several short writes:

```ts
const allowed = schedule[call] ?? length;   // <-- the fallback
```

But it CANNOT model a permanently stuck port. A schedule of `[0]` stalls on
attempt 1 and then accepts everything on attempt 2, so the production loop
always completes. A test named "terminates on a port that reports no progress"
built on that schedule is not testing termination at all.

**How it surfaced:** drilling the loop's zero-progress guard
(`bytesWritten <= 0` -> `bytesWritten < 0`) reddened the suite, so the guard
looked load-bearing. It was red for the WRONG reason - the write succeeded and
the refusal assertion failed, rather than the loop spinning. See
`mem:mutation-drill-red-on-wrong-assertion`.

Fix: a SEPARATE always-zero opener with no fallback, alongside the schedule one.

## Second trap: an unbounded loop OOMs the worker, it does not time out

With the guard weakened and a genuinely stalled port, the loop span and the
recorder accumulated one attempt object per iteration:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
Error: [vitest-pool]: Worker forks emitted error.
 Test Files   (1)
      Tests   (10)
```

Exit 1, so it counts as red - but `Tests (10)` with no per-test verdict. And
`--testTimeout=5000` never fired: GC thrash beat the timer. A future maintainer
who weakens that guard sees a native crash, not a named failure.

**Put the bound in the PORT, not the runner:**

```ts
if (recorded.attempts.length >= STALLED_PORT_ATTEMPT_CAP) {
  throw new Error(`the completion loop retried a stalled port ... times; it is not bounded`);
}
```

Cap far above the 1 attempt a bounded loop makes, far below what exhausts
memory (64 works). The drill then reddens in 3ms with named failures.

Generalises `mem:mutation-drill-can-hang-instead-of-failing`: a runner timeout
is not a reliable bound when the spin allocates. Related:
`mem:vitest-worker-dies-on-held-sqlite-handle` - same unreadable output shape,
different cause.
