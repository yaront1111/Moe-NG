# Two provider seams publishing the same names collide SILENTLY at the barrel

Found planning `task-2159fa19c3734d149e0f9026098875b5` (publish the Codex
surface on `@moe/runner`) at HEAD `2f4281f`.

## The shape

`packages/runner/src/index.ts` composes its root by star-re-exporting curated
surface modules:

```ts
export * from "./surface/claude-surface.js";
export * from "./surface/codex-surface.js";   // the new one
```

`providers/claude/claude-observation.ts` and
`providers/codex/codex-observation.ts` are **independent duplicate
implementations sharing 17 export names** — `buildProviderRuntimeObservation`,
`RUNTIME_CLOSURE_KINDS`, `ProviderRuntimeObservation`, `PlatformIdentity`,
`ObservationClock`, … (codex-observation imports only `../../canonical.js`, so
there is no shared parent module). `MoeEffectIdentity` collides the same way
between the two stream modules.

## Why it is dangerous, not untidy

A name exported by two `export *` paths is **ambiguous, and ESM excludes it from
the namespace instead of raising an error.** So:

- `tsc` stays green.
- ~8 runtime values vanish from the root. The ONLY signal is a root
  `Object.keys(pkg)` set-equality guard going red.
- The type-only half of the collision has **no runtime signal whatsoever** — see
  `mem:type-only-export-invisible-to-count-test`.

A reviewer reading the diff sees two tidy curated surface files and no conflict.

## How to apply

When adding a SECOND provider/adapter surface to a shared barrel, do not
enumerate collisions and alias the hits — enumeration is exactly what fails.
Adopt a **blanket rule**: every name the new surface publishes must carry the new
provider's prefix, aliasing on export where the underlying module used a
provider-neutral name. Collisions then become impossible by construction.

Enumeration also fails for a second reason: grep-based export extractors miss the
single-line `export type { X } from "..."` form, so any hand-derived collision
list is a floor, not a total. Verify the final state by re-running the
intersection against the composed barrel, not by trusting the list you started
from.

Separately, check whether another surface **already** publishes some of the new
provider's symbols (here `recovery-inventory-surface.ts` already owned 9 Codex
types). Re-exporting the SAME binding twice is legal ESM and will not break, but
it gives one published name two owners — leave it with its existing owner when
that file is not in your owned paths.

Related: `mem:type-only-export-invisible-to-count-test`,
`mem:qa-pair-a-publication-probe-with-a-negative-control`,
`mem:entry-bridge-drill-is-a-no-op`.
