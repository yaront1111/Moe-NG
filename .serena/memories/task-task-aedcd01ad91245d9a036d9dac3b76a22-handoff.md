# task-aedcd01ad9 — successor graph activation at predecessor epoch + 1

Landed in commit **e3040ad** on `moe/work-2026-08-08`. Status REVIEW. 6 owned paths, all
under `packages/core/src/planning/`.

## What shipped

`graph-revision-reducer.ts` persisted the literal `graphEpoch: 1` on activation, so a
superseded chain's second generation re-activated at epoch 1. It now persists
`activation.graphEpoch`.

- `graph-revision-contract.ts` — `GraphRevisionActivationWitness` gains `graphEpoch: number`
  and optional `succession?: GraphRevisionSuccessionBinding`
  (`predecessorGraphContentHash` / `predecessorGraphEpoch` / `predecessorRevisionId`).
- `graph-revision-validation.ts` — `ACTIVATION_KEYS` gains `graphEpoch`;
  `SUCCESSION_ACTIVATION_KEYS = [...ACTIVATION_KEYS, "succession"]`.
  `validActivationEpoch` owns the arithmetic: **exactly 1** with no succession, **exactly
  `predecessorGraphEpoch + 1`** with one. `validSuccessionBinding` exported.
- `graph-revision-reducer.ts` — one new state-dependent rule folded into the existing rebound
  condition: `activation.succession?.predecessorRevisionId === state.revisionId` → `rebound()`.
- fixtures — `ACTIVATION` gains `graphEpoch: 1`; new `SUCCESSOR_BINDING`,
  `SUCCESSOR_APPROVAL`, `successionOf()`, `successorActivation()`.
- `planning-invariant-fixtures.ts` — `REVISION_ACTIVATION` gains `graphEpoch: 1`. **One line.**
  Drivers and `planning-invariants.test.ts` needed zero edits.

## Load-bearing design decisions (don't undo these)

**Epoch went on the WITNESS, not on `GraphActivationBinding`.** `sameBinding`/`bindingOf`
iterate `BINDING_KEYS`; putting it on the binding reaches `validBinding`, `bindingShape`,
every approval fixture and the planning-run witnesses. On the witness it reaches only
`ACTIVATION_KEYS` + `validActivation`.

**Arithmetic lives in validation, not the reducer.** `graph-revision-reducer.ts` had 13 free
lines against the mechanically-enforced 250 cap; validation had 123. Only the self-succession
rule is in the reducer, because it is the only one needing `state`.

**`succession` binding carries `predecessorGraphEpoch`, which the kernel's
`SupersessionSuccessorBinding` does NOT.** The kernel successor carries only its own
`graphEpoch`. Without the predecessor's epoch in the binding, "exactly predecessor + 1"
degenerates into a self-consistency check proving nothing. The other two field names are
verbatim from the kernel so the event binding maps across untranslated.

**`validActivationEpoch` branches on `"succession" in value`, not `=== undefined`.** An
explicit `succession: undefined` from untyped input must go down the succession branch and
refuse, not be re-classified as an initial activation and accepted at epoch 1.

## Scope

DoD 1 (the goal-side epoch advance, a command admitted from the live execution lifecycle
that increments `goal.graphEpoch`) is **task-3d5a72fea6db45cfb8df748b58b6aae4**, split out at
planning time for the 10-file cap. It names this task as its Clause 1 consumer. Nothing under
`packages/core/src/goal` was touched here. `goal-reducer.ts:39` still admits
`goal.activate_initial_graph` from `DRAFT` only.

## Known limit (disclosed to QA, not a defect)

A pure aggregate cannot confirm the predecessor named by `succession` actually exists at that
epoch and is SUPERSEDED. A command claiming `predecessorGraphEpoch: 5` against a real epoch-1
predecessor validates at 6. Cross-aggregate binding is the daemon's atomic transaction; the
production path derives the binding from the kernel-emitted `GraphRevisionSuperseded` event.

## Verification

`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` → exit 0,
24 files / 369 tests (baseline 23 / 363). Repo-wide typecheck all-Done, repo-wide test
215 files / 4047 passed / 1 skipped. Line counts (`grep -c ''`): contract 209, reducer 240,
validation 156, fixtures 210, succession.test 184, invariant-fixtures 89.

Cheapest re-verification: revert `graphEpoch: activation.graphEpoch` to `graphEpoch: 1` and
run `graph-revision-succession.test.ts`. It must fail `expected 1 to be 2` on **durable
state** — the emitted event says 2 either way.

See `gotcha-refusal-test-answered-by-earlier-guard`.
