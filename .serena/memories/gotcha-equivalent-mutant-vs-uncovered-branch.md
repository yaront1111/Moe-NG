# A zero-red mutation is not always an uncovered branch

Found on task-f6c9011b round 3 (`packages/runner`, `classifyRefFailure`).

## The situation

Epic rail 6 says verify a failure-path test by mutating production and confirming
red. The natural inference from "I mutated it and nothing reddened" is *nothing
covers this*. That inference is wrong for one specific class: **equivalent
mutants** — mutations that provably cannot change the output for any input.

Concrete case:

```ts
const overflowed =
  error.code === "RUNNER_SCOPE_OBSERVATION_OVERFLOW" ||   // <- delete this line
  (error as { cause?: { code?: unknown } }).cause?.code === "ENOBUFS";
return new ScopeObserverError(
  overflowed ? "RUNNER_SCOPE_OBSERVATION_OVERFLOW" : error.code,
  ...
```

Deleting the first disjunct leaves the whole suite green. But it *must*: that
disjunct only flips `overflowed` false->true when `error.code` already IS the
overflow code, and in exactly that state the ternary's two arms evaluate to the
same string. Output identical for every input. **No test can distinguish an
equivalent mutant** — that is a theorem, not a coverage gap.

## How to tell the two apart, cheaply

Run a **companion mutation on the same branch that is NOT equivalent**. Here:
change the ternary's true-arm constant to a different code. That reddened 2
cases, proving the arm is reached and its output pinned. So:

- non-equivalent mutation red + equivalent mutation green  => covered, fine
- non-equivalent mutation ALSO green                       => genuinely dark

Without the companion, "zero red" is ambiguous and you cannot argue either way.

## What to do about it

Do NOT silently leave it unmentioned — QA re-runs the obvious mutation and reads
green as a defect (this board had already rejected twice for real dark branches).
Do NOT delete the redundant code either if the task is a narrow reopen: that
widens a diff QA must re-verify.

State it explicitly with the equivalence argument and the companion drill's red
count. Disclosure plus proof is what separates this from the failure mode in
`mem:gotcha-drilled-the-table-not-the-branches`.

## Related

While sweeping branches this way I also found a genuinely unasserted **constant**
(a fallback message) on a branch that WAS reached — different defect, same sweep.
Branch reached does not imply every literal on it is pinned.
