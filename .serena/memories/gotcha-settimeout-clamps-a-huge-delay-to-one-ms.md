# A mutation drill that sets a timeout to a huge number makes the bound fire FASTER

Found 2026-08-14 on task-9fff3d42 while drilling a newly added OS-opener bound.

The production code bounds an uncancellable operation:

```ts
const timer = setTimeout(() => resolve("TIMED_OUT"), timeoutMs);
```

The obvious drill — "remove the bound" — was written as:

```ts
const timer = setTimeout(() => resolve("TIMED_OUT"), Number.MAX_SAFE_INTEGER);
```

**The suite stayed GREEN, 23/23.** That reads as an uncovered guard and would have sent me back to
rewrite a test that was already correct.

**Why.** Node's `setTimeout` clamps any delay above `TIMEOUT_MAX` (2^31-1 ≈ 24.8 days) to **1 ms**.
So the mutation did not remove the bound; it made the bound fire essentially immediately. The
test asserts the bound HOLDS, so a faster bound satisfies it. The mutation moved toward the
guard, not away from it.

**The drill that actually kills it** — keep the timer, make it resolve nothing:

```ts
const timer = setTimeout(() => undefined, timeoutMs);
```

RED at 29006ms with `Error: bounded wait expired: openControlRoom must give up on an opener that
never answers`.

## How to apply
- To drill a timeout, never scale the delay UP. Scale the *effect* away: stop the callback from
  settling anything, or delete the timer entirely.
- The same trap applies to any clamped parameter — `setInterval`, and anything whose value is
  silently normalized before use. A mutant inside the clamped range is an equivalent mutant.
- A surviving drill is evidence about the DRILL first. Diff what you changed before concluding
  the test is weak. See `mem:gotcha-mutation-drill-must-mutate-toward-never-refusing` and
  `mem:mutation-drill-green-may-indict-the-mutation`.
- Record the survivor in the step note. "A drill went green" is exactly the evidence that gets
  quietly dropped, and dropping it is how a fake coverage claim gets built.

Related: `mem:gotcha-out-of-process-drill-hangs-instead-of-failing`,
`mem:gotcha-drill-red-direction-distinguishes-right-reason`.
