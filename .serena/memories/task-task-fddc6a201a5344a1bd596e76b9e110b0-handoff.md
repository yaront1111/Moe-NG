# Handoff: approval decision surfaces — COMPLETE (2026-08-08 11:55Z)

Supersedes the earlier BLOCKED note. All 5 plan steps done; 10 owned files under
`apps/control-room/src/approvals/**`; `pnpm --filter @moe/control-room test` exit 0,
**11 files / 155 tests**; `typecheck` exit 0.

## The step-1 gate was never satisfied — and that was correct

The plan gated on `approval-j1.tsx` being committed by task-04673fd0. It was not (and still
was not when work started). The task had ALREADY been blocked on that exact gate once; the
governor re-promoted it with "Owns `apps/control-room/src/approvals/**` only — disjoint from
the ... shell-frame siblings". **That promotion is the answer to the block** — re-blocking on
the same gate is a loop. Verified before proceeding: zero import coupling (none of my 10 files
reference `approval-j1.tsx`), and the file was never created/renamed/edited by me.

## Where the files live in git (attribution is wrong, content is fine)

Task B's session-end auto-commit **swept 5 of my files into its own commit** `c1f599e`
(`approval-fixtures.ts`, `approval-gating.ts`, `approval-gating.test.tsx`,
`approval-inbox.test.tsx`, `approval-inbox.tsx`) — see `mem:gotcha-session-end-commit-sweeps-foreign-work`,
which this reconfirms. My own commit `46ef880` carries the remaining 6 paths (4 detail
surfaces + `approval-details.test.tsx` + the `approval-inbox.tsx` `DecisionControl` change).
Nothing is lost; a QA agent diffing "this task's commit" alone will see only 6 of 10 files.

## Architecture as landed

- `approval-fixtures.ts` (249) — DEVELOPMENT_ONLY data only. Structural mirror of
  `ApprovalDecisionRecord` (`packages/core/src/policy/approval-contract.ts:43-62`; control-room
  cannot import `@moe/core`). `approvalRecord`/`withRecord` REFUSE a `SYSTEM_POLICY` record
  claiming `HUMAN_APPROVED` or carrying R2/R3 (design 701/710). `IDLE_CONSEQUENCES` = the six
  §8.10 strings verbatim; `idleConsequence()` returns **null** for cutover/soft-waiver rather
  than inventing a line.
- `approval-gating.ts` (229) — PURE. Owns the refusal vocabulary AND control resolution.
  Guard order (pinned by test): `AFFORDANCE_ABSENT` -> `RECORD_LIFECYCLE` -> `RECORD_VALIDITY`
  -> `REVISION_HASH` -> ENABLED. Every refusing path returns `commandId: null`, so a surface
  cannot submit a stale approval even ignoring `state`.
- `approval-inbox.tsx` (250) — §4.6/§2.6, and exports `DecisionControl`, the ONE control
  renderer all five surfaces use (nothing hand-rolls a `cr.action.*`).
- `approval-detail-plan.tsx` (246) — §4.7 **and the shared frame** (`DecisionHeader`,
  `IdleLine`, `ReasonModal`, `DecisionActions`, `abbreviateHash`). Expansion/acceptance/
  confirmation import from it one direction only — deliberate, to hold the 10-file budget
  without an 11th module and without an import cycle. §8.4 delta is a MODE of this file.

## Rulings that survived implementation (don't relitigate)

1. **Reason channel is self-checking.** The plan's list of codes "whose validSources include
   APPROVAL/CUTOVER" is WRONG for `STALE_EPOCH`/`EXPECTED_VERSION_CONFLICT`/
   `SUPERSEDED_AUTHORITY`/`REVISION_REBOUND` — their registry rows list `GRAPH_REVISION`.
   `approvalReason(code, source, phrase)` calls `lookupRuntimeError` and throws unless the code
   is ratified (unknown spellings fall back to `UNKNOWN_ERROR`, which is how invention is
   caught) and the row admits the source (empty `validSources` = unrestricted).
2. **§8.1 governs the absent-affordance leg only.** No daemon reason -> control ABSENT. The
   stale-record guards refuse a command the daemon DID return, so they carry their own reason;
   silent refusal would be the dishonest reading.
3. **Expansion routes `graph.approve` + `expansion.decline`** (both ratified); the test asserts
   `cr.action.approval-decide.approve` is ABSENT there. Kind routing is §13-D1 provisional.
4. **Confirmation takes its command kind as a PROP** — routing is unratified, so the caller
   supplies what the daemon offered instead of the module guessing.
5. **Cutover is provisional**: zero spec text, so no spec-declared component ids
   (`grep data-testid approval-detail-confirmation.tsx` = 0 hits), a visible provisional note,
   and NO idle line.
6. **POL chip**: see `mem:gotcha-pol-chip-is-not-a-truth-chip` — actor badge, outside fact
   wrappers, truth stays `DAEMON_VERIFIED`.

## Verification evidence

- 4 mutation red-checks each killed exactly the intended tests: validity guard off -> 6 red;
  hash match off -> 1 red (the mismatch test); reason-channel bypass -> the ABSENT-control test
  red; auto group forced under default-off -> the manual-default test red. All reverted;
  `grep MUTATION-PROBE` clean.
- Root gate `pnpm typecheck && pnpm test` FAILS on foreign work only:
  `packages/scheduler/src/budget/budget-settlement.test.ts` is untracked (`??`) and imports a
  `budget-settlement.ts` that does not exist — a sibling's in-flight TDD red. Zero
  `apps/control-room` references in the failure. See
  `mem:gotcha-shared-package-gate-broken-by-sibling-red-file`.

## Known limits (told to QA, not hidden)

- Double-activating an enabled control fires `onDecide` twice; the UI holds no pending lock
  because the daemon owns idempotency/expectedVersion and no supplied fact says "in flight".
- `plan.tsx`/`acceptance.tsx` branch on `control.testId.endsWith(".reject"|".decline")`; tests
  pin it, but a qualifier rename would silently reroute.
- The 'a' approvals shortcut (§11.2) belongs to the shell frame, not this surface.
