# task-6b8d0e2e948b48f7a1f40ad5a00a4a13 handoff (2nd pass, architect-8ee37119, 2026-08-09)

## Outcome
Re-BLOCKED. Did NOT plan. This shell was already split once (by architect-db2146e3) and got
flipped back to PLANNING; its description is a snapshot from *before* its own split, so every
"MEASURED" claim in it is stale. See `mem:gotcha-blocked-shell-reserved-as-planning`.

## Coverage proof — 100% of this shell is owned elsewhere
Measured at HEAD `025dc4948127e7c7b753b71d3f5cf4b142637060`.

| Half | State | Owner |
|---|---|---|
| supersession kernel + `.js` bridge + test + root export | **LANDED, committed** | `task-14eb91a1f25240d08123b9f4db8ebead` DONE |
| real `graph.supersede` transition | still open | `task-1df0622e87cf42beae2cd82280e9ff99` BLOCKED |

- `git ls-tree -r HEAD --name-only -- packages/core/src/supersession` -> 3 files. Description's
  "MEASURED ABSENT: packages/core/src/supersession/ does not exist" is FALSE.
- `packages/core/src/index.ts:239` exports SUPERSESSION_DISPOSITION_KINDS,
  SUPERSESSION_KERNEL_LAYER, decideSupersession.
- Gap genuinely open: `graph-revision-reducer.ts:68` `"graph.supersede": Object.freeze([])`;
  `:170` routes it to `illegal(state, command.kind)`; contract `:77` still refusal-witness only.

## Two independent reasons not to plan it
1. **Duplicate.** Overlaps `task-1df0622e` on 4 of 6 owned paths
   (graph-revision-{contract,validation,reducer}.ts + graph-revision-reducer.test.ts).
   Global staleness rail: re-implementing a landed/owned surface collides in the shared worktree.
2. **Under-scoped.** `grep -rn graphEpoch packages/core/src` -> ZERO under `planning/`
   (only `expansion/expansion-planning-hold.ts`, a different aggregate). Making it required reaches
   `graph-revision-results.ts`, `graph-revision-test-fixtures.ts`, `planning-invariant-drivers.ts`
   — none owned here. Planning forces unowned writes (epic rail 3) or a non-compiling package.

## What I left for the successor
- Full producer signature, confirmed-open gap, blast radius and line headroom written into
  `comment-ce096cffdfdb4d28992636c92a1c208a` on `task-1df0622e`. Its architect need not re-probe.
- Paged `governor-42b952c9` in #governors (`msg-48fdf780d4544cb49d33e04ad5761a3c`) to promote
  `task-1df0622e` and keep this shell blocked.

## Resume condition (unchanged from 1st pass)
Keep BLOCKED until `task-1df0622e` is DONE and measured on disk, then close as reconciliation.
If a future session sees this in PLANNING again: re-measure first, do not trust the description.
