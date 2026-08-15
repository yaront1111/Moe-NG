# QA verdict: Bound the import dependsOn graph walk — APPROVED

## What I verified (not the worker's claims — re-measured)

Gate, run twice by me from repo root, redirected to a file, `$?` read directly
(never through a pipe): `pnpm --filter @moe/import typecheck && pnpm --filter
@moe/import test` -> EXIT=0, tsc zero diagnostics, `Test Files 8 passed (8) /
Tests 110 passed (110)`.

Sizes via `grep -c ''`: `import-reconcile.ts` 196 (was 250),
`import-reconcile-graph.ts` 126. Both under the per-file 250 target.

Base-ref diff `git diff 6482e5f..HEAD -- packages/import/` = exactly 4 files,
457 insertions / 55 deletions, nothing foreign. `git status --porcelain
packages/import` empty; `git show HEAD:<path> | sha256sum` matches the working
tree on all four owned files, so the committed bytes ARE the gated bytes.

## Equivalence check I did by hand

Read the ORIGINAL recursive `graphFindings` out of the diff hunk and compared it
clause by clause against the new iterative one. All five load-bearing clauses
survive verbatim: OPEN set on entry (`openFrame`), post-order `DONE` only in the
refs-exhausted branch immediately before `pop()`, dedupe keys `${legacyId}->${ref}`
and target-only `cycle:${ref}`, per-node `[...dependsOn(...)].sort(byCodeUnit)`,
outer `[...byId.keys()].sort(byCodeUnit)` with the `!state.has()` guard.
`frame.nextIndex += 1` fires BEFORE the descend, which is what reproduces the
suspend-mid-loop interleaving. Repeated refs, self-cycles and cross-edges all
map 1:1 onto the recursive behaviour.

`noUnusedLocals` is on in tsconfig.base.json, so a green tsc also proves no dead
import was left behind by the extraction.

## My own mutation drills (backup outside repo, sha256 re-verified after each)

Pre/post sha `ef549167...d6e9` on every restore. Restore by `cp` from an
out-of-repo copy, never `git checkout`.

| drill | mutation | result |
|---|---|---|
| A | whole walk reverted to unbounded recursion | 3 named tests red, all `RangeError: Maximum call stack size exceeded`; other 20 green |
| B | `stack.push` -> `stack.unshift` | 12 red |
| C | OPEN-at-push -> DONE-at-push (early DONE) | 10 red, every one cycle-related |
| E | per-node `.sort(byCodeUnit)` dropped | 2 red |
| F | outer `.sort(byCodeUnit)` dropped | 1 red (reverse-insertion-order determinism) |

Drill A is the DoD-4 drill and it reddened for the DEPTH reason specifically,
not by breaking the environment — 20 unrelated tests stayed green.

## Rails

No `try`/`catch` and no RangeError swallow anywhere in the module. Nondeterminism
grep (`Date|Math.random|process.|hrtime|performance|localeCompare|toLocale|crypto|env`)
hits only a prose comment. `.js` bridge is `export * from "./import-reconcile-graph.ts";`
ending `0a` — exact LF, matches every sibling bridge. No CR in any owned file.
Consumer edge real: `import-reconcile.ts:7` imports `graphFindings`.

## The one judgement call

DoD 4 says "including the boundary depth". No depth BOUND was chosen (iterative
walk instead), and DoD 2 makes the bound conditional, so there is no boundary to
assert. The cardinality half of the clause IS met: `entries.length` pinned to
20_000 / 200_000 / 120, `GOLDEN.length === 13`, total expected findings === 19,
all hand-written literals. Not a defect.

See [[qa-cheap-mutation-drill-with-test-name-pattern]] and
[[git-checkout-restore-destroys-uncommitted-work]].
