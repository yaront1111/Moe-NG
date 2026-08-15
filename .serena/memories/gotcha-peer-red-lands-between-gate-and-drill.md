# A peer's red can land BETWEEN your green gate and your mutation drill

**Area:** QA verification in the shared `D:/projexts/moe-next` worktree.

## What happened
QA ran the owned-package gate on task-5fa25bb3 — clean tree, exit 0, 1237 tests. Minutes
later, a type-closure drill (`remove ObservedIntervalRefs`, expect `TS2305`) produced the
expected TS2305 **plus four unexpected `TS2339: Property 'target' does not exist on type
'ExpansionBindingIssue'`** errors in `expansion-current-hold.test.ts` — a file the drill never
touched and that had not failed 90 seconds earlier.

Cause: a peer agent started a TDD RED loop inside the same package mid-session. An untracked
test file appeared and `index-surface.test.ts` gained foreign edits, in a region 300 lines away
from the one under review.

## Why it is dangerous
The obvious readings are both wrong and both expensive:
- "My drill caused a cascade" → you go hunting a nonexistent coupling between a removed type
  export and an unrelated discriminated union.
- "The package was already red, so my earlier green was fake" → you reject a clean task.

It is neither. The package was green; the tree changed underneath you.

## How to not get fooled
1. **Run the authoritative gate FIRST, and snapshot `git status --porcelain <package>` in the
   same breath.** An empty status at gate time is what licenses "committed bytes == gated
   bytes". Without that snapshot you cannot prove later, to yourself or to the board, which
   bytes your green covered.
2. **When a drill emits errors outside the drilled file, re-run `git status --porcelain` before
   theorising.** New `??` entries or new ` M` entries settle it in one command.
3. **Attribute by path, then by history.** `git log -1 --oneline -- <failing path>` returns
   nothing for an untracked file — that silence is itself the answer: the file is a peer's
   in-flight work, not part of any commit you are reviewing.
4. Do not "fix" or revert the foreign edit. Disclose it verbatim with exact error lines and
   show the intersection with the reviewed task's owned paths is empty.

## Related
`mem:gotcha-clean-package-reddened-by-foreign-uncommitted-contract` covers the static version
of this (red already present when you arrive). This memory is the *dynamic* version: the tree
went dirty during your own session, so a readout you already took is no longer reproducible.
The mitigation is the status snapshot at gate time, not the post-hoc grep.
