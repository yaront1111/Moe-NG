# A closed enum breaks sibling tests TWICE, and the second break tempts a wildcard

Extends `mem:gotcha-closed-enum-ALL-array-breaks-sibling-sweep`, which covers
only the first break. Found on task-885a46e9, 2026-08-09.

## The two breaks

Adding variants to `NativeOp` broke `tests/job_sweep.rs` in two independent
places, and only the first was predicted at planning time:

1. `pub const ALL: [NativeOp; 6]` — fixed-size array type, so the literal AND
   the annotation fail to compile. Predicted, planned for.
2. **`fn drive(case: &Case)` matched `case.op` EXHAUSTIVELY.** E0004,
   "non-exhaustive patterns: `NativeOp::InitAttributeList` ... and 6 more not
   covered". Unpredicted, and it is the more dangerous one.

## Why the second one matters

The obvious repair is `_ => unreachable!()`. **Do not.** A wildcard also
swallows a future JOB-side variant — exactly the case this test exists to
catch — so the enum's whole forcing function dies in the file that most needs
it, and it dies silently.

Correct repair: list the foreign variants EXPLICITLY in one panicking arm.

```rust
NativeOp::InitAttributeList
| NativeOp::SetJobListAttribute
| /* ...every construction variant, named... */
| NativeOp::ResumeThread => {
    panic!("{:?} is a construction op; tests/process_sweep.rs owns it", case.op)
}
```

Verbose on purpose: adding a 16th variant still breaks THIS match, so the next
author is still forced to decide which sweep owns it.

## Sizing consequence

Before estimating a task that extends a closed enum, grep for BOTH:

```
rg '::ALL'            # coverage arrays
rg 'match .*\.op\b'   # exhaustive matches in sibling tests
```

Every hit is a file the task must edit. On this board that difference is what
pushed a task past the daemon's plan-shape ceiling and forced a SPIDR split.

## Splitting a totality assertion across two test crates

Integration tests are separate crates and cannot share a const. When sweep A no
longer owns "reaches every variant", the coverage must be reconstructed:

- A asserts exact equality against its OWN hand-written op list (catches a dead
  arm in A) plus "each of mine is still listed in `NativeOp::ALL`" (catches a
  variant dropped from ALL while still existing — a compile error cannot see
  that, because naming a live variant still compiles).
- B asserts `B_OPS.len() + A_OP_COUNT == NativeOp::ALL.len()`, plus
  `set(ALL).len() == ALL.len()` so a variant listed TWICE in ALL cannot mask a
  missing one.

`A_OP_COUNT` is hand-written in B. The duplication is the point: it is what lets
each file fail independently instead of agreeing with itself.
