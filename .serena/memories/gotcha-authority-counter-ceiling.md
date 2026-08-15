# Gotcha: a monotonic counter that passes `Number.isSafeInteger` can still brick a record

Found by adversarial self-review on `packages/scheduler/src/authority` (task-967769ea).

A generic `isCount` guard of "safe integer and >= 0" accepts `Number.MAX_SAFE_INTEGER`.
The reducer then emits a successor with `version + 1`, `epoch + 1`, or
`serverWallSeconds + RENEWAL_WINDOW_SECONDS`. Those results are **not** safe integers, so
the successor record fails the very same parse on every later command. The lease becomes
permanently unmutable — it cannot even be revoked. The bug is silent: the mutation that
creates the unparseable record returns `ok: true`.

```
Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1)  // false
Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 90) // false
```

## The two-bound fix

One bound is not enough — whatever ceiling you pick, the successor at `ceiling` must still
parse or you have only moved the brick one step later.

- **Parse bound** (`MAX_AUTHORITY_COUNT = Number.MAX_SAFE_INTEGER - 1_000_000`): records at
  or below it parse, so a record sitting exactly at the ceiling stays readable and
  reconcilable.
- **Mutation bound** (strictly `< MAX_AUTHORITY_COUNT`, checked in `fenceAuthority`): a
  record at the ceiling is refused for mutation with a typed code. Explicit fail-closed
  refusal, never a silently unparseable successor.
- Derived values need their own headroom: `parseClock` caps `serverWallSeconds` at
  `MAX_AUTHORITY_COUNT - RENEWAL_WINDOW_SECONDS` so the derived deadline still parses.

Counter exhaustion is a property of the RECORD, not of the attempt, so it maps to the
malformed-input code and emits **no** rejection-security event.

## Related latent throw found in the same pass

`array.reduce(fn)` with no initial value throws `TypeError` on an empty array. In a
fail-closed pure kernel a throw is a contract break — every path must return a typed
rejection. Guard the empty case and return `null`/a rejection instead, even when the
current callers all guarantee non-empty; the next caller will not.

See `mem:gotcha-pure-reducer-deep-freeze-aliasing` for the sibling class of purity bugs.
