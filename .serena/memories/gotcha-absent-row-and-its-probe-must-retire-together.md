# Gotcha: a foundation ABSENT row and its probe retire as ONE atomic edit

`packages/testkit/src/foundation/foundation-spec.test.ts:150` asserts a
BIJECTION, not a subset:

```ts
expect([...claimed].sort()).toEqual([...probeRefs].sort());
```

`claimed` is collected only from `CATALOGUE_ROWS` entries whose outcome kind is
`PRODUCTION_BEHAVIOR_ABSENT`; `probeRefs` is every entry in
`CATALOGUE_PROBES`. Consequences both directions:

- Adding a probe with no ABSENT row referencing it -> RED.
- Flipping the LAST ABSENT row that references a probe to `PASS` without also
  deleting that probe -> RED, on a guard file you did not touch.

So when a ratchet fires and you retire its manifest row, delete the probe in the
same commit. Grep first — if another row still names the probe, keep it.

Seen on task-c7c6cf92 (`schedule:j4-stale-lease-enforcement` ->
`probe:scheduler-authority-lease`); see
`mem:task-task-c7c6cf92b3f24f95b721d49bad7d7d22-qa-verdict`.

REVIEWER NOTE: a commit that flips one row to PASS *and* deletes a probe reads
like scope creep against a "change no other probe definition" DoD item. Check
this guard before rejecting — the deletion is usually forced.

Related drill lesson from the same review: when the production surface has a
nearer refusal layer (here `fenceAuthority` parses record and proof and can
answer `AUTHORITY_MALFORMED_INPUT` before it ever compares epochs), mutating the
*expected reason code* is a weak drill — a malformed fixture kills that mutant
too. Mutate the *input operand* instead (stale epoch -> current epoch) and
require the assertion to flip. Pair it with a positive control so the row cannot
pass by refusing everything. Compare
`mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
