# Gotcha: `packages/testkit/src/scheduler-fairness/**` is a non-authoritative oracle, not the production scheduler

Measured 2026-08-09 while planning task-a1e7f75e (Expansion protocol public hardening).

`grep -rln "FairnessTicket|WDRR|capRevision" packages/*/src` returns five files — **all under `packages/testkit/src/scheduler-fairness/`** (`fairness-codec.ts`, `fairness-fixtures.ts`, `fairness-internal.ts`, `fairness-lifecycle.ts`, `fairness-model.ts`).

It is easy to read those hits as "fairness exists" and plan against them. They are the committed reference oracle. Epic `epic-e0c54bdd` (M2 Graph Beta) says so in its own architectureNotes:

> "The committed fairness reference is a non-authoritative oracle, not production scheduler state."

M1's notes call it "a DEVELOPMENT_ONLY fairness reference."

**Production scheduler fairness does not exist:** `packages/scheduler/src/fairness` is not a directory, and `grep EXPANSION_ADMISSION|admitExpansion|prepareExpansion` over `packages/scheduler/src` returns ZERO.

## Rule
When probing for a capability, **filter hits by package before concluding it exists**. A match in `packages/testkit/**` is a test-tier reference and never satisfies a production-capability probe under global rail Clause 2. Same instinct as `mem:task-task-8f9305b9bb5e4b8db327a55981b2ea0e-handoff`, where ~50 `eceipt` hits in `@moe/store` were all `command_receipts` dedupe plumbing rather than evidence receipts.

## Sibling measurement worth keeping
`EXPANSION` is a *representable* PlanningRunKind (`planning-command-contract.ts:8`) purely for forward compatibility, but the production path still fail-closes: `planning-run-reducer.ts:77` and `planning-run-submission.ts:52` both refuse every non-INITIAL kind with `PLANNING_KIND_UNSUPPORTED`. An enum member being representable is not the behaviour being shipped — check the reducer, not the type.

Related: `mem:decision-foundation-canary-production-prerequisite-map`.
