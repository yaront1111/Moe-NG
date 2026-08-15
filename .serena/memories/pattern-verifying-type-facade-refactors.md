# Pattern: how to QA a "split a file behind a compatibility facade" refactor

Used on task-866713137a (planning-contract.ts -> planning-command-contract.ts +
planning-event-contract.ts, commit 3431a56). Approved. These checks are mechanical
and cheap; run them instead of reading the worker's summary.

## The five checks

1. **Public name set, four-way.** Extract `export (type|interface) <Name>` from the
   pre-split baseline (`git show <base>:<path>`), from the new leaves, from the
   facade's `export type { ... } from` blocks, and from the root barrel's block.
   Require exact **sorted-set equality**, not matching counts. Print the two
   differences (`baseline minus facade`, `facade minus baseline`) so a swap of two
   names cannot pass.

2. **Declaration bodies, not just names.** Split baseline and the union of the
   leaves into blank-line-delimited blocks, drop `import` blocks, sort, compare as a
   multiset. Byte-identical means no changed `readonly`/optional marker, property
   name or order, literal discriminant, `extends` base, union-member order, or doc
   comment anywhere in the move. This is the check that actually proves
   "shape-preserving"; a name-set check does not.

3. **Facade purity + cycle.** Facade must have zero non-`export type` lines
   (`/^export(?!\s+type)/m`) and, ideally, zero imports. Neither leaf may reference
   the facade path. Confirm the leaf-to-leaf edge is one-way.

4. **Privates stayed private.** Any base interface that was non-exported in the
   baseline must still be non-exported in its new leaf — splitting a file is the
   easiest way to accidentally widen a private base into the public surface.

5. **Portable line count.** Split on `/\r\n|\r|\n/` and subtract a trailing empty
   element. `wc -l` disagrees across LF/CRLF and on a missing final newline, which
   matters when the rail is a hard <=250.

## Mutation-test the sentinel claim

Workers on these refactors argue "the focused typecheck is a compile-time
public-export sentinel, so no new test is needed." That argument is usually correct
but must be **proven, not accepted**: delete one name from the facade, re-run
typecheck, confirm it goes red (here: 3 sites, including the root barrel,
`TS2305 ... has no exported member`), then restore and confirm green. If typecheck
stays green, the barrel is not actually re-exporting what you think and the refactor
has no regression net at all.

Restoring: `git checkout -- <single owned path>` is safe for a mutation you made to
an already-committed clean file. Do not reach for reset/stash — the epic rail forbids
them and the tree is shared with other agents.

## Related

Foreign-work sweep hazard seen on the same review: see
`mem:gotcha-session-end-commit-sweeps-foreign-work`.
