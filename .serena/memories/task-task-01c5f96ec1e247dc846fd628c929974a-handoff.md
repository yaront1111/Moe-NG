# task-01c5f96e cross-host evidence — COMPLETE (2026-08-16, third session)

## Outcome
All 8 steps done. Evidence PROVEN on real Linux + macOS. Handed to QA.

**Deliverable SHA: `6cd4c17`.** Proof: push run **31919185835**.
Do NOT re-derive any of this — it is measured.

## The evidence
- `host-evidence-linux`, `host-evidence-darwin`, `cross-host-aggregate` all SUCCESS.
- Both hosts `Test Files 1 passed (1)`, `Tests 2 passed (2)`, `executedCaseCount=21`.
- Receipts: linux `c994ed2c…fde155f`, darwin `15b25599…672093`.
- Aggregate: both rows PROVEN, truthClass PROVEN, `aggregateDigest bea1c412…43ecd9`,
  and `source.commitSha = 6cd4c17e8ace…` — the evidence binds itself to the commit.
- **PATH_SYMLINK PROVEN on both hosts** — the boundary Windows can never prove
  (`symlinkSync` refuses there). That was the whole point of the task.
- Artifact digests match on two independent sources (runner upload log + API).

## Two root causes, in order
1. **ANSI color** (fixed by governor as `6cd4c17`, workflow-scope `NO_COLOR=1`).
   Vitest colorizes on GitHub runners; the literal `Test Files N passed` greps
   missed lines that were present, so a leg whose tests PASSED was refused as
   "ran no test file". `6cd4c17` is +9/-0 on the workflow only — **zero deleted
   lines**, so no gate condition could have changed. That shape is the proof.
2. **The plan's own step-8 query was defective** — see
   `mem:gotcha-actions-artifact-sha-differs-on-pull-request-runs`. It selects the
   pull_request run and then demands artifacts named with the git SHA, which that
   run can never carry. False negative. Corrected gate committed at
   `tests/fault/cross-host/exact-sha-evidence-gate.mjs`, drilled 3 ways.

## Verification command (fresh, EXIT 0)
```
pnpm exec tsc -p tests/fault/tsconfig.json && \
pnpm exec vitest run --config tests/fault/vitest.config.ts \
  cross-host/effect-evidence.fault.ts cross-host/production-surfaces.fault.ts && \
node tests/fault/cross-host/exact-sha-evidence-gate.mjs 6cd4c17e8ace5f8868e5651cac1418df4be224ce
```

## Repo-wide state at completion
`pnpm typecheck` 0 · `test:fault` 0 (10 files/83 tests) · `verify:foundation` 0
(improved from baseline 1) · `verify:store` 1 · `pnpm test` 1 (3 files/4 tests,
down from baseline 4 files/17 tests) · daemon 1 (2 files, down from 9).

**Only new failing path repo-wide: `packages/store/src/recovery-anchor.test.ts`**,
from peer commit `4e0201a` (task-0c894). My commits touch packages/store zero times.
No red intersects my owned paths. `gate (ubuntu/macos)` has failed on all 10
consecutive push runs, six predating my first commit — pre-existing, verified by
history rather than accepted as "parked WIP".

## Shared-worktree hazards hit this session (all real)
- Foreign commit `ce31a98` (task-7ba898f5) **swept my untracked gate file into its
  own commit**. Bytes verified identical via `git show HEAD:<path> | diff -`.
  Per the rail: did not amend/reset/stash. Grade by base-ref diff over owned paths.
- HEAD moved TWICE mid-verification (`539338fb`, then `ce31a98`) via five foreign
  commits from four peer tasks. `git rev-parse HEAD` inside a gate command is
  therefore unreliable here — pin the SHA explicitly. `git diff 6cd4c17..HEAD`
  over the 13 evidence paths is EMPTY.
- Peers had uncommitted work in-tree throughout, so reproducing a red at an older
  commit via checkout/stash was NOT safe. Attributed by authorship + path
  disjointness instead.

## Daemon gotcha worth remembering
A worker holding a BLOCKED task cannot claim ANY other task ("Do NOT work on it").
`release_task` on a BLOCKED task is the clean escape: status stayed BLOCKED,
`blockedReason` intact, assignee cleared. `unblock_worker` is the WRONG tool — it
wipes `blockedReason` and flips the task to WORKING looking healthy.
