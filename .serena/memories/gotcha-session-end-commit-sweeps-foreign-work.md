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

## Related

`mem:pattern-verifying-type-facade-refactors`
