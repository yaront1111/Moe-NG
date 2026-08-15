# A refusal test can be answered by an earlier guard, and only a mutation drill shows it

Found on task-aedcd01ad9 (`packages/core/src/planning/graph-revision-succession.test.ts`).

## The symptom

I relaxed a new epoch guard from `=== 1` to `>= 1` and the suite stayed **green**. Four
tests existed specifically to pin that guard. None of them reddened.

## The cause

My test helper attached `approval: SUCCESSOR_APPROVAL` to *every* `graph.approve` command.
That is correct from `PENDING_APPROVAL` (the compound approve+activate path), but from
`APPROVED` the reducer refuses any command carrying an approval — `graph-revision-reducer.ts`:

```ts
} else if (command.approval !== undefined) {
  return illegal(state, command.kind);
}
```

That branch runs **before** `validActivation` is ever called. So all four initial-activation
cases were being refused by the re-approval guard, produced the right code
(`ILLEGAL_TRANSITION`) and the right source state (`APPROVED`), and asserted green — while
the epoch rule they were written for was never reached.

## Why it is invisible

The refusal code and the refusing layer both matched. `expectIllegal(result, kind, state)` is
a strong assertion and it was fully satisfied. Nothing about the test's *shape* was wrong;
the command shape had quietly detached it from its subject.

## How to catch it

Mutate the guard under test and confirm a **named** test reddens. If the suite stays green,
the test is not exercising that guard — do not conclude the guard is "extra safe". Read the
production path top-to-bottom and find which earlier branch is answering first.

## The fix pattern

Build the command for the *specific* lifecycle under test rather than reusing one helper for
all of them. From `APPROVED` an activation command carries **no** `approval`; from
`PENDING_APPROVAL` it must. The corrected test builds an approval-free command inline.

Related: `mem:guard-premise-detaches-while-green`, and the epic rail phrasing "one added
layer away from vacuous: a second refusal layer can start answering first and the test stays
green while no longer testing its subject."
