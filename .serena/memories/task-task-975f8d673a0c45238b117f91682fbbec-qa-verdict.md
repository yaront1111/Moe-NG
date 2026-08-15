# QA verdict: Node attempt workspace — APPROVED (2026-08-08, qa-6fd67108)

Task `task-975f8d673a0c45238b117f91682fbbec`. Worker commit `8dbe3df` (path-limited, ten owned
files only). See `mem:task-task-975f8d673a0c45238b117f91682fbbec-handoff` for the delivered shape.

## What I actually ran

- `npx vitest run src/nodes src/attempts` from `apps/control-room` -> **5 files / 52 tests passed**,
  exit 0. That is the whole owned surface (node-authority 12, node-context 10, node-evidence 10,
  attempt-detail 10, review-surface 10).
- `pnpm --filter @moe/control-room test` -> **90 passed / 7 files, 1 suite failed**, exit 1.
  `pnpm --filter @moe/control-room typecheck` -> exit 1, 8 errors.
  **Every** failure is in foreign `src/shell/j1-flow.test.tsx` (sibling RED phase) resolving
  `../board/board-j1.js`, `../doctor/doctor-j1.js`, `../evidence/evidence-j1.js`,
  `../nodes/node-inspector-j1.js`, `../approvals/approval-j1.js`. Zero owned failures.
- Line audit, CRLF-normalized: all ten owned files <= 250 (max `node-authority.tsx` 247).

## Why a red package gate was still an approve

`git ls-tree -r 8dbe3df -- apps/control-room/src` proves **no `src/shell/**` file existed at the
worker's commit**, and `git log --diff-filter=A -- src/shell/j1-flow.test.tsx` shows it arrived in
`2139fcd` — the wrapper's post-`complete_task` auto-commit, which swept the sibling's in-flight
shell work under THIS task's commit message. So the worker's claimed exit-0 gate was truthful at
run time and the current red is provably foreign and post-dates the evidence.
The general lesson: when a package gate is red at QA time, date the failing file against the
worker's commit before treating the worker's evidence as false. See
`mem:gotcha-shared-package-gate-broken-by-sibling-red-file`.

## Mutation checks I ran myself (all four reddened, all restored, hashes matched)

| mutation | result |
|---|---|
| `review-surface.tsx` `isSupplied(base) && isSupplied(head)` -> `true` | 2 failed / 8 passed |
| `node-authority.tsx` `value.trim() !== ""` -> `value !== ""` | 1 failed / 9 passed |
| `node-evidence.tsx` `EvidenceLink` resolvable -> `true` | 2 failed / 8 passed |
| `attempt-detail.tsx` transcript `lines.length === 0` -> `=== -1` | 1 failed / 9 passed |

Harness followed `mem:gotcha-mutation-testing-restore-safety`: out-of-tree `cp` backup under
`/tmp`, `split().join()` (never first-occurrence `replace`), unique long anchors, and a
`git hash-object` before/after equality check per file. Working tree returned clean.

## Rail checks that passed

- Reason codes asserted, not just outcomes: every failure-path test pins
  `data-provenance-note === TRUTH_INVALID_PROVENANCE` plus `expect(TRUTH_INVALID_PROVENANCE)
  .toContain("TRUTH_CLASS_INVALID")`, or `TRUTH_ABSENT_PROVENANCE` with `data-origin === "ABSENT"`.
- Contamination firewall is structural at both halves: `ReviewSurfaceProps` declares no
  transcript/journal/selfAssessment/handoff key (enforced by a compile-time
  `[Contaminant] extends [never]` annotation) and `ReviewSurface` destructures only named fields,
  so a hostile spread loses them. Same trick guards lease token / credential on `NodeAuthority`.
- No derivation anywhere: no hash compare, no readiness, no legal-transition table, no reviewer
  eligibility computation, no fetch/route/store/clock. Command kinds render only from the supplied
  array, and an empty array renders the daemon fact "No commands supplied by the daemon."

## Open items for whoever composes these next

- `apps/control-room/src/nodes/node-inspector-j1.tsx` is UNTRACKED foreign work sitting inside this
  task's owned path — a sibling's file, left alone.
- The five modules are unmounted presentation components over already-projected, already-classified
  facts. No live transport, route, or response DTO exists yet; do not read them as a wire contract.
