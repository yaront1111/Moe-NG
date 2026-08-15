# Handoff: Recovery continuation evidence binding — BLOCKED at step 2/6

`worker-2bc13005`, 2026-08-09. Steps 1-2 done and committed to the working tree
(NOT git-committed). Task is BLOCKED awaiting one ownership amendment.

MERGE-BASE FOR PATH ATTRIBUTION: `749eb46`.

## The block, in one line

`classifyCrash` now carries required `continuationEvidence` on every
`CrashClassification` arm. That breaks ONE fixture literal in an UNOWNED file:

```
src/platform/platform-observation.test.ts(127,7): error TS2322:
  Property 'continuationEvidence' is missing ... type 'CrashClassification'
```

Fix is one line — add
`continuationEvidence: { predecessorRelease: "UNKNOWN", safeHandoff: null },`
to the `CRASH` fixture at :127-132. Type-only; no assertion, behaviour or API
change.

**The amendment is COMPILER-VERIFIED complete, not believed complete.** Applied
that one line as a probe: `pnpm --filter @moe/runner typecheck` -> **exit 0, zero
errors**; tests 39 files / 1215 passed. Then reverted and PROVED the revert: blob
sha `7ece9d7b8bf889f2ba869c65c825b58dc6367c49` identical before and after, backup
taken OUTSIDE the repo, `git status --porcelain` empty, **and the blocking error
re-confirmed present after restore** — a clean `git status` alone would not prove
it, since a foreign whole-tree hook can commit a probe edit and leave the tree
looking clean. For a required-field migration, a clean typecheck after the
candidate edit IS the enumeration: the compiler cannot miss a consumer. There is
no second file behind this one. Owner is `task-f01ef545` (worker-4e85eff4), QA-approved DONE at 13:34 —
it landed at 13:31, AFTER the 12:47 block analysis, so the plan could not have
anticipated it. Asked `@governors` to add that path to owned paths.

**Do not "fix" this by making `continuationEvidence` optional.** That keeps the
gate green while letting a classification exist without the derived fact, which
is this task's own hole rebuilt — see
`mem:pattern-a-pinned-value-is-only-a-decision-if-another-was-representable`.

## State on disk

- Runner tests GREEN: `pnpm --filter @moe/runner test` -> 39 files / 1215 tests,
  exit 0.
- Runner typecheck: exactly ONE error, the unowned one above. Nothing else.
- Every `CrashClassification` consumer measured: `index-surface.test.ts` (owned),
  `apps/daemon/src/recovery/restart-reconciliation.ts` (owned),
  `platform/linux-facts.ts:69` (unowned, **type reference only — needs no edit**),
  `platform-observation.test.ts:127` (unowned, the only literal). One file.

## What landed (steps 1-2)

- `recovery-contract.ts`: `RECOVERY_CLASSIFICATION_NOT_RESUMABLE` appended to the
  frozen vocabulary; `RESUMABLE_RECOVERY_CLASSIFICATIONS = Object.freeze(["ABSENT"])`;
  `isRecoveryOutcomeKind` / `isResumableClassification`; `ContinuationEvidence`.
- `safe-boundary.ts`: `classification` added to both exact request shapes; a
  shared `classificationRefusal()` consulted **before** the release lattice.
- `crash-classification.ts`: `continuationEvidenceOf(records)` reads the ALREADY
  PARSED record set (`resourceFact`, `safeHandoff`); threaded onto all five arms.
- Tests: `safe-boundary.test.ts` + `index-surface.test.ts` (updated, never
  deleted or loosened, per the reopenReason's binding guard).

## Three things the next session must not lose

1. **DoD 1 "exposes" was resolved as INTERNAL exposure**, per the approved plan.
   `RESUMABLE_RECOVERY_CLASSIFICATIONS` is exported from `recovery-contract.ts`
   only. It is deliberately NOT at the package root, because
   `surface/recovery-surface.ts` holds a named allowlist and is NOT owned — the
   exact ambiguity that produced the first block. No `EXPECTED_EXPORTS` count
   change is needed.
2. **Guard ORDER is the security property**, not guard presence. QUARANTINED
   reads release ACTIVE, so a lattice-first implementation refuses under
   `RECOVERY_PREDECESSOR_ACTIVE` and a "refused?" test stays green with the
   classification gate deleted. Two tests pin the code AND `.not.toBe` the
   lattice code. Keep both; they are what kills that mutant.
3. **Line counts are over target**: `safe-boundary.ts` 265, `crash-classification.ts`
   259 (target <=250, bar 400). Judgement, not impossibility — say so plainly.
   Do not strip blank lines to hit the number.

## Running the runner suite

`vitest` needs `--root ../..`; the package script has it. Invoking vitest by hand
without it prints "No test files found" and **exits 1**, which reads like a
failure but ran nothing. See `mem:gotcha-runner-vitest-needs-root-flag`.

Remaining: steps 3-6 (daemon TDD, daemon migration, adversarial + 2 mutation
drills, gate + pathspec commit).

Related: `mem:decision-recovery-continuation-contract-needs-public-surface-test-ownership`,
`mem:convention-runner-recovery-composes-supervisor`,
`mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
