# Handoff: task-51d05520e44e4b6d9f6b6ebb7cd60612 (docs truth reconciliation)

DONE, in REVIEW. Commit `ddab7fb` `docs(epic-bd387eeb): reconcile README status, benchmark
hash, sqlite driver record`, 3 files +256/-2.

## Owned paths
- `README.md`
- `docs/plans/2026-08-09-benchmark-spec-hash-resolution.md` (new)
- `docs/plans/2026-08-09-node-sqlite-driver-decision.md` (new)

## QA must diff by base ref, not by the commit
README's BULK change is not in `ddab7fb`. The foreign whole-tree sweep `7d8d0f8`
(task-078af6f1, "Claude runtime closure pin and re-observation") captured it first, along
with `.moe/` state and `packages/core/src/expansion/expansion-planning-hold.test.ts`.
`ddab7fb` carries only the 4 lines changed afterwards in the adversarial pass. Use
`git diff 73804e0a..HEAD -- README.md`. Bytes were verified intact when swept
(`git hash-object` == `git rev-parse HEAD:README.md`). See
`mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`.

## The three resolutions
1. **README `## Current status`** now names the landed foundation measured at HEAD. The
   key correctness point: the old clause *"it has no persistence, command, approval,
   provider, lease, budget, or execution authority"* was true of the REPO when only the
   graph kernel existed. With a durable store landed it is only true SCOPED TO THE KERNEL.
   It stays on the kernel bullet. Do not "tidy" it back into a blanket disclaimer.
2. **Benchmark hash** — `AWAITING_HUMAN_RATIFICATION`, not resolvable by an agent. See
   `mem:decision-benchmark-spec-pin-is-one-directional`.
3. **node:sqlite** — `PROPOSED — AWAITING HUMAN RATIFICATION`. Design 4.1 line 136 gates
   the driver behind a blocking packaging/fault spike that was never run. Scored 1 of 5
   criteria fully met (bundled 3.53.0 >= 3.51.3 minimum). Criteria 3/4/5 UNKNOWN;
   Linux/macOS name deferred `task-e87a7353` / `task-e94b2055`.

## Measurements (2026-08-09, re-derive rather than trust)
- Node `v24.16.0`, `engines.node` `>=24.16.0 <25`, bundled SQLite `3.53.0`.
- `pnpm test:store` = 32 files / 357 tests, exit 0.
- Design SHA-256 `1D9D1EC9…83191` (equals epic rail 1 pin); benchmark `A62B9043…A589C`.
- Doctor EXISTS now (`task-1cafc7f9`, `b374edd`) but carries no SQLite field —
  `doctor-version-contract.ts` reports observed node/pnpm/platform/arch only.

## Production defect found, reported not fixed (docs-only task)
The store's minimum-version refusal is not observable as a stable reason code. Detail in
`mem:gotcha-sqlite-version-refusal-is-not-a-typed-reason-code`. Worth a narrow follow-on.

## Root gate is red, entirely foreign
`pnpm test` exit 1, attributed by path and NOT caused by this task (markdown cannot redden
vitest). `packages/runner/src/recovery-inventory/` is wholly untracked (absent at HEAD and
at merge-base `73804e0a`); `packages/scheduler/src/package-boundary.test.ts` is unmodified
but reddened by foreign uncommitted churn in its package (`frontier.ts`,
`graph-internal.ts` modified; `frontier-cursor.ts`, `graph-traversal.ts` untracked).
Failure count MOVED between two runs with no change from me (51 -> 52), which is the
signature of live foreign churn. Completed on the store leg with the red disclosed, per the
project's path-attributed-baseline rail.
