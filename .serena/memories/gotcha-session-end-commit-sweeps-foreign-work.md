# Gotcha: the session-end auto-commit sweeps other agents' in-flight work

Every agent in this fleet shares one working directory (`D:/projexts/moe-next`,
epic rail 2), so the git index is shared mutable state.

Epic rail 3 was strengthened (proposal `prop-734f1da5`, evidence commit `bc8e4f5`)
to require **explicit pathspec commits** — `git commit -- <owned path> ...`, never a
bare `git commit` or `git commit -a`, with `git status --porcelain` checked before
and `git show --stat` checked after.

**That rail binds agents. It does not bind the Moe wrapper's own end-of-session
commit.** Observed on 2026-08-07 while reviewing task-866713137a:

- `3431a56` — the worker's own commit. Correct: exactly the 3 owned paths.
- `f8db0a5` — session-end auto-commit, titled
  `feat(task-866713137a...): Planning run contract decomposition`, containing **10
  foreign paths** (`packages/runner/src/providers/claude/**`,
  `tests/fault/foundation/**`) plus `.moe/` state, 1630 insertions.

Same class as `bc8e4f5`, opposite direction: there a foreign track swept this
worker's staged files; here the session-end commit swept other tracks' work under
this task's name.

## QA handling

- **Do not reject the worker for this** if their own commit is pathspec-clean.
  They have no fix inside their owned paths, and unwinding a commit that carries
  live foreign work is more dangerous than leaving it.
- **Do check for it anyway.** `git log --oneline -3` after the task's commit;
  if a later commit carries the task ID, run `git show --stat` on it.
- **Do escalate to the architect/human.** The authors of the swept files need to
  know their work is committed under another task's ID before they build on it.
- When attributing a changed shared file, check *which commit* touched it. On this
  review `packages/core/src/index.ts` looked modified since the baseline, but
  `git log --oneline <base>..HEAD -- <path>` showed it was foreign commit `afbdfa7`
  (policy approval core), not the task under review.

## Additional incident (2026-08-08)

While task-84e875f9 was repairing admission, concurrent auto-commit `baa8012` for policy task-556d87c swept three cleanly owned admission paths mid-session. The admission worker preserved history, posted the attribution in #general, and committed only the remaining invariant path as `b27de86`. This confirms that even unstaged WIP can be swept; check `git log -- <owned path>` after every Moe step, not only the index.

## Third and fourth incidents (2026-08-08, same task)

task-18c7921f (Foundation executable specification) was hit twice more, and the
second one shows the failure mode is worse than "swept at session end":

- First pass: `4e8ac7c` (Policy approval core) took all 8
  `packages/testkit/src/foundation/*` files and `f8db0a5` (Planning run contract
  decomposition) took all 4 `tests/fault/foundation/*` files. QA reviewed at the
  paths and did not charge the worker.
- Reopen pass: `4b7deb3`, titled `feat(task-7cb6ffc3...): Planning invariant test
  decomposition`, swept a snapshot of all 7 owned files **mid-edit** — including
  two brand-new untracked files (`tests/fault/foundation/tsconfig.json`,
  `foundation-gate-coverage.test.ts`) — plus 13 `.moe/` state files. Because the
  snapshot landed BETWEEN two edits, four owned files were left half-finished in
  the working tree, and `git diff --stat` on a file the worker had just edited
  came back EMPTY, which reads exactly like "my edit did not apply".

**Diagnostic:** if `git diff` on a file you just edited is empty and the content
is nonetheless correct, you were swept — check `git log --oneline -3` for a
commit titled for another task. Do not re-apply the edit.

**Handling stays the same:** never unwind the foreign commit (it carries live
foreign work), commit your remaining delta by explicit pathspec, and post the
attribution so the other task's reviewer reviews at the PATHS. Note the rail
binds agents, not the wrapper's own commit, so this recurs until the wrapper is
fixed.

## Fifth incident (2026-08-26): the sweep BROKE HEAD's compile and REVERTED the row's own approved work

Worst observed shape. task-3e3ca3b4 (fourth broker refusal layer `BROKER_STORE_LOCK`)
committed cleanly by pathspec as `53b83b1c`, was verified clean by a peer in chat,
and was QA-approved. **Then the session-end autocommit ran and produced a SECOND
commit bearing the same task id** — `66c1a3f7`, titled differently
(`... (wire vocabulary only)`), two paths, +48/-19.

That commit took `broker/src/refusal.rs` and `broker/tests/frame_sweep.rs` **from the
worktree**. Both were deliberately left dirty by mode-2 index-only staging precisely
because they carry other rows' bytes. Result:

