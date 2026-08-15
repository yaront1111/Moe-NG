# Gotcha: a validation ORDER invariant survives mutation when tests use one side of the cross-product

Found during QA of `task-967769ea` (`packages/scheduler/src/authority`, commit `c0b564e`).
Three mutants died loudly; the fourth survived green.

## The shape

`releaseWork(record, authority, request)` splits into design-765 branches:

```
fence -> terminal? NO_OP
      -> parse request
      -> parse handoff        <-- correctness depends on this being HERE
      -> compose disposition
      -> settled ? RELEASED : DRAINING
```

Branch 3 ("handoff cannot commit -> authority unchanged, NO DRAINING transition") is correct
ONLY because the handoff parse precedes the branch split. Moving it after the `if (!settled)`
return keeps every one of 131 tests green — because all five invalid-handoff cases were written
with `safeBoundaryObserved: true`, and all three not-settled cases were written with a VALID
handoff. Each half of the cross-product is covered; the interaction that the ordering protects
is not. A refactor would silently commit DRAINING on an unvalidatable handoff.

## Rules

- **Author:** when a guard's correctness comes from WHERE it sits rather than what it checks,
  write the test that fails if it moves — the input that makes the later branch attractive
  (`invalid handoff` + `not settled`) plus an assertion on the refusal. "Both inputs are tested
  separately" is not coverage of the ordering.
- **QA:** mutation-test by MOVING code, not only by breaking it. Deleting a check kills tests
  loudly; relocating one is the mutant that survives, and relocation is exactly what an
  innocent-looking refactor does.
- **QA:** a surviving move-mutant on already-correct code is a residual to record with the exact
  missing case, not automatically a reject — but say the mutant survived, with the count, so the
  next reviewer does not read the green suite as proof of the ordering.

Same family as `mem:gotcha-self-derived-universe-cannot-check-itself` (a field the checker copies
through rather than derives is unasserted however green the suite looks).

See `mem:task-task-967769ea801f4fe09944e4fdcc47663e-qa-verdict`.
