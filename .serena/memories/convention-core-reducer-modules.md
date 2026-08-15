# Convention: writing a new aggregate reducer in packages/core

Verified against `project/`, `goal/`, and `planning/` as of commit `bcdc2f6`.

## Files

One directory per aggregate area, one contract file per aggregate. No area
`index.ts`, no `.js` shims (identity's shims are an anomaly — do not copy
them). Root `packages/core/src/index.ts` gets one value block per reducer
module plus one alphabetized `export type` block per contract file, appended
in chronological block order.

Identity's missing root export was SETTLED by task-556d87c3 (policy area): it
is re-exported as a single `export * from "./identity/index.js"` block at the
tail, because its curated area seam already lists its three modules and
per-module blocks would duplicate that surface. Collision-free; nothing else
in the root index shares a name with it. Do not re-open this.

Internal modules stay internal: `planning-validation`, `policy-validation`,
`policy-composition`, and `approval-validation` are NOT re-exported from the
root index.

Note ASCII sort when alphabetizing: uppercase precedes lowercase, so
`PlanApprovalWitness` and `PlanRevisionSeal` both sort **before**
`PlanningAbsenceRecoveryWitness`.

## Shape

- `<X>AcceptedResult { events, ok: true, state, successor? }`,
  `<X>RejectedResult { error: RuntimeError, ok: false }`, union type.
- `reduce<X>(state: <X>State | undefined, command: <X>Command)`.
- Local `deepFreeze` on every result. Safe because the command and the state
  are both snapshotted into fresh objects on entry — nothing caller-owned is
  ever reachable from a returned object. Never store a command object in state.
- Frozen `<X>_COMMAND_KINDS` and `<X>_TRANSITIONS` exported from the reducer.
  Core-local command kinds beyond `RUNTIME_COMMAND_KINDS` are precedented.

## Check order in the entry point (do not reorder)

1. `snapshotCommand` → `UNKNOWN_ERROR` on malformed or unknown kind
2. `state === undefined` → only the create kind, `expectedVersion === 0`
3. `snapshot<X>State` → `UNKNOWN_ERROR` on malformed
4. `validExpectedVersion` → `ILLEGAL_TRANSITION`
5. version mismatch → `EXPECTED_VERSION_CONFLICT`
6. empty `commandId` → `IDEMPOTENCY_CONFLICT` **only if the registry allows
   that source**, otherwise `ILLEGAL_TRANSITION`
7. `TRANSITIONS` lookup
8. version-overflow guard accounting the multi-event `versionDelta`
9. per-command apply

Witness-validation failures reject `ILLEGAL_TRANSITION`; malformed snapshots
reject `UNKNOWN_ERROR`.

## Error codes are per-aggregate, and mismatches are SILENT

`createRuntimeError` degrades to `UNKNOWN_ERROR` when the code's
`validSources` does not include the tagged aggregate, and it *requires* a
`source` whenever `validSources` is non-empty. From
`runtime-error-registry.ts`:

- `ILLEGAL_TRANSITION` — APPROVAL, ATTEMPT, CUTOVER, EFFECT, GOAL,
  GRAPH_REVISION, INTEGRATION, NODE_RUN, PLANNING_RUN, PROJECT,
  QUALIFICATION_RECOVERY. (Corrected 2026-08-08 against
  `runtime-error-registry.ts:106-109`; an earlier version of this memory
  omitted APPROVAL and several others. The registry file is authoritative —
  re-read it, do not trust this list.)
- `EXPECTED_VERSION_CONFLICT` — GOAL, GRAPH_REVISION, NODE_RUN, PLANNING_RUN,
  PROJECT (**not** APPROVAL)
- `IDEMPOTENCY_CONFLICT` — GOAL, NODE_RUN, PLANNING_RUN, PROJECT (**not**
  GRAPH_REVISION, **not** APPROVAL)

Consequence for the APPROVAL aggregate: `ILLEGAL_TRANSITION` is the ONLY
registry code it may raise with a `{aggregate:"APPROVAL"}` source. Malformed
input rejects `INPUT_INVALID`, which declares no valid source and must be
raised WITHOUT one.
- `REVISION_REBOUND` — ATTEMPT, GRAPH_REVISION, NODE_RUN (**not** PLANNING_RUN)
- `SUPERSEDED_AUTHORITY` — ATTEMPT, GRAPH_REVISION, LEASE, NODE_RUN
- `PLANNING_SUBMISSION_FINALIZING` — PLANNING_RUN, `sourceState` detail
- `UNKNOWN_ERROR` — must be raised with **no** `source`

Always assert the intended code in a test. Grep every `createRuntimeError`
call site before finishing; a wrong pairing produces no compile error and no
runtime warning.

`requiredDetailKeys` is an allowlist for sanitization, not an enforcement —
omitting a listed detail key yields empty details, not a failure.

## Truth floors (`goal-validation.ts:145-186`)

`strongTruth` admits **only** `DAEMON_VERIFIED | HUMAN_APPROVED`; `OBSERVED`
and `AGENT_REPORTED` reject. Destructive or authorization witnesses (cancel,
reopen, REVISE_PLAN) require exactly `HUMAN_APPROVED`.

## Guards are NOT exported from @moe/contracts

`isHex64`, `hasExactKeys`, `isCommandKind` are internal. Build membership sets
locally from the exported tuples. See `mem:gotcha-contracts-guards-not-exported`.

## Size

Target ≤250 lines per production source, split before 400. Splitting a reducer
into `<x>-reducer.ts` (entry + early transitions) and a second transition
module, with shared result helpers in a third, keeps this without contorting
the design. Test files are not bound by the limit — the landed suites already
run longer than their modules.