- It committed `use crate::store_lock::StoreLockError;` and `Refused::store_lock`
  (task-b6cae247's bytes) while `store_lock.rs` is still `??` untracked and HEAD's
  `lib.rs` has **no `mod store_lock;`**. `error[E0432]: unresolved import
  crate::store_lock`, EXIT 101. **It is the LIB that fails, so every test target in
  the crate fails with it** — every runner/cargo leg in the fleet reds until fixed.
- **It reverted the row's own approved assertions.** `RefusalLayer::ALL == [.., StoreLock]`,
  `StoreLock.wire() == 4` and by-name `from_wire(4) == Some(RefusalLayer::StoreLock)`
  were present at `53b83b1c:582/589/595/599`; at HEAD only `ALL.len() == 4` survives
  (:614). The by-name form was downgraded back to the weaker `.map(wire) == Some(4)`,
  which passes even if byte 4 resolves to the wrong variant.
- It landed a THIRD row's WIP (task-913bce17 opcode-3 arms) under this task's id.

**The generalisable finding: mode 2 protects the COMMIT, not the FILE.** A row can
stage index-only flawlessly and still have its deliberately-dirty worktree swept
afterwards under its own task id. The dirt mode 2 exists to keep out is exactly what
the sweep then commits. No commit rule can reach it, because the sweeping commit is
not one a worker chose to run. Mitigation is on the *worker's last action*, not the
commit: **a row whose plan deliberately leaves shared files dirty must either restore
them to HEAD before session end, or record in its handoff that the worktree is
intentionally dirty so a sweep is expected.**

**Diagnostic:** two commits carrying the same task id, the later one with a different
title, is the signature. `git log --oneline -4` then `git show --stat <later sha>`.
Structural proof of a compile break needs no cargo run: `git show HEAD:<file> | grep
use crate::<mod>` hitting while `git show HEAD:lib.rs | grep "^mod"` misses it, and
`git ls-tree HEAD -- <mod>.rs` empty, is E0432 by construction.

### Carve-out to "never unwind the foreign commit"

The standing guidance (do not unwind; it carries live foreign work) holds while the
sweep merely misattributes. **It does not hold when the sweep breaks the build for the
whole fleet.** But the repair must dodge three traps at once — no worktree write (the
swept files' worktree copies hold peer bytes, rule: never `git checkout --` a file you
did not write), no shared-index write, and no bare `git commit` (the shared index
routinely holds a foreign staged blob; verify with `git diff --cached --numstat`
first). `git revert` and pathspec commits both write the worktree, so both are wrong
here. The shape that satisfies all three is a **detached-index forward commit**:

```
GIT_INDEX_FILE=$TMP/idx git read-tree HEAD
GIT_INDEX_FILE=$TMP/idx git update-index --cacheinfo 100644,<good blob>,<path>
TREE=$(GIT_INDEX_FILE=$TMP/idx git write-tree)
git commit-tree $TREE -p HEAD -m "revert(<task>): unbreak <what> swept by <sha>"
git update-ref HEAD <new sha>
```

Forward commit, not a history rewrite; shared index and worktree both untouched. The
swept files correctly read ` M` again afterwards, which is the pre-sweep state.
Prefer restoring only the paths the bad commit already touched — "just land the missing
module instead" looked smaller here and was not: the untracked `store_lock.rs` came
with a second untracked `session_accept.rs` and a shared `lib.rs` hunk spanning two
other rows. **Disposition is a governor/architect call; a worker should measure it,
post the recipe, and wait for authorization rather than move shared HEAD unprompted.**

### Three more facts established while the fifth incident was being repaired

**The WORKTREE compiled the whole time; only the COMMIT was broken.** `cargo check -p
moe-windows-job-broker --lib` and `cargo test --no-run` both EXIT 0 in the shared tree,
because the worktree `lib.rs` declares `mod store_lock;` and both untracked modules are
on disk. Only `git archive <sha>` materializations red. So "attribute every cargo red to
the bad commit" is TRUE for archive-at-sha and CI runs and FALSE for anything run in the
worktree — a blanket advisory would wave through real, attributable reds. Always say
which of the two a red came from.

**`git revert` is wrong here for a second, stronger reason than "it writes the worktree".**
Restoring the old `refusal.rs` blob deletes `Refused::store_lock`, and the worktree has
live callers (`session.rs:137`, `:210`) plus 8 files referencing `store_lock`/
`StoreLockError`, four of them dirty or untracked. A worktree-writing restore would
E0599 the currently-GREEN tree for the whole fleet. The general rule: on a shared
worktree the question is not *"is this file dirty"* but *"does anything on disk depend on
these bytes"*.

**"`update-index --cacheinfo` + a BARE `git commit`" still carries the original defect.**
A bare commit commits the WHOLE index, and the shared index routinely holds foreign
staged blobs. Only the DETACHED index (`GIT_INDEX_FILE=… read-tree` / `update-index` /
`write-tree` / `commit-tree` / `update-ref`) is safe under both hazards at once. Also
re-read HEAD at execution time — HEAD moves mid-thread, and parenting on the bad commit
instead of current HEAD silently drops whatever landed in between.

**The index-only repair recreates its own precondition.** After the sweep, the swept file
reads CLEAN in the worktree (the sweep committed its dirty content). Moving the commit
back while leaving the worktree alone necessarily makes it DIRTY again — correct and
intended, and also exactly the state that produced the incident. So recurrence follows
from ordinary operation, not from anyone's mistake, and "one is an incident, two is
systemic" gets crossed by doing the right thing. The only mitigation that reaches it is
on the worker's LAST ACTION, not on any commit rule.

## Related

`mem:pattern-verifying-type-facade-refactors`
`mem:gotcha-shared-index-race-defeats-pathspec-commit`
`mem:gotcha-peer-stages-files-in-the-shared-index`
`mem:convention-commit-by-pathspec-in-a-shared-index`
