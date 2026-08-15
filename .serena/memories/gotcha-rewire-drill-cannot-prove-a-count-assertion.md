# A rewire drill preserves cardinality, so it can never prove a count assertion

When a test guards a sweep with BOTH a mapping assertion and a count precondition, one
mutation does not exercise both. Choose the mutation by which invariant it breaks, not by
whether something went red.

Observed on task-a95ccf7e (`truth-tone-contrast.test.ts`, apps/control-room), certifying
five `[data-tone]` rules in `surfaces.css` against `TRUTH_TONE_TOKENS`:

- **Rewire** `[data-tone="amber"] -> [data-tone="ochre"]`. Red with `CR-CONTRAST-003` for
  BOTH `amber` (in the typed map, absent from the sheet) and `ochre` (in the sheet, absent
  from the map). Proves the drift check works in both directions. But the parsed rule count
  is STILL 5, so `expect(DECLARED_TONES.size).toBe(5)` and
  `expect(result.checked).toBe(DECLARED_TONES.size)` never fire. The count precondition is
  completely untested by this drill.

- **Delete** the whole `amber` rule block. Red at the count assertion:
  `AssertionError: expected 4 to be 5` — the only observation that shows a PARTIAL token
  set cannot pass.

Both drills print `CR-CONTRAST-003` somewhere in the output. Grepping for the reason code,
or for "went red", cannot tell them apart. Read the FAILING LINE NUMBER: `:234` (the sweep)
versus `:211` (the count).

## Generalisation

The epic rail "a generated or swept case must assert that the case was actually generated"
has a matching QA obligation: to verify that assertion you need a mutation that CHANGES THE
CARDINALITY of the swept set. Substitution mutations — rename a key, swap a value, rewire a
pointer — hold cardinality fixed by construction and are structurally incapable of it.
Same trap on the schemes axis: an `it.each([...SCHEMES])` sweep is only pinned by a
hand-written `expect([...SCHEMES]).toEqual(["light","dark"])`, and only an emptying drill
tests that pin.

Related: `mem:qa-generated-table-cannot-police-its-own-generator` (the same defect from the
authoring side), `mem:gotcha-drill-red-direction-distinguishes-right-reason` (read the
message/line, not the failure count), `mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.
