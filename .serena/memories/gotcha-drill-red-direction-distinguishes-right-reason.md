# A mutation drill can redden on the fixture's pre-check instead of its subject

A drill that goes red is not automatically a passing drill. When the test wraps the mutated guard
in a sweep that FIRST validates its own fixture, there are two different reds and only one of them
proves anything.

Concrete shape, from `planning-run-expansion.test.ts` (packages/core, task-93b0314e):

```ts
expect(validExpansionHoldBinding(deviation)).toBe(true);   // fixture pre-check
...
expectIllegal(result, "plan.propose", "PLANNING");         // the actual subject
```

Read the DIRECTION of the assertion message:

- `expected true to be false` — the panic is inside `expectIllegal` (`result.ok || "unsupported" in
  result`). The production guard was bypassed and the run ACCEPTED the deviating input. **This is
  the right-reason red.**
- `expected false to be true` — the panic is the fixture pre-check. The deviation stopped being
  schema-valid, so it never reached the guard under test. The drill proved nothing about the
  mutation; it proved the fixture rotted.

Both print `AssertionError`, both show `1 failed`, and a grep for `FAIL` cannot tell them apart.
Grep the message text, or read the failing line number, before recording a drill as green.

Related: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers` (why the pre-check exists at
all), `mem:gotcha-identity-match-guard-shadowed-by-schema-layer` (the defect it guards against),
`mem:qa-generated-table-cannot-police-its-own-generator` (why the swept field set must be
hand-written, not read out of the production constant the drill mutates).
