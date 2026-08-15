# task-dddfaf83 — Graph supersession engine (SPLIT into 2, parent now a BLOCKED shell)

Architect: architect-d46fcb95, 2026-08-09. Epic M2 Graph Beta.

## Not a dependency block — this one was plannable
The description names four hard dependencies. Measured: **Lease presence core** (task-967769ea) and **Policy approval core** (task-556d87c3) are **DONE**; **Fan-in integration pipeline** (task-351e09bd) and **Same-bug circuit breaker** (task-cda6bddf) are PLANNING but appear in **zero** of the four DoD items. Task rail 3 says outright: *"order is a presentation hint, not a fabricated hard dependency."* Don't block this family on those two.

## The measurement that shapes everything
**`graph.supersede` is declared but deliberately unimplemented.**
- `graph-revision-reducer.ts:59` lists it in `GRAPH_REVISION_COMMAND_KINDS`
- `:68` gives it an **empty** admitted-from list in `GRAPH_REVISION_TRANSITIONS`
- `:170` routes it to `illegal(state, command.kind)` unconditionally
- `:196` already refuses every further command once a revision is `SUPERSEDED`, via `supersededAuthority()` (`graph-revision-results.ts:42`)
- `GraphRevisionSupersedeCommand` (`graph-revision-contract.ts:77`) carries only a `GraphRevisionRefusalWitness` — **no successor/epoch binding**

So the vocabulary and the fail-closed guard exist; the transition does not. This is neither "absent" nor "already done" — it's a deliberate placeholder, and reading only the grep hit count would mislead in either direction.

## Human decision (2026-08-09)
The core slice **owns the transition**, so its owned paths were amended to add `graph-revision-{contract,reducer,validation}.ts` + `graph-revision-reducer.test.ts`. Rationale: without it the engine computes dispositions nothing applies — a pure package with no consumer edge, which Clause 1 forbids completing.

## Why split (mechanical, 13 files vs a 10 cap)
core supersession ×3, graph-revision ×4, `core/index.ts`, scheduler supersession ×3, `scheduler/index.ts`, `scheduler/index-surface.test.ts`.

| child | id | state |
|---|---|---|
| Core revision supersession, epochs and carry binding | task-6b8d0e2e948b48f7a1f40ad5a00a4a13 | promotable now |
| Scheduler supersession dispositions | task-069853689ed643988cfec2d689f7edb7 | needs the core slice |

## Substrate already on disk — compose, don't rebuild
- **DRAIN exists**: `scheduler/src/authority/lease-drain.ts` → `DrainDisposition` (:31), `DrainTerminalTarget` (:29), `parseDisposition` (:118), `applyDrainReason` (:142), `releaseWork` (:194).
- **Resource**: `lease-resource.ts`, `resource-model.ts` (`SLOT_STATES`, published at scheduler `index.ts:67,151`), `lease-fencing.ts`, `lease-state.ts`.
- **Budget**: `scheduler/src/budget/**`, `budget-reservation` published at `index.ts:78,168`.
- **Carry invalidation**: `core/src/policy/approval-invalidation.ts`.
- **Vocabulary already in @moe/contracts**: `SUPERSESSION_CONSEQUENCE_CHANGED`, `SUPERSEDED_AUTHORITY`, `REVISION_REBOUND` (`runtime-error-registry.ts:14`); `graph.supersede` (`runtime-vocabulary.ts:94`); `APPROVAL_VALIDITY` and attempt lifecycle both carry `SUPERSEDED`. **Do not mint a parallel vocabulary.**

## A real consumer is already waiting
`packages/scheduler/src/admission/admission-wait.ts:10` names this task in a comment: *"supersession carry of wait/blocker projections -> graph supersession engine"*. That's the scheduler slice's Clause 1 consumer edge — it exists in production source, not just on the board.

## Traps
- `scheduler/src/index-surface.test.ts` pins the exact namespace: `toBe(36)` (:57) + `toEqual` (:61). Any new root value export reddens it. Same family as `mem:gotcha-testkit-fairness-is-not-production-scheduler`.
- Core publishes per-module blocks straight from `core/src/index.ts`; only `identity/` has an area index. So core additions touch the shared root file.
- `graph-revision-reducer.test.ts` (222 lines) pins today's behaviour *including* that supersede is illegal. Only the assertions the new transition genuinely invalidates may change.
