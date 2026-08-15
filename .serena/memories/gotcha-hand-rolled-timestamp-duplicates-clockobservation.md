# A hand-rolled "monotonic timestamp" field duplicates a published `ClockObservation` — and drops `bootId`

Caught by adversarial self-review on task-8e3076177f87458f934a776eca68ba16 (2026-08-15), AFTER the
suite was green and typecheck was 0. No test could have found it: the field is a type declaration.

## What I wrote first

A plan step said "wall and monotonic timestamps, kept distinct". Nothing upstream obviously modelled
a monotonic reading, so I declared one:

```ts
export interface ProviderRunMonotonicInterval {
  readonly startedAtMonotonicNanos: string | null;
  readonly completedAtMonotonicNanos: string | null;
}
```

with a confident docblock about `process.hrtime.bigint()` overrunning `Number.MAX_SAFE_INTEGER`.

## Two defects, both invisible to the gate

1. **It already exists.** `@moe/scheduler` publishes `ClockObservation`
   (`authority-kernel.ts:107-111`, root `index.ts:250`) =
   `{serverWallSeconds, bootId, monotonicObservation}`. Re-declaring it is the silent-duplicate
   defect — a producer change would compile cleanly and diverge inside durable bytes.
2. **Mine was strictly weaker.** No `bootId`. A monotonic reading is only comparable against another
   **from the same boot**, so a duration derived from a pair without boot identity is unfalsifiable.
   Under epic rail 4 that is unverifiable evidence gaining authority.

## Why the first grep missed it

`git grep -ni "monotonic" -- packages/runner/src packages/scheduler/src` was run only AFTER the
record was written, as an adversarial check. Its hits look like noise at a glance —
`monotonicMs: () => number` (a clock port), `Monotonic counter supplying temp-name entropy` (a
comment). The real one surfaces as the bare field name `monotonicObservation`, which reads like a
member of somebody else's record rather than a reusable published type. **Grep the CONCEPT, then
chase each hit to its declaring interface and check the package root's type-export block** — a
one-word grep result is not an answer.

## Rule

Before declaring ANY local shape in a contract module, grep the concept across every producer
package and check the root export block. The rule you are already applying to obvious producer
records (`ProviderRunRef`, `UsageMeasurementRecord`) applies just as hard to the small utility shapes
that feel too generic to be published — those are exactly the ones that already exist.

Related: `mem:qa-prove-a-structural-view-is-bound-to-the-real-source`,
`mem:undeclared-workspace-dep-has-no-escape-hatch`.
