# Convention: `cr.*` test-id prefixes must count elements EXACTLY

Established on `task-fd82678f720747888d1c32ef96bb5534` (apps/control-room scaffold), and it
bit twice in one task before the rule was written down.

Control-room spec §12 bar 3 is: *every `cr.fact.*` element has a `cr.chip.*` descendant.*
Every surface task will write that audit as a prefix selector:

```ts
container.querySelectorAll("[data-testid^='cr.fact.']")
```

So a prefix must name **one kind of element and nothing inside it**.

## What went wrong (twice, same shape)

1. Wrapper `cr.fact.<id>` with inner spans `cr.fact.label` / `cr.fact.value` → the selector
   matched 3 elements per fact. Test failed with `expected 36 to be 12`.
2. Chip `cr.chip.<class>` with inner spans `cr.chip.glyph` / `cr.chip.label` → same 3x
   inflation on the chip side. Caught only by counting chips in the built bundle.

Inflation is worse than a wrong number: label/value spans have no chip descendant, so the
audit either fails for the wrong reason, or — written as a find-first — passes without ever
inspecting a real claim.

## The naming that landed

| element | test id |
|---|---|
| fact wrapper | `cr.fact.<factId>` |
| truth chip (a `<button>`) | `cr.chip.<truthclass>` (from the model kernel's `chipTestId`) |
| fact's label / value | `cr.label` / `cr.value` |
| chip's glyph / short label | `cr.glyph` / `cr.shortlabel` |

`cr.glyph`/`cr.shortlabel` rather than reusing `cr.label`: a chip lives inside a fact wrapper,
so `within(wrapper).getByTestId("cr.label")` would throw on multiple matches.

## Pin it in tests

```ts
expect(container.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(wrappers.length);
```

One chip per fact, no more. Without the equality the prefix can silently rot again.

Note the model kernel (`packages/control-room-model`) owns `chipTestId` values — the five
`cr.chip.<class>` ids come from `describeTruthClass`, so never hand-write them.
