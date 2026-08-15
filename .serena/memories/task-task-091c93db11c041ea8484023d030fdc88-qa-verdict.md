# Slice 2 recovery-inventory adapters — QA verdict: APPROVED

Reviewed 2026-08-09 by qa-5be1a8d6. Six files under
`packages/runner/src/recovery-inventory/`: `provider-lock-inventory.{ts,js,test.ts}`
(248 / 1 / 405 lines) and `workspace-inventory.{ts,js,test.ts}` (250 / 1 / 475).
Gate re-run by me, fresh and foreground: `pnpm --filter @moe/runner typecheck &&
pnpm --filter @moe/runner test` -> exit 0, 45 files / 1403 tests (baseline 43 / 1366,
so +2 files / +37 tests — the new files demonstrably ran). No package-local red.

## Provenance trap worth remembering

Commit `8ae6a05` bears THIS task's id and contains ZERO of its files — it is a
foreign whole-tree hook commit over `apps/control-room` + `apps/daemon`. The six
owned files are tracked at HEAD inside `3eaaca1` (task-af99cf14's commit). Reading
the task-id commit alone would have read as "the worker committed nothing".
Resolve per file with `git rev-parse --verify HEAD:<path>` plus
`git status --porcelain <dir>` (empty = committed bytes == gated bytes), never by
looking for a commit named after the task. See `mem:moe-finished-task-may-have-no-commit`.

## Five QA-run mutation drills, all killed by the NAMED case

Focused run is cheap here — `pnpm --filter @moe/runner exec vitest run --root ../..
packages/runner/src/recovery-inventory` is 3 files / 93 tests in <1s, so drilling
costs nothing. Backed up originals OUTSIDE the repo, restored by `cp` and
re-verified by sha256 after each (not by `git diff` — a foreign whole-tree commit
can capture a drill mid-flight and make the diff read clean).

1. `ended: processExit.kind !== "UNOBSERVED"` -> `true` — killed the quiet-process arm.
2. provider `negativeProof` `if (!proven) return null` removed — killed both NEGATIVE_PROOF_MISSING arms.
3. workspace `sealed.length === 0 ? null` -> always digest — killed the workspace NEGATIVE_PROOF_MISSING arm.
4. workspace `complete` pinned true — killed both RESULT_TRUNCATED arms.
5. workspace deduped colliding identities (a real merge) — killed both duplicate arms.

## What made this one approvable on the first pass

- Every refusal driven end to end through `collectRecoveryInventory`, never through
  a private mapping helper, and asserted as whole-object equality on
  `{truth, code, reason, layer}` — so a swapped proof fails, not just a missing one.
- Generated-case counts are HAND-WRITTEN literals (19 provider; 15 workspace + 4
  provider in the workspace file), not derived from the array under test. That is
  the form `mem:qa-generated-table-cannot-police-its-own-generator` demands.
- The OVER_LIMIT sweep asserts `expect(locks).toHaveLength(4097)` BEFORE collecting,
  so a sweep that silently produced nothing cannot pass.
- Absent-registration proven in BOTH directions (each class omitted in turn) via
  whole-array `proofShapes` equality, so a class cannot vanish from the report.
- The architect's step-1 ruling held: `git log -1` over `recovery-inventory.ts`,
  `index.ts` and `index-surface.test.ts` still points at slice 1's `88a42e0`. Zero
  aggregate edits; registration is a factory returning a frozen `{class, enumerate}`.
  Slice 3 must land the same way.

Consumer per global rail clause 1 is named, not landed: daemon coordinator
`task-cf7fb147bd1c47698cbd65c9535370aa`. Option (a), correctly used.

Related: `mem:task-task-091c93db11c041ea8484023d030fdc88-handoff`,
`mem:qa-untracked-deliverable-passes-every-habitual-check`.
