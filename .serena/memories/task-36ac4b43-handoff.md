# task-36ac4b43 — Split over-cap scheduler sources (DONE 2026-08-09, commit 503d127)

Behaviour-preserving decomposition. No behaviour change, no new export, no test edited.

| file | before | after |
|---|---|---|
| graph-internal.ts | 415 | 187 |
| graph-traversal.ts | — | 245 (new) |
| frontier.ts | 412 | 249 |
| frontier-cursor.ts | — | 248 (new) |

## Seams

- `graph-traversal.ts` holds compareStrings, bump, TopoResult, IndexMinHeap,
  topologicalOrder, CycleCore, findCycleCore. `graph-internal.ts` re-exports them, so every
  existing intra-package import of `graph-internal.js` still resolves — no consumer moved.
- `frontier-cursor.ts` holds `admitFrontierCursor`: cursor schema, safe length reads, the two
  ABSOLUTE_MAX ceilings, dense-shape validation, HARD-edge fact parsing.

## The non-obvious constraint — issue ORDER

`partitionFrontier` accumulates HARD-edge issues then node issues into ONE list before a single
canonical sort. A helper that returned HARD-edge issues as a *refusal* would break that: the
caller would never see node issues alongside them. So `CursorAdmission` is discriminated:

- `ok: false` = FATAL (schema / count / density). Must stay immediate — the pre-split code
  refused here before reading any node fact, and continuing would read elements past a ceiling
  that just failed.
- `ok: true` still carries `issues` (accumulated HARD-edge problems). `frontier.ts` seeds its
  list with `[...admitted.issues]` and appends node issues after.

If you ever "simplify" that into a single refusal path, `frontier.test.ts` and
`readiness-projection.test.ts` are the tests that should catch you.

## Ceiling order is security-significant

exact cursor schema -> `readPlainArrayLength` -> ABSOLUTE_MAX ceilings -> `hasExactDenseArrayShape`
-> per-element `readOwnArrayElement`. A ceiling checked after an indexed read is not a ceiling.
Every read goes through `readOwnDataProperty` / `readOwnArrayElement`, so getters and proxy traps
are refused, never invoked.

## Type gotcha

`readOwnArrayElement` takes `unknown[]`. Routing the arrays through an `unknown`-typed result
field loses the narrowing `isPlainArray` established, giving TS2345. Fix by typing
`CursorAdmission.nodeAvailabilityFacts` as `unknown[]` — honest, since it has provably passed
`isPlainArray` plus the dense-shape check. Do NOT paper over it with `as`.

## Verifying a move with no new tests

The whole safety argument rests on the held-out suite covering the moved code — a suite green
before AND after is equally consistent with "nothing broke" and "nothing was tested". Two drills
settled it:
- invert the acyclic guard (`order.length === n` -> `<= n`) -> 4 red across corrections.test.ts,
  validate-graph.test.ts, admission-pass.test.ts.
- bypass `FRONTIER_EDGE_FACT_MISSING` -> red in frontier.test.ts AND readiness-projection.test.ts
  (the downstream consumer, which proves the refusal layer did not change).

Also proved the 6 moved graph declarations byte-contained against
`git show 3576e06:packages/scheduler/src/graph-internal.ts` — moved, not copied (absence from the
source file is the check that matters; a duplicate leaves both files compiling and green).

## Standing foreign red in this package

`packages/scheduler/src/package-boundary.test.ts` fails with
`boundary scan failed for apps\daemon\src\daemon-main.ts: unterminated regular expression source
token`. The failing test is under `packages/scheduler/src/**` but the CAUSE is a foreign committed
daemon file. Present at this task's merge-base 3576e06 and unchanged by it. Do not "fix" it here.
See `mem:gotcha-shared-worktree-foreign-red`.

`noUnusedLocals`/`noUnusedParameters` are on in `tsconfig.base.json`, so a green typecheck already
proves there are no leftover imports after an extraction — no need to grep for them.
