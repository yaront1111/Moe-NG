# task-b937811e — Benchmark telemetry harness — DELIVERED (was: blocked twice)

Landed 2026-08-16 by worker-0cd13358. Commits `f65fbde` (harness) + `002497c` (hardenings).
Gate: `pnpm --filter @moe/benchmark test` -> **`Test Files 4 passed (4)` / `Tests 50 passed (50)`**, EXIT=0.

## THE VACUOUS GATE IS CLOSED — quote this pair, it is the whole point

| when | output | exit |
|---|---|---|
| before | `No projects matched the filters in "D:\projexts\moe-next"` | **0** |
| after | `Test Files 4 passed (4)` / `Tests 50 passed (50)` | 0 |

Three prior audits carried this hazard. `packages/benchmark` simply did not exist, and
`pnpm --filter` on an absent package exits 0. Positive control run every time:
`pnpm --filter @moe/coordination test` -> `Tests 42 passed (42)`. See
`mem:pnpm-filter-nonexistent-package-exits-0`.

## The design question nobody had answered: the INPUT BOUNDARY

`ProviderRunRecord` lives at `apps/daemon/src/telemetry/provider-run-contracts.ts:94`.
**A package cannot import from an app**, so the harness cannot take it by reference.

Resolution shipped: the harness accepts **bounded plain data** and validates **shape only**,
pinning `PROJECTED_RECORD_VERSION = "moe-provider-run-record/1"` as *its own literal*.
That duplication IS the seam — drill 6 (bump the fixture's version, leave the literal)
reddens **37 tests**, all `BENCHMARK_RECORD_VERSION_UNRECOGNISED@BENCHMARK_VERSION`.

Deliberately inverted from the daemon's rule ("type every field from its producing
package's root"). That rule protects bytes being WRITTEN; this package only READS bytes
already sealed. Closed vocabularies (`terminal`, `coverage`, `truthClass`) are typed
`string`, never re-listed — re-listing would entitle this package to an opinion the codec
already formed.

## Package shape (zero dependencies, by design)

`packages/benchmark`, no deps block at all. Every import is a relative sibling or `vitest`.
No `@moe/store`, no reach into `apps/**`. Scripts copied from `packages/coordination`:
`test: "vitest run --root ../.. packages/benchmark/src"` — the `--root ../..` is
load-bearing (`mem:gotcha-store-focused-vitest-needs-root-two-up`).

| module | lines | role |
|---|---|---|
| `benchmark-record-contracts.ts` | 209 | plain-data mirror + version literal + `PROJECTED_RECORD_KEYS` |
| `benchmark-projection-vocabulary.ts` | 130 | 5 codes, 4 layers, 5 unknown-bases, 2 cost-bases, `BenchmarkValue<T>` |
| `benchmark-record-admission.ts` | 142 | the four guards |
| `benchmark-projection-cells.ts` | 62 | **every UNKNOWN in the package is built here** |
| `benchmark-cost-projection.ts` | 87 | cost rows + counts |
| `benchmark-run-projection.ts` | 213 | `projectBenchmarkRun`, the column types |
| `benchmark-record-fixture.ts` | 179 | deeply-frozen admissible fixtures |

Each `.ts` has the repo's one-line `.js` bridge; `index.ts` is the entry and takes none.

## Guard order is load-bearing

`INPUT` (plain record?) -> `VERSION` -> `SHAPE` (present, then kind) -> `ROW`.
`recordVersion` is **deliberately absent from the shape table** so a field complaint can
never answer for a schema move. Version-before-shape because an unrecognised schema means
the harness cannot know which fields to expect.

## Fixture constants are chosen to be DISCRIMINATING

- daemon monotonic delta **12**, wall delta **30** — a wall-derived duration is a different number
- launcher stamps hours from the daemon's — a mixed-observer duration came out **-1786873370**
- quantity **4** x **1500** micros — a derived **6000** appears nowhere in the record

Without that separation drills 2 and 5 could have passed by coincidence.

## Eight drills, all red on the intended assertion

| # | mutation | reddened |
|---|---|---|
| 1 | fill absent `observedModel` from `declared` | "never fills an absent observed model from the declared selection" |
| 2 | mix `launch.startedAt` with `observedEnd` | "derives its one duration from the daemon monotonic pair and from nothing else" (`-1786873370` vs `12`) |
| 3 | delete the `bootId` guard | "refuses a duration when the two observations carry different boot identities" |
| 4 | `nullableCell` null -> `knownCell(0)` | "renders no unobserved reading anywhere in the projection as a zero" (+3 more) |
| 5 | add `actualCostMicros` | "exposes no derived price on a cost row" (key-set) |
| 6 | bump fixture `recordVersion` | 37 tests, all the version seam |
| 7 | `Number.isFinite` -> `typeof "number"` | "refuses a required field that is present but the wrong shape" |
| 8 | drop `deepFreeze` | "refuses in-place mutation of a fixture at every depth" |

**Drill 3 attribution matters**: the red carried `value: 12` — a *real* monotonic delta —
proving both observations were present, so the failure is the boot rule and not a missing
field. Both conditions yield UNKNOWN, so a red for the wrong reason would have left the
rule untested. The test asserts `daemonStart.known`/`daemonEnd.known` are true *before*
asserting the duration is unknown, which is what forces that.

Drill 4 reddening four guards at once is the payoff of building every UNKNOWN in one
function — one edit, four independent assertions answer.

## Two holes adversarial review found (neither was in the plan)

1. **Non-finite readings.** `typeof x === "number"` accepts `NaN`. A NaN monotonic would
   have flowed into the one subtraction and published `{known:true, value:NaN}` — a value
   in no record, wearing an observation's authority. Now `Number.isFinite` on both clock
   readings, measurement quantity and row sequence. It needed **no new codes**: a bad
   observation is `FIELD_MALFORMED@SHAPE`, a bad row is `ROW_BASIS_ABSENT@ROW`.
2. **Shared mutable fixtures.** The `FIXTURE_*` constants were embedded by reference in
   every returned record. Now deeply frozen — which is also the more faithful shape, since
   `composeProviderRunRecord` freezes what it commits.

## FOREIGN SWEEP — disclosed, not repaired

`git log --diff-filter=A` names **`11b78f2`** (`task-6cbff010`) as the ADDER of my
package.json, tsconfig.json, contracts, vocabulary and index — a whole-tree commit that
captured them while untracked. My `pnpm-lock.yaml` importer went with it and IS in HEAD
(`git show HEAD:pnpm-lock.yaml` line 124, `packages/benchmark: {}`). Per project rail:
never amend, never reset, never mint a claiming commit.

**QA must review by base-ref diff, not by commit:**
```
git diff cf272f67c3e34fe1d8c4dd00675512c67f165c05..HEAD -- packages/benchmark pnpm-lock.yaml
```

## For the next agent

Consumers named at planning time (Clause 1): **task-3a34adca** (corpus freeze) then
**task-8af4562f** (campaign). Both are now unblocked on this.

Public surface: `projectBenchmarkRun(input: unknown)` -> `{ok:true, projection}` or a
refusal carrying `code`+`layer`. Columns: `runIdentity`, `modelEvidence`, `effort`,
`settings`, `timing`, `counts`, `costClass`, `evidenceReceipt`, `reproducibility`,
`refusals{scheduler,provider}`.

**Do not add scoring to this package.** No ranking, no claim decisions, no corpus bytes.
A projector holding a verdict decides the claim it exists to measure. That boundary is
written into the index header on purpose.

Residual from `mem:task-task-d3239529aab54f98b31bfd3662e316bf-handoff` is still open and
is NOT this task's: `projectUsage`'s `usage.ok` arm is unreachable without an OBSERVED
launch, so no real `NormalizedMeasurement` has ever reached durable bytes. This harness
projects that shape correctly from fixtures, but nothing yet proves production emits it.
