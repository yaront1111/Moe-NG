# task-36ac4b43 — scheduler over-cap source split

## STATUS 2026-08-09 14:52 — REASSIGNED MID-FLIGHT, step 2 is on disk uncommitted

worker-5981deec claimed at 14:46, did steps 1–2, and the daemon handed the task to **worker-2bc13005 at 14:50:23**. `complete_step` bounced with `claimed by worker-2bc13005`. Board handover posted as msg-b4e568cd.

**Two of the three changed paths are UNTRACKED**, so `git diff` shows a third of the work and `git checkout --` will not undo it:
```
 M packages/scheduler/src/graph-internal.ts   187 lines  sha256 57602502ab80…
?? packages/scheduler/src/graph-traversal.ts  245 lines  sha256 f6175a3d0088…
?? packages/scheduler/src/graph-traversal.js    1 line   sha256 b83cb993e2f4…
```
To discard you need `git checkout --` on the first AND `rm` on the other two. See `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.

## Step 1 grounding (fresh, reusable — don't re-measure)

- Task base SHA **7d8d0f8e7e92084d0c176354a6efe0888ec53e9a**. The description's `7183c04` is stale; its line counts still reproduce.
- `graph-internal.ts` 415 lines / 12709 bytes; `frontier.ts` 412 / 12850. LF only, no BOM. Counted with a Node `/\r\n|\n|\r/` splitter — **not** PowerShell `Measure-Object -Line`, which skips blanks (`mem:gotcha-powershell-measure-line-undercounts-blank-lines`).
- Both bridges are exact LF one-liners, `od -c` verified.

**Importer inventory — this is what freezes the facade.** Nineteen sites import `./graph-internal.js` or `./frontier.js`. Symbol demand on graph-internal: `bit, buildHardGraphIndex, compareStrings, computeGraphIdentity, deepFreeze, edgeKeysOf, findCycleCore, makeIssue, sortIssues, sortedCopy, topologicalOrder, type GraphStructureView, type HardGraphIndex`. **Three of those (`compareStrings`, `findCycleCore`, `topologicalOrder`) are moved names**, so graph-internal MUST re-export them or six consumers break. `frontier.js` is imported only for `partitionFrontier`.

**Pre-diff baseline:** scheduler typecheck exit 0; scheduler test 36 files / 675 tests, **1 failed**, exit 1. The red is foreign and must still be the only red at the end:
```
FAIL packages/scheduler/src/package-boundary.test.ts > keeps scheduler registrars behind the package-root import boundary
Error: boundary scan failed for apps\daemon\src\daemon-main.ts: Error: unterminated regular expression source token
```

## Step 2 as landed (done, verified)

Moved verbatim into `graph-traversal.ts`: `compareStrings`, `bump`, `TopoResult`, `IndexMinHeap`, `topologicalOrder`, `CycleCore`, `findCycleCore`. graph-internal 415 → 187, keeps `HardArc`/`HardGraphIndex`/`buildHardGraphIndex`/`edgeKeysOf`/`frame`/`computeGraphIdentity`/issues/freezing, imports `{ bump, compareStrings }` and re-exports the three values plus both types.

`HardGraphIndex` is **`import type`** in graph-traversal — that is what keeps the runtime edge one-way (graph-internal → graph-traversal) and avoids a cycle through the `.js` bridges.

After the move: typecheck exit 0, tests unchanged at the baseline red.

## Step 3 warning — frontier is the tight one

`frontier.ts` is 412 lines and the planned extraction lands it around **249**, with no margin. What must leave: `CURSOR_KEYS`/`HARD_EDGE_FACT_KEYS`, `isSatisfaction`, the cursor-shape reads, both count ceilings, the dense-shape check, the `hardEdgeKeys` set, and the whole HARD-edge fact loop (~164 lines). Import savings: the entire `graph-policy.js` block and three names from `runtime-shape.js`.

**The ordering constraint is the real risk.** The helper must return fatal issues (schema / null length / ceiling / density → immediate `fail`) **separately** from accumulated HARD-edge issues, because frontier.ts must keep parsing node facts and emit HARD issues before node issues into one `sortIssues` call. Collapse them and issue ordering changes while every test still passes on codes alone.

Provenance check stays FIRST in frontier.ts; the helper must never freeze, sort, register provenance, or reach the package root.

## Bridges are load-bearing

Every non-test `.ts` in `packages/scheduler/src` needs a committed sibling `.js` containing `export * from "./<name>.ts";`. Omitting it fails **only** the runtime entrypoint worker test — tsc and vitest both stay green. See `mem:gotcha-scheduler-js-shims`.


## Evidence-only QA reopen resolved (worker-d61b2685, 2026-08-09 15:14Z)
- QA independently verified the split/code and ordered no code changes. Commit `503d127` remains exact; all six owned worktree bytes match it and the task paths are clean.
- Re-ran the scheduler suite WITHOUT exclusions: scheduler typecheck exit 0; Vitest truthfully has 1 failed / 35 passed files and 1 failed / 674 passed tests. Only red is `package-boundary.test.ts:300` aborting on unchanged foreign `apps/daemon/src/daemon-main.ts` with `unterminated regular expression source token`.
- Attribution is durable in Moe task comment `comment-470194590cfa483fb5ebba0bedd16bb7`: both daemon-main.ts and package-boundary.test.ts are byte-identical from `503d127^` through HEAD; base and HEAD failing sets are the same singleton, so delta and six-file intersection are empty.
- Fresh repo typecheck red moved to foreign untracked `apps/control-room/src/app-composition.test.tsx:6:8` (missing app-composition.js); scheduler itself is green. Fresh root tests: 200 passed / 1 failed files, 3779 passed / 1 failed / 1 skipped tests, only the same attributed package-boundary red.
- Final completion evidence runs the unexcluded scheduler suite, asserts the exact expected singleton failure/cause/counts, and only then emits `ATTRIBUTED_GATE_EXIT=0`; it does not exclude or hide the red. No new commit or empty attribution commit was created.
- Moe accepted the evidence-only resubmission and moved task-36ac4b43 to REVIEW.