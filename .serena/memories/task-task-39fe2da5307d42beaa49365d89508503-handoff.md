# Handoff: J3 restart reconciliation + safe continuation (task-39fe2da5)

Composes `@moe/runner`'s recovery subtree into a daemon restart boundary. Landed
2026-08-09. All work is in `apps/daemon/src/recovery/`; `doctor-commands.ts` was NOT
touched.

## What shipped (12 files, all additions)

Production, all under the 250-line target:
- `restart-reconciliation.ts` (210) — `reconcileOnRestart(store, request)` classifies every
  in-flight attempt through root `classifyCrash` and persists one durable record per
  attempt with a truth chip. Exports `RESTART_RECONCILIATION_COMMAND_KIND` and
  `reconciliationAggregateId(attemptRef)` so callers/suites can name reconciliation rows
  without restating literals. Idempotent: byte-equality short circuit, and
  `expectedVersion` derived from the stored row so a legitimate reclassification converges
  instead of duplicating.
- `continuation-contracts.ts` (232) — vocabulary + byte ingress. `CONTINUATION_COMMAND_KINDS`
  is exactly one kind (`work.resume`) `satisfies readonly RuntimeCommandKind[]`.
  Four daemon codes, all at layer `"CONTINUATION"`.
- `continuation-service.ts` (169) — `evaluateContinuationCommandBytes(store, bytes)`, the
  ONE action. `readContinuationBindings(store, projectId)`.

Tests: `restart-reconciliation.test.ts`, `restart-reconciliation-idempotence.test.ts`,
`continuation-service.test.ts`, `continuation-binding.test.ts`, over shared
`recovery-test-fixtures.ts` (crash seeds minted by `activateEffect`) and
`continuation-test-harness.ts` (drives production, restates nothing). Both new modules have
`.js` bridges; all three load in plain Node via `--experimental-strip-types`.

## The flow, and the two gates that matter

```
bounded decode -> exact-shape gate (pinned schemaVersion, exact key list)
  -> durable classified record must exist        (CONTINUATION_ATTEMPT_UNRECONCILED)
  -> its classification must be a runner outcome (CONTINUATION_ATTEMPT_UNCLASSIFIED)
  -> admitSuccessorOverlap  (ACTIVE / UNKNOWN refuse under DISTINCT runner codes)
  -> admitResume            (PROVEN_RELEASED with no handoff still refuses)
  -> append binding on a FRESH aggregate named for the successor, at version 0
```

`bindingTarget(binding)` returns BOTH the aggregate id and the expected version from one
place. That is deliberate: it is the single append-only seam, so there is one line to read
and one line to drill. Do not split those into two call-site arguments.

## Decisions a future agent will want to re-litigate — don't, without reading this

1. **`CONTINUATION_COMMAND_KINDS` is NOT in `BOOTSTRAP_COMMAND_KINDS`**, despite the plan
   step saying to append it. Measured: appending forces edits in five files owned by
   sibling tasks (`bootstrap-sequence.ts`'s exhaustive `COMMAND_PREREQUISITES`,
   `bootstrap-services.test.ts`, `bootstrap-durability.test.ts`,
   `goals/j1-command-path.test.ts`, `bootstrap-test-fixtures.ts`). See
   `mem:gotcha-exhaustive-prerequisite-record-blocks-a-kind-append`. The `satisfies
   readonly RuntimeCommandKind[]` on the local array keeps the same guarantee — the kind
   must exist in the runtime vocabulary or the build fails — without widening a surface
   that does not compose it. `bootstrap-contracts.ts` is unmodified by this task.
2. **A REPLAYED store commit still reports `EFFECTS_COMMITTED`.** See
   `mem:gotcha-replayed-commit-keeps-effects-committed`. The byte comparison in
   `appendBinding` is load-bearing, not defensive.
3. **`UNCLASSIFIED` refuses a `REFUSED`-classified attempt.** A record exists but carries no
   classification; continuing from it would give unverifiable evidence authority.

## Gates

`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test && pnpm typecheck`
-> exit 0. Daemon suite: 26 files / 480 tests.

## COMMIT: there is no commit of this task's own

A sibling task's completion hook (`task-9011e3b3`, J4) swept the whole tree and committed
these 12 files inside `5ef4bcc feat(task-9011e3b32c...)`. Verified the committed bytes equal
the gated bytes by sha256 (`git show HEAD:<path> | sha256sum` vs the working tree) and
`git status --porcelain -- apps/daemon/src/recovery/` is empty. QA should review by
`git diff 7afa17d..HEAD -- apps/daemon/src/recovery/`, which contains exactly these 12
files. See `mem:moe-finished-task-may-have-no-commit`.

## Mutation drills (step 7)

Five run, one SURVIVED and exposed a real test defect —
`mem:gotcha-history-assertions-must-key-on-aggregate-not-command-kind`. After the fix:
append-only -> 1 suite red on the byte-identity test; `admitResume` bypass -> 1 red on the
no-handoff test; classification collapse to `"ADOPTED"` -> 4 suites / 10 tests red including
outcome-set equality and both SUSPECT tests; partial vocabulary -> 2 red; expectedVersion
pinned to 0 -> 1 red on the convergence test.

## Scope left open

Nothing consumes a continuation binding to actually start work — no HTTP/transport change
was in scope. The binding is the durable traceable successor record; wiring it to a runner
launch belongs to whoever owns that seam. J3's daemon-side composition is complete; the
Foundation canary remains the gate that proves J1/J3/J4 together.
