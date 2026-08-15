# Bound the import dependsOn graph walk — handoff

## What landed
`packages/import/src/import-reconcile-graph.ts` (126 lines, NEW) + LF `.js` bridge.
Holds `dependsOn` + exported `graphFindings`, moved out of `import-reconcile.ts`
(250 -> 196 lines) and rewritten from recursion to an explicit heap stack.
Tests: `import-reconcile-graph.test.ts` (329 lines, 23 tests).

Chosen fix = ITERATIVE walk, NOT a depth bound. A bound would refuse a
legitimately deep legacy import, and `IMPORT_REFUSAL_CODES` is a frozen closed
array whose length is pinned by sibling sweeps — adding a code ripples.

## The frame shape is the whole trick
`interface WalkFrame { entry, legacyId, nextIndex, refs }`. Findings are pushed
DURING the child loop, so a parent must be left on the stack with `nextIndex`
already advanced and RESUME there when the child subtree pops. A stack of plain
node ids reproduces the finding SET but not the sequence.

`state.set(id, "DONE")` runs in the refs-exhausted branch, immediately before
`pop()` — post-order. OPEN vs DONE is the only thing separating a back-edge
(CYCLE, reported) from a cross-edge (silently skipped).

## Non-obvious behaviour worth knowing
- `reconcileImport` SORTS findings before returning, and that sort is a TOTAL
  order over distinct findings, so it ERASES the walk's emission sequence. Test
  the raw order by calling `graphFindings` directly.
- The cycle dedupe key `cycle:${ref}` is keyed on the TARGET ALONE. Exactly one
  CYCLE finding per target however many nodes close back to it. Which node
  discovers it first therefore decides the emitted detail AND provenance — so
  walk order is set-affecting, not merely cosmetic.
- Pre-existing, deliberately untouched (out of scope, and changing either breaks
  the golden equivalence): the dangling key `${legacyId}->${ref}` collides for
  ids containing `->`; `dependsOn` calls `Array.isArray`, which throws on a
  revoked Proxy (unreachable — payloads come from `decodeLegacySources`).

## Evidence
`pnpm --filter @moe/import typecheck && pnpm --filter @moe/import test` -> exit 0,
8 files / 110 tests. Six mutation drills all reddened named tests: recursion
restored (3 red, RangeError), `push`->`unshift` (11 red), DONE-at-push (9 red,
all cycle cases), pair cycle key (1 red), per-node sort dropped (2 red), outer
sort dropped (1 red).

## Commit state — read before QA
`git status --porcelain packages/import` is EMPTY. Foreign whole-tree commits
swept every owned file in: `de936fe` (task-6a31a86f) carries the two production
files + bridge, `4aa29d5` (task-1fb6e871) had captured an in-progress test copy.
Committed bytes sha256-match the gated working tree on all four files. Review by
base-ref diff, not by commit:
`git diff 6482e5f..HEAD -- packages/import/src/import-reconcile{.ts,-graph.ts,-graph.js,-graph.test.ts}`
-> 4 files, 457 insertions, 55 deletions, and nothing else in packages/import.

See [[gotcha-a-sorted-public-surface-hides-the-walk-order]] and
[[gotcha-regex-metachars-silently-void-a-mutation-drill]].
